package eu.kanade.tachiyomi.ui.recents

import android.app.Activity
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.widget.ImageView
import androidx.core.content.ContextCompat
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import coil3.asImage
import coil3.dispose
import coil3.load
import eu.davidea.flexibleadapter.FlexibleAdapter
import eu.davidea.flexibleadapter.items.AbstractHeaderItem
import eu.davidea.flexibleadapter.items.IFlexible
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.MangaChapterHistory
import eu.kanade.tachiyomi.databinding.RecentMangaItemBinding
import eu.kanade.tachiyomi.ui.manga.chapter.BaseChapterHolder
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.timeSpanFromNow
import eu.kanade.tachiyomi.util.view.setCards
import epigraph.books.local.LocalBookRecentRead
import java.io.File
import kotlin.math.roundToInt
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * An EPUB or PDF the user read recently, shown among the manga and novels in Recents.
 *
 * Its [mch] is blank apart from the time it was read, so the manga-only paths (downloads,
 * history removal, selection) skip it while the presenter can order it with everything else.
 */
class RecentLocalBookItem(
    val recent: LocalBookRecentRead,
    header: AbstractHeaderItem<*>?,
) : RecentMangaItem(
    mch = MangaChapterHistory.createBlank().also { it.history.last_read = recent.lastReadAt },
    header = header,
) {

    val bookId: String get() = recent.book.bookId

    override fun getLayoutRes(): Int = R.layout.recent_local_book_item

    override fun createViewHolder(
        view: View,
        adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>,
    ): BaseChapterHolder = RecentLocalBookHolder(view, adapter as RecentMangaAdapter)

    override fun isSwipeable(): Boolean = false

    override fun isSelectable(): Boolean = false

    override fun equals(other: Any?): Boolean =
        this === other || (other is RecentLocalBookItem && other.bookId == bookId)

    override fun hashCode(): Int = bookId.hashCode()

    override fun bindingContentSignature(): Int {
        var result = getLayoutRes()
        fun include(value: Any?) {
            result = 31 * result + (value?.hashCode() ?: 0)
        }
        include((header as? RecentMangaHeaderItem)?.recentsType)
        include((header as? RecentMangaHeaderItem)?.sourceName)
        include(recent)
        return result
    }

    override fun bindViewHolder(
        adapter: FlexibleAdapter<IFlexible<RecyclerView.ViewHolder>>,
        holder: BaseChapterHolder,
        position: Int,
        payloads: MutableList<Any?>?,
    ) {
        (holder as? RecentLocalBookHolder)?.bind(this)
    }
}

/** Reuses the manga row's view tree with only what a book needs: cover, title, progress, time. */
class RecentLocalBookHolder(
    view: View,
    private val adapter: RecentMangaAdapter,
) : BaseChapterHolder(view, adapter) {

    private val binding = RecentMangaItemBinding.bind(view)

    init {
        binding.cardLayout.setOnClickListener { adapter.delegate.onCoverClick(flexibleAdapterPosition) }
        binding.downloadButton.downloadButton.isVisible = false
        binding.removeHistory.isVisible = false
        binding.showMoreChapters.isVisible = false
        binding.moreChaptersLayout.isVisible = false
        binding.progress.isVisible = false
        setCards(adapter.showOutline, binding.card, null)
    }

    fun bind(item: RecentLocalBookItem) {
        val context = itemView.context
        val book = item.recent.book
        val textColor = context.getResourceColor(android.R.attr.textColorPrimary)
        val secondaryColor = context.getResourceColor(android.R.attr.textColorSecondary)
        val title = book.displayName
        val detail = listOfNotNull(book.contentType.name, book.author?.takeIf { it.isNotBlank() })
            .joinToString(" • ")
        val (first, second) = if (adapter.showTitleFirst) title to detail else detail to title
        binding.title.text = first
        binding.subtitle.text = second
        binding.title.setTextColor(if (adapter.showTitleFirst) textColor else secondaryColor)
        binding.subtitle.setTextColor(if (adapter.showTitleFirst) secondaryColor else textColor)
        listOf(binding.title, binding.subtitle).forEach {
            it.setCompoundDrawablesRelative(null, null, null, null)
            it.translationX = 0f
        }

        val percent = (item.recent.progression * 100).roundToInt().coerceIn(0, 100)
        binding.body.isVisible = true
        binding.body.text = buildString {
            append(context.timeSpanFromNow(MR.strings.read_, item.recent.lastReadAt))
            if (percent > 0) {
                append('\n')
                append(context.getString(MR.strings.local_book_progress_percent, percent))
            }
        }
        if ((context as? Activity)?.isDestroyed != true) loadCover(binding.coverThumbnail, item)
    }

    private fun loadCover(image: ImageView, item: RecentLocalBookItem) {
        val book = item.recent.book
        image.dispose()
        image.background = ColorDrawable(itemView.context.getResourceColor(android.R.attr.colorBackground))
        val placeholder = ContextCompat.getDrawable(
            itemView.context,
            if (book.contentType.name == "PDF") R.drawable.ic_file_open_24dp else R.drawable.ic_book_open_variant_24dp,
        )?.mutate()?.apply {
            setTint(itemView.context.getResourceColor(android.R.attr.textColorSecondary))
        }
        val cover = book.coverPath?.let(::File)?.takeIf { it.isFile }
        if (cover == null) {
            image.setImageDrawable(placeholder)
            image.scaleType = ImageView.ScaleType.CENTER
            return
        }
        image.scaleType = ImageView.ScaleType.CENTER_CROP
        image.load(cover) {
            placeholder?.asImage()?.let {
                placeholder(it)
                error(it)
            }
        }
    }
}
