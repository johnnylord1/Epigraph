package epigraph.books.ui

import android.app.Activity
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.text.SpannableStringBuilder
import android.text.format.Formatter
import android.text.style.ForegroundColorSpan
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Book
import androidx.core.content.ContextCompat
import androidx.core.text.inSpans
import androidx.core.view.updatePadding
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import coil3.dispose
import coil3.load
import coil3.request.error
import coil3.request.placeholder
import epigraph.ui.moment.MomentOverlay
import epigraph.ui.moment.MomentSpec
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.EpigraphBooksControllerBinding
import eu.kanade.tachiyomi.databinding.EpigraphLocalBookItemBinding
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import eu.kanade.tachiyomi.util.system.toast
import eu.kanade.tachiyomi.util.view.appBar
import eu.kanade.tachiyomi.util.view.fullAppBarHeight
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookImportService
import epigraph.books.local.LocalBookRepository
import epigraph.books.local.ImportPreview
import epigraph.sync.core.assets.BookAssetCoordinator
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.core.component.inject
import yokai.i18n.MR
import yokai.util.lang.getString

/** Functional entry point for EPUB/PDF files kept in the app-private store. */
class LocalBooksController(bundle: Bundle? = null) :
    BaseLegacyController<EpigraphBooksControllerBinding>(bundle) {

    private val repository: LocalBookRepository by inject()
    private val importService: LocalBookImportService by inject()
    private val bookAssets: BookAssetCoordinator by inject()
    private lateinit var adapter: LocalBooksAdapter
    private var relinkBookId: String? = null

    override fun getTitle(): String? = view?.context?.getString(MR.strings.local_books_title)

    override fun createBinding(inflater: LayoutInflater): EpigraphBooksControllerBinding =
        EpigraphBooksControllerBinding.inflate(inflater)

    override fun onViewCreated(view: View) {
        super.onViewCreated(view)
        adapter = LocalBooksAdapter(
            onOpen = { book -> openBook(book) },
            onDelete = { book -> deleteBook(book) },
            onRecover = { book -> downloadOrRelink(book) },
        )
        binding.booksList.layoutManager = LinearLayoutManager(view.context)
        binding.booksList.adapter = adapter
        binding.importBook.setOnClickListener { launchImport() }

        // The activity owns an expanded app bar which is layered above controller views.
        // Reserve the same measured height used by other legacy controllers so the import
        // action is not occluded while preserving the existing Epigraph chrome.
        view.post {
            val measuredAppBar = appBar()?.height ?: 0
            binding.root.updatePadding(top = maxOf(fullAppBarHeight ?: 0, measuredAppBar))
        }

        viewScope.launch {
            repository.observeBooks().collectLatest { books ->
                adapter.submitList(books)
                if (books.isEmpty()) {
                    binding.empty.show(Icons.Outlined.Book, MR.strings.local_books_empty)
                } else {
                    binding.empty.hide()
                }
            }
        }
    }

    private fun launchImport() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/epub+zip", "application/pdf"))
        }
        startActivityForResult(intent, REQUEST_IMPORT)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (resultCode != Activity.RESULT_OK) return
        val uri = data?.data ?: return
        val context = view?.context ?: return
        val name = displayName(uri).ifBlank { context.getString(MR.strings.local_books_fallback_name) }
        if (requestCode == REQUEST_RELINK) {
            val targetId = relinkBookId ?: return
            relinkBookId = null
            prepareRelink(uri, name, targetId)
            return
        }
        if (requestCode != REQUEST_IMPORT) return
        binding.status.isVisible = true
        binding.status.text = context.getString(MR.strings.local_books_inspecting, name)
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.inspect(uri, name) }
            }.onSuccess { preview ->
                showImportConfirmation(uri, name, preview)
            }.onFailure { error ->
                binding.status.text = error.message ?: context.getString(MR.strings.local_books_import_failed)
                view?.context?.toast(error.message)
            }
        }
    }

    private fun launchRelink(book: LocalBook) {
        relinkBookId = book.bookId
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = if (book.contentType == epigraph.contract.ContentType.EPUB) {
                "application/epub+zip"
            } else {
                "application/pdf"
            }
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf(type))
        }
        startActivityForResult(intent, REQUEST_RELINK)
    }

    private fun prepareRelink(uri: Uri, name: String, targetId: String) {
        val context = activity ?: return
        binding.status.isVisible = true
        binding.status.text = context.getString(MR.strings.local_books_checking_replacement)
        viewScope.launch {
            val target = withContext(Dispatchers.IO) { repository.find(targetId) }
            if (target == null) {
                binding.status.text = context.getString(MR.strings.local_books_missing_target)
                return@launch
            }
            runCatching {
                withContext(Dispatchers.IO) {
                    importService.inspect(uri, name, expectedContentType = target.contentType)
                }
            }.onSuccess { preview ->
                if (preview.sha256 != target.sha256) {
                    binding.status.text = context.getString(MR.strings.local_books_hash_mismatch)
                    context.toast(MR.strings.local_books_choose_original)
                } else {
                    context.materialAlertDialog()
                        .setTitle(context.getString(MR.strings.local_books_relink_title))
                        .setMessage(context.getString(MR.strings.local_books_relink_message, target.displayName))
                        .setNegativeButton(android.R.string.cancel) { _, _ -> binding.status.isVisible = false }
                        .setPositiveButton(context.getString(MR.strings.local_books_relink)) { _, _ ->
                            relinkBook(uri, target)
                        }
                        .show()
                }
            }.onFailure { error ->
                binding.status.text = error.message ?: context.getString(MR.strings.local_books_inspect_failed)
                view?.context?.toast(error.message)
            }
        }
    }

    private fun relinkBook(uri: Uri, target: LocalBook) {
        val context = view?.context ?: return
        binding.status.isVisible = true
        binding.status.text = context.getString(MR.strings.local_books_relinking, target.displayName)
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.relink(uri, target) }
            }.onSuccess { book ->
                binding.status.text = context.getString(MR.strings.local_books_relinked, book.displayName)
            }.onFailure { error ->
                binding.status.text = error.message ?: context.getString(MR.strings.local_books_relink_failed)
                view?.context?.toast(error.message)
            }
        }
    }

    private fun showImportConfirmation(uri: Uri, name: String, preview: ImportPreview) {
        val context = activity ?: return
        val message = buildString {
            appendLine(preview.contentType.name)
            val title = preview.title?.takeIf(String::isNotBlank) ?: preview.displayName
            appendLine("${context.getString(MR.strings.title)}: $title")
            preview.author?.takeIf(String::isNotBlank)?.let {
                appendLine("${context.getString(MR.strings.author)}: $it")
            }
            val size = Formatter.formatShortFileSize(context, preview.byteSize)
            appendLine("${context.getString(MR.strings.local_books_size)}: $size")
            append("SHA-256: ${preview.sha256}")
            if (preview.alreadyImported) {
                append("\n\n")
                append(context.getString(MR.strings.local_books_duplicate_note))
            }
        }
        context.materialAlertDialog()
            .setTitle(context.getString(MR.strings.local_books_import_title))
            .setMessage(message)
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                binding.status.isVisible = false
            }
            .setPositiveButton(context.getString(MR.strings.local_books_import)) { _, _ -> importBook(uri, name) }
            .setOnCancelListener { binding.status.isVisible = false }
            .show()
    }

    private fun importBook(uri: Uri, name: String) {
        val context = view?.context ?: return
        binding.status.isVisible = true
        binding.status.text = context.getString(MR.strings.local_books_importing, name)
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.import(uri, name).also { importService.fileInDefaultCategory(it) } }
            }.onSuccess { book ->
                binding.status.text = context.getString(MR.strings.local_books_imported, book.displayName)
                // DESIGN.md §9: "import done" is this flow's one memorable moment.
                activity?.let {
                    MomentOverlay.show(
                        it,
                        MomentSpec(
                            icon = R.drawable.ic_book_open_variant_24dp,
                            title = it.getString(MR.strings.moment_import_done),
                            detail = book.displayName,
                        ),
                    )
                }
            }.onFailure { error ->
                binding.status.text = error.message ?: context.getString(MR.strings.local_books_import_failed)
                view?.context?.toast(error.message)
            }
        }
    }

    private fun displayName(uri: Uri): String = runCatching {
        activity?.contentResolver?.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use(Cursor::readDisplayName)
    }.getOrNull().orEmpty()

    private fun openBook(book: LocalBook) {
        router.pushController(LocalBookDetailsController(book.bookId).withFadeTransaction())
    }

    private fun downloadOrRelink(book: LocalBook) {
        val context = view?.context ?: return
        binding.status.isVisible = true
        binding.status.text = context.getString(MR.strings.local_books_downloading, book.displayName)
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { bookAssets.ensurePublicationAvailable(book.bookId) }
            }.onSuccess {
                binding.status.text = context.getString(MR.strings.local_books_downloaded, book.displayName)
                repository.find(book.bookId)?.let(::openBook)
            }.onFailure { error ->
                binding.status.text = error.message ?: context.getString(MR.strings.local_books_download_failed)
                val activity = activity ?: return@onFailure
                activity.materialAlertDialog()
                    .setTitle(activity.getString(MR.strings.local_books_unavailable_title))
                    .setMessage(activity.getString(MR.strings.local_books_unavailable_message))
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton(activity.getString(MR.strings.local_books_relink)) { _, _ -> launchRelink(book) }
                    .show()
            }
        }
    }

    private fun deleteBook(book: LocalBook) {
        val context = activity ?: return
        // Removing also deletes the private copy of the file, which cannot be undone.
        context.materialAlertDialog()
            .setTitle(context.getString(MR.strings.local_books_remove_title))
            .setMessage(context.getString(MR.strings.local_books_remove_message, book.displayName))
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(context.getString(MR.strings.remove)) { _, _ -> removeBook(book) }
            .show()
    }

    private fun removeBook(book: LocalBook) {
        viewScope.launch {
            runCatching { repository.remove(book.bookId, removeFile = true) }
                .onFailure { error -> view?.context?.toast(error.message) }
        }
    }

    private companion object {
        const val REQUEST_IMPORT = 0xAEB0
        const val REQUEST_RELINK = 0xAEB1
    }
}

private fun Cursor.readDisplayName(): String? =
    if (moveToFirst()) getString(getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME)) else null

/** DESIGN.md §10 "Item de lista": cover, title, meta; recover and remove as 48dp icon actions. */
private class LocalBooksAdapter(
    private val onOpen: (LocalBook) -> Unit,
    private val onDelete: (LocalBook) -> Unit,
    private val onRecover: (LocalBook) -> Unit,
) : ListAdapter<LocalBook, LocalBooksAdapter.BookHolder>(DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): BookHolder =
        BookHolder(EpigraphLocalBookItemBinding.inflate(LayoutInflater.from(parent.context), parent, false))

    override fun onBindViewHolder(holder: BookHolder, position: Int) {
        holder.bind(getItem(position))
    }

    override fun onViewRecycled(holder: BookHolder) {
        holder.binding.cover.dispose()
    }

    inner class BookHolder(val binding: EpigraphLocalBookItemBinding) : RecyclerView.ViewHolder(binding.root) {
        fun bind(book: LocalBook) = with(binding) {
            val context = root.context
            title.text = book.displayName
            meta.text = SpannableStringBuilder().apply {
                book.author?.takeIf(String::isNotBlank)?.let { append(it).append(" · ") }
                append(book.contentType.name)
                append(" · ")
                append(Formatter.formatShortFileSize(context, book.byteSize))
                if (book.downloadsWhenOpened) {
                    append(" · ")
                    append(context.getString(MR.strings.local_books_downloads_when_opened))
                } else if (!book.isAvailable) {
                    append(" · ")
                    inSpans(ForegroundColorSpan(context.getResourceColor(androidx.appcompat.R.attr.colorError))) {
                        append(context.getString(MR.strings.local_books_file_missing))
                    }
                }
            }
            // The PDF glyph ships tinted black; both take the secondary text color on any theme.
            val placeholder = ContextCompat.getDrawable(
                context,
                if (book.contentType.name == "PDF") R.drawable.ic_file_open_24dp else R.drawable.ic_book_open_variant_24dp,
            )?.mutate()?.apply { setTint(context.getResourceColor(android.R.attr.textColorSecondary)) }
            val coverFile = book.coverPath?.let(::File)?.takeIf(File::isFile)
            cover.dispose()
            if (coverFile != null) {
                cover.scaleType = ImageView.ScaleType.CENTER_CROP
                cover.load(coverFile) {
                    placeholder(placeholder)
                    error(placeholder)
                }
            } else {
                cover.scaleType = ImageView.ScaleType.CENTER_INSIDE
                cover.setImageDrawable(placeholder)
            }
            root.setOnClickListener { if (book.isAvailable) onOpen(book) else onRecover(book) }
            recover.isVisible = !book.isAvailable && !book.downloadsWhenOpened
            recover.setOnClickListener { onRecover(book) }
            remove.setOnClickListener { onDelete(book) }
        }
    }

    private companion object {
        val DIFF = object : DiffUtil.ItemCallback<LocalBook>() {
            override fun areItemsTheSame(oldItem: LocalBook, newItem: LocalBook): Boolean =
                oldItem.bookId == newItem.bookId

            override fun areContentsTheSame(oldItem: LocalBook, newItem: LocalBook): Boolean =
                oldItem == newItem
        }
    }
}
