package eu.kanade.tachiyomi.ui.library

import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.recyclerview.widget.RecyclerView
import coil3.asImage
import coil3.dispose
import coil3.load
import eu.davidea.flexibleadapter.FlexibleAdapter
import eu.davidea.flexibleadapter.items.IFlexible
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.MangaGridItemBinding
import eu.kanade.tachiyomi.databinding.MangaListItemBinding
import eu.kanade.tachiyomi.util.lang.highlightText
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.view.backgroundColor
import eu.kanade.tachiyomi.util.view.setCards
import eu.kanade.tachiyomi.widget.AutofitRecyclerView
import epigraph.books.local.LocalBook
import java.io.File

/**
 * Local EPUB/PDF entry in the canonical Comics library pipeline.
 *
 * Books intentionally remain a different domain object from [LibraryMangaItem], but they use
 * the same LibraryItem lifecycle, filtering, selection callbacks, grid/list resources and holder
 * ownership. This keeps the library architecture shared without manufacturing manga rows for a
 * local file.
 */
class LibraryBookItem(
    val book: LocalBook,
    header: LibraryHeaderItem,
    context: android.content.Context?,
) : LibraryItem(header, context) {

    override fun getLayoutRes(): Int = if (libraryLayout == LAYOUT_LIST) {
        R.layout.book_library_list_item
    } else {
        R.layout.book_library_grid_item
    }

    override fun createViewHolder(
        view: View,
        adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>,
    ): LibraryHolder {
        val libraryAdapter = adapter as LibraryCategoryAdapter
        if (libraryLayout == LAYOUT_LIST || libraryAdapter.recyclerView !is AutofitRecyclerView) {
            return LibraryBookListHolder(view, libraryAdapter)
        }

        val parent = libraryAdapter.recyclerView as AutofitRecyclerView
        val fixedSize = uniformSize
        view.apply {
            val binding = MangaGridItemBinding.bind(this)
            val isStaggered = parent.layoutManager is androidx.recyclerview.widget.StaggeredGridLayoutManager
            binding.behindTitle.isVisible = libraryLayout == LAYOUT_COVER_ONLY_GRID
            if (libraryLayout >= LAYOUT_COMFORTABLE_GRID) {
                binding.textLayout.isVisible = libraryLayout == LAYOUT_COMFORTABLE_GRID
                binding.card.setCardForegroundColor(
                    ContextCompat.getColorStateList(
                        context,
                        R.color.library_comfortable_grid_foreground,
                    ),
                )
            }
            if (fixedSize) {
                binding.constraintLayout.layoutParams = FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.WRAP_CONTENT,
                )
                binding.coverThumbnail.maxHeight = Int.MAX_VALUE
                binding.coverThumbnail.minimumHeight = 0
                binding.constraintLayout.minHeight = 0
                binding.coverThumbnail.scaleType = ImageView.ScaleType.CENTER_CROP
                binding.coverThumbnail.adjustViewBounds = false
                binding.coverThumbnail.updateLayoutParams<ConstraintLayout.LayoutParams> {
                    height = ConstraintLayout.LayoutParams.MATCH_CONSTRAINT
                    dimensionRatio = "2:3"
                }
            }
            if (libraryLayout != LAYOUT_COMFORTABLE_GRID) {
                binding.card.updateLayoutParams<ConstraintLayout.LayoutParams> {
                    bottomMargin = (if (isStaggered) 2 else 6).dpToPx
                }
            }
            binding.setBGAndFG(libraryLayout)
        }
        return LibraryBookGridHolder(view, libraryAdapter, libraryLayout == LAYOUT_COMPACT_GRID, fixedSize)
    }

    override fun filter(constraint: String): Boolean {
        filter = constraint
        if (constraint.isBlank()) return true
        return book.displayName.contains(constraint, ignoreCase = true) ||
            book.author.orEmpty().contains(constraint, ignoreCase = true) ||
            book.contentType.name.contains(constraint, ignoreCase = true)
    }

    override fun equals(other: Any?): Boolean = other is LibraryBookItem &&
        book.bookId == other.book.bookId && sectionHeader == other.sectionHeader

    override fun hashCode(): Int = 31 * book.bookId.hashCode() + sectionHeader.hashCode()
}

private abstract class LibraryBookHolder(
    view: View,
    adapter: LibraryCategoryAdapter,
) : LibraryHolder(view, adapter) {

    protected fun titleFor(book: LocalBook): String = book.displayName

    protected fun subtitleFor(book: LocalBook): String = buildString {
        append(book.contentType.name)
        book.author?.trim()?.takeIf { it.isNotBlank() }?.let {
            append(" • ")
            append(it)
        }
        if (!book.isAvailable) append(" • File missing")
    }

    protected fun placeholderFor(book: LocalBook): Int =
        if (book.contentType.name == "PDF") R.drawable.ic_file_open_24dp
        else R.drawable.ic_book_open_variant_24dp

    protected fun loadCover(image: ImageView, book: LocalBook) {
        image.dispose()
        image.background = ColorDrawable(
            itemView.context.getResourceColor(android.R.attr.colorBackground),
        )
        val cover = book.coverPath?.let(::File)?.takeIf { it.isFile }
        if (cover == null) {
            image.setImageResource(placeholderFor(book))
            image.scaleType = ImageView.ScaleType.CENTER
            return
        }
        image.scaleType = ImageView.ScaleType.CENTER_CROP
        image.load(cover) {
            ContextCompat.getDrawable(itemView.context, placeholderFor(book))?.asImage()?.let {
                placeholder(it)
                error(it)
            }
        }
    }
}

private class LibraryBookGridHolder(
    view: View,
    adapter: LibraryCategoryAdapter,
    private val compact: Boolean,
    private val fixedSize: Boolean,
) : LibraryBookHolder(view, adapter) {

    private val binding = MangaGridItemBinding.bind(view)
    private var titleLayoutTask: Runnable? = null
    private var boundSignature: Int? = null
    private var appliedOutline = adapter.showOutline

    init {
        if (compact) {
            binding.textLayout.isVisible = false
        } else {
            binding.compactTitle.isVisible = false
            binding.gradient.isVisible = false
            listOf(binding.playLayout, binding.playButton).forEach {
                it.updateLayoutParams<FrameLayout.LayoutParams> {
                    gravity = Gravity.BOTTOM or Gravity.END
                }
            }
        }
        binding.playLayout.isVisible = false
        binding.progress.isVisible = false
        binding.playLayout.setOnClickListener {
            adapter.libraryListener?.startReading(flexibleAdapterPosition, binding.playButton)
        }
        binding.playLayout.setOnLongClickListener { itemView.performLongClick() }
    }

    override fun onSetValues(item: LibraryItem) {
        if (item !is LibraryBookItem) error("Only LibraryBookItem can use the book grid holder")
        val signature = item.bindingContentSignature()
        if (signature == boundSignature && appliedOutline == adapter.showOutline) return
        boundSignature = signature
        if (appliedOutline != adapter.showOutline) {
            appliedOutline = adapter.showOutline
            setCards(appliedOutline, binding.card, binding.unreadDownloadBadge.root)
        }

        val book = item.book
        binding.constraintLayout.isVisible = true
        binding.title.text = book.displayName.highlightText(item.filter, color)
        binding.subtitle.text = subtitleFor(book).highlightText(item.filter, color)
        binding.compactTitle.text = "${book.contentType.name} • ${book.displayName}".highlightText(item.filter, color)
        binding.behindTitle.text = book.displayName
        binding.behindTitle.setTextColor(itemView.context.getResourceColor(com.google.android.material.R.attr.colorOnBackground))
        binding.coverConstraint.backgroundColor = itemView.context.getResourceColor(android.R.attr.colorBackground)
        binding.title.maxLines = 2
        titleLayoutTask?.let(binding.title::removeCallbacks)
        val layoutTask = Runnable {
            binding.subtitle.isVisible = subtitleFor(book).isNotBlank() &&
                (binding.title.lineCount <= 1 || book.author.orEmpty().contains(item.filter, true))
            binding.title.maxLines = 2
        }
        titleLayoutTask = layoutTask
        binding.title.post(layoutTask)
        loadCover(binding.coverThumbnail, book)
        binding.unreadDownloadBadge.badgeView.setLabel(book.contentType.name)
        binding.playLayout.isVisible = !item.hideReadingButton
        setSelected(adapter.isSelected(flexibleAdapterPosition))
    }

    private fun setSelected(selected: Boolean) {
        binding.card.strokeWidth = when {
            selected -> 3.dpToPx
            appliedOutline -> 1.dpToPx
            else -> 0
        }
        arrayOf(binding.card, binding.unreadDownloadBadge.root, binding.title, binding.subtitle).forEach {
            it.isSelected = selected
        }
    }

    override fun toggleActivation() {
        super.toggleActivation()
        setSelected(adapter.isSelected(flexibleAdapterPosition))
    }

    override fun recycle() {
        titleLayoutTask?.let(binding.title::removeCallbacks)
        titleLayoutTask = null
        binding.coverThumbnail.dispose()
        boundSignature = null
    }

    override fun onActionStateChanged(position: Int, actionState: Int) {
        super.onActionStateChanged(position, actionState)
        if (actionState == 2) {
            binding.card.isDragged = true
            binding.unreadDownloadBadge.badgeView.isDragged = true
        }
    }

    override fun onItemReleased(position: Int) {
        super.onItemReleased(position)
        binding.card.isDragged = false
        binding.unreadDownloadBadge.badgeView.isDragged = false
    }
}

private class LibraryBookListHolder(
    view: View,
    adapter: LibraryCategoryAdapter,
) : LibraryBookHolder(view, adapter) {

    private val binding = MangaListItemBinding.bind(view)
    private var boundSignature: Int? = null
    private var appliedOutline = adapter.showOutline


    override fun onSetValues(item: LibraryItem) {
        if (item !is LibraryBookItem) error("Only LibraryBookItem can use the book list holder")
        val signature = item.bindingContentSignature()
        if (signature == boundSignature && appliedOutline == adapter.showOutline) return
        boundSignature = signature
        if (appliedOutline != adapter.showOutline) {
            appliedOutline = adapter.showOutline
            setCards(appliedOutline, binding.card, binding.unreadDownloadBadge.root)
        }
        val book = item.book
        binding.title.isVisible = true
        binding.title.text = book.displayName.highlightText(item.filter, color)
        binding.subtitle.text = subtitleFor(book).highlightText(item.filter, color)
        binding.subtitle.isVisible = true
        binding.card.isVisible = true
        binding.padding.isVisible = true
        binding.coverThumbnail.background = ColorDrawable(
            itemView.context.getResourceColor(android.R.attr.colorBackground),
        )
        loadCover(binding.coverThumbnail, book)
        binding.unreadDownloadBadge.badgeView.setLabel(book.contentType.name)
    }

    override fun recycle() {
        binding.coverThumbnail.dispose()
        boundSignature = null
    }

    override fun onActionStateChanged(position: Int, actionState: Int) {
        super.onActionStateChanged(position, actionState)
        if (actionState == 2) binding.card.isDragged = true
    }

    override fun onItemReleased(position: Int) {
        super.onItemReleased(position)
        binding.card.isDragged = false
    }
}
