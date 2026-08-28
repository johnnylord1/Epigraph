package epigraph.books.ui

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.database.Cursor
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.updatePadding
import androidx.core.view.isVisible
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import com.google.android.material.button.MaterialButton
import eu.kanade.tachiyomi.databinding.EpigraphBooksControllerBinding
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.util.system.toast
import eu.kanade.tachiyomi.util.view.appBar
import eu.kanade.tachiyomi.util.view.fullAppBarHeight
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookImportService
import epigraph.books.local.LocalBookRepository
import epigraph.books.local.ImportPreview
import epigraph.sync.core.assets.BookAssetCoordinator
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.core.component.inject

/** Functional entry point for EPUB/PDF files kept in the app-private store. */
class LocalBooksController(bundle: Bundle? = null) :
    BaseLegacyController<EpigraphBooksControllerBinding>(bundle) {

    private val repository: LocalBookRepository by inject()
    private val importService: LocalBookImportService by inject()
    private val bookAssets: BookAssetCoordinator by inject()
    private lateinit var adapter: LocalBooksAdapter
    private var relinkBookId: String? = null

    override fun getTitle(): String = "Books"

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
        // action is not occluded while preserving the existing Hayai chrome.
        view.post {
            val measuredAppBar = appBar()?.height ?: 0
            binding.root.updatePadding(top = maxOf(fullAppBarHeight ?: 0, measuredAppBar))
        }

        viewScope.launch {
            repository.observeBooks().collectLatest { books ->
                adapter.submitList(books)
                binding.empty.isVisible = books.isEmpty()
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
        val name = displayName(uri).ifBlank { "Imported book" }
        if (requestCode == REQUEST_RELINK) {
            val targetId = relinkBookId ?: return
            relinkBookId = null
            prepareRelink(uri, name, targetId)
            return
        }
        if (requestCode != REQUEST_IMPORT) return
        binding.status.isVisible = true
        binding.status.text = "Inspecting $name…"
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.inspect(uri, name) }
            }.onSuccess { preview ->
                showImportConfirmation(uri, name, preview)
            }.onFailure { error ->
                binding.status.text = error.message ?: "The book could not be imported"
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
        binding.status.text = "Checking replacement file…"
        viewScope.launch {
            val target = withContext(Dispatchers.IO) { repository.find(targetId) }
            if (target == null) {
                binding.status.text = "The missing book is no longer in the library"
                return@launch
            }
            runCatching {
                withContext(Dispatchers.IO) {
                    importService.inspect(uri, name, expectedContentType = target.contentType)
                }
            }.onSuccess { preview ->
                if (preview.sha256 != target.sha256) {
                    binding.status.text = "The selected file has a different SHA-256"
                    view?.context?.toast("Choose the original file for this book")
                } else {
                    AlertDialog.Builder(context)
                        .setTitle("Relink book")
                        .setMessage("The file matches ${target.displayName}. Copy it into private storage?")
                        .setNegativeButton(android.R.string.cancel) { _, _ -> binding.status.isVisible = false }
                        .setPositiveButton("Relink") { _, _ -> relinkBook(uri, target) }
                        .show()
                }
            }.onFailure { error ->
                binding.status.text = error.message ?: "The replacement file could not be inspected"
                view?.context?.toast(error.message)
            }
        }
    }

    private fun relinkBook(uri: Uri, target: LocalBook) {
        binding.status.isVisible = true
        binding.status.text = "Relinking ${target.displayName}…"
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.relink(uri, target) }
            }.onSuccess { book ->
                binding.status.text = "Relinked ${book.displayName}"
            }.onFailure { error ->
                binding.status.text = error.message ?: "The book could not be relinked"
                view?.context?.toast(error.message)
            }
        }
    }

    private fun showImportConfirmation(uri: Uri, name: String, preview: ImportPreview) {
        val context = activity ?: return
        val duplicateNote = if (preview.alreadyImported) {
            "\nThis file is already in the library; importing it again will reuse the existing copy."
        } else {
            ""
        }
        AlertDialog.Builder(context)
            .setTitle("Import book")
            .setMessage(
                "${preview.contentType.name}\n" +
                    "Title: ${preview.title?.takeIf(String::isNotBlank) ?: preview.displayName}\n" +
                    preview.author?.takeIf(String::isNotBlank)?.let { "Author: $it\n" }.orEmpty() +
                    "Size: ${preview.byteSize} bytes\n" +
                    "SHA-256: ${preview.sha256}$duplicateNote",
            )
            .setNegativeButton(android.R.string.cancel) { _, _ ->
                binding.status.isVisible = false
            }
            .setPositiveButton("Import") { _, _ -> importBook(uri, name) }
            .setOnCancelListener { binding.status.isVisible = false }
            .show()
    }

    private fun importBook(uri: Uri, name: String) {
        binding.status.isVisible = true
        binding.status.text = "Importing $name…"
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { importService.import(uri, name) }
            }.onSuccess { book ->
                binding.status.text = "Imported ${book.displayName}"
            }.onFailure { error ->
                binding.status.text = error.message ?: "The book could not be imported"
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
        binding.status.isVisible = true
        binding.status.text = "Downloading ${book.displayName}..."
        viewScope.launch {
            runCatching {
                withContext(Dispatchers.IO) { bookAssets.ensurePublicationAvailable(book.bookId) }
            }.onSuccess {
                binding.status.text = "Downloaded ${book.displayName}"
                repository.find(book.bookId)?.let(::openBook)
            }.onFailure { error ->
                binding.status.text = error.message ?: "The book could not be downloaded"
                val context = activity ?: return@onFailure
                AlertDialog.Builder(context)
                    .setTitle("Book file unavailable")
                    .setMessage("The synchronized copy could not be downloaded. You can choose the original file instead.")
                    .setNegativeButton(android.R.string.cancel, null)
                    .setPositiveButton("Relink") { _, _ -> launchRelink(book) }
                    .show()
            }
        }
    }

    private fun deleteBook(book: LocalBook) {
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

private class LocalBooksAdapter(
    private val onOpen: (LocalBook) -> Unit,
    private val onDelete: (LocalBook) -> Unit,
    private val onRecover: (LocalBook) -> Unit,
) : ListAdapter<LocalBook, LocalBooksAdapter.BookHolder>(DIFF) {

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): BookHolder {
        val context = parent.context
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(8, 12, 8, 12)
            isClickable = true
            isFocusable = true
        }
        val title = TextView(context).apply { textSize = 16f }
        val subtitle = TextView(context).apply { textSize = 13f }
        val delete = MaterialButton(context).apply {
            text = "Remove"
            minHeight = 0
            minimumHeight = 0
        }
        val relink = MaterialButton(context).apply {
            text = "Download"
            minHeight = 0
            minimumHeight = 0
        }
        val actions = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            addView(relink, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ))
            addView(delete, LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
            ))
        }
        row.addView(title, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        row.addView(subtitle, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        row.addView(actions, LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        ))
        return BookHolder(row, title, subtitle, relink, delete)
    }

    override fun onBindViewHolder(holder: BookHolder, position: Int) {
        holder.bind(getItem(position))
    }

    inner class BookHolder(
        view: View,
        private val title: TextView,
        private val subtitle: TextView,
        private val relink: MaterialButton,
        private val delete: MaterialButton,
    ) : RecyclerView.ViewHolder(view) {
        fun bind(book: LocalBook) {
            title.text = book.displayName
            subtitle.text = "${book.contentType.name} · ${formatBytes(book.byteSize)}"
            if (!book.isAvailable) subtitle.append(" - File missing")
            itemView.setOnClickListener { if (book.isAvailable) onOpen(book) else onRecover(book) }
            relink.isVisible = !book.isAvailable
            relink.setOnClickListener { onRecover(book) }
            delete.setOnClickListener { onDelete(book) }
        }
    }

    private fun formatBytes(bytes: Long): String = when {
        bytes < 1024L -> "$bytes B"
        bytes < 1024L * 1024L -> "%.1f KiB".format(bytes / 1024.0)
        else -> "%.1f MiB".format(bytes / (1024.0 * 1024.0))
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
