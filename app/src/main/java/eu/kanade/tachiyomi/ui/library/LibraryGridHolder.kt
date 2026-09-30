package eu.kanade.tachiyomi.ui.library

import android.app.Activity
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.constraintlayout.widget.ConstraintLayout
import androidx.core.view.isVisible
import androidx.core.view.marginBottom
import androidx.core.view.marginStart
import androidx.core.view.marginTop
import androidx.core.view.updateLayoutParams
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import coil3.dispose
import coil3.size.Scale
import com.google.android.material.R as materialR
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.dominantCoverColors
import eu.kanade.tachiyomi.data.database.models.isNovel
import eu.kanade.tachiyomi.databinding.MangaGridItemBinding
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.util.lang.highlightText
import eu.kanade.tachiyomi.util.manga.MangaCoverMetadata
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.view.backgroundColor
import eu.kanade.tachiyomi.util.view.setCards
import eu.kanade.tachiyomi.widget.AutofitRecyclerView
import yokai.i18n.MR
import yokai.presentation.theme.Motion
import yokai.presentation.theme.ReducedMotion
import yokai.util.coil.loadManga
import yokai.util.lang.getString

/**
 * Class used to hold the displayed data of a manga in the library, like the cover or the title.
 * All the elements from the layout file "item_catalogue_grid" are available in this class.
 *
 * @param view the inflated view for this holder.
 * @param adapter the adapter handling this holder.
 * @constructor creates a new library holder.
 */
class LibraryGridHolder(
    private val view: View,
    adapter: LibraryCategoryAdapter,
    compact: Boolean,
    val fixedSize: Boolean,
) : LibraryHolder(view, adapter) {

    private val binding = MangaGridItemBinding.bind(view)

    // Selecting a cover settles it slightly inward on `spring-snappy` (DESIGN.md §10 "Capa em grade").
    private val selectScaleX = SpringAnimation(binding.card, DynamicAnimation.SCALE_X).apply {
        spring = Motion.Spring.Snappy.force(1f)
    }
    private val selectScaleY = SpringAnimation(binding.card, DynamicAnimation.SCALE_Y).apply {
        spring = Motion.Spring.Snappy.force(1f)
    }
    private var titleLayoutTask: Runnable? = null
    private var boundSignature: Int? = null
    private var boundCover: CoverContent? = null
    private var appliedOutline = adapter.showOutline
    private var appliedRatioLayout: RatioLayout? = null

    private data class CoverContent(
        val mangaId: Long?,
        val sourceId: Long,
        val url: String?,
        val lastModified: Long,
        val inLibrary: Boolean,
    )

    private data class RatioLayout(val ratio: Float?, val itemWidth: Int)
    init {
        binding.playLayout.setOnClickListener { playButtonClicked() }
        binding.playLayout.setOnLongClickListener { itemView.performLongClick() }
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
    }

    /**
     * Method called from [LibraryCategoryAdapter.onBindViewHolder]. It updates the data for this
     * holder with the given manga.
     *
     * @param item the manga item to bind.
     */
    override fun onSetValues(item: LibraryItem) {
        if (item !is LibraryMangaItem) throw IllegalStateException("Only LibraryMangaItem can use grid holder")
        binding.playButton.transitionName = "library chapter $bindingAdapterPosition transition"
        val signature = item.bindingContentSignature()
        if (signature == boundSignature && appliedOutline == adapter.showOutline) return
        boundSignature = signature

        // Update the title and subtitle of the manga.
        if (appliedOutline != adapter.showOutline) {
            appliedOutline = adapter.showOutline
            setCards(appliedOutline, binding.card, binding.unreadDownloadBadge.root)
        }
        binding.constraintLayout.isVisible = item.manga.manga.id != Long.MIN_VALUE
        binding.title.text = item.manga.manga.title.highlightText(item.filter, color)
        binding.behindTitle.text = item.manga.manga.title
        val mangaColor = item.manga.manga.dominantCoverColors
        binding.coverConstraint.backgroundColor = mangaColor?.first ?: itemView.context.getResourceColor(android.R.attr.colorBackground)
        binding.behindTitle.setTextColor(
            mangaColor?.second ?: itemView.context.getResourceColor(materialR.attr.colorOnBackground),
        )
        val authorArtist = if (item.manga.manga.author == item.manga.manga.artist || item.manga.manga.artist.isNullOrBlank()) {
            item.manga.manga.author?.trim() ?: ""
        } else {
            listOfNotNull(
                item.manga.manga.author?.trim()?.takeIf { it.isNotBlank() },
                item.manga.manga.artist?.trim()?.takeIf { it.isNotBlank() },
            ).joinToString(", ")
        }
        val subtitle = buildString {
            if (item.manga.manga.isNovel()) {
                append(itemView.context.getString(MR.strings.novel))
                if (authorArtist.isNotBlank()) {
                    append(" • ")
                }
            }
            append(authorArtist)
        }
        binding.subtitle.text = subtitle.highlightText(item.filter, color)

        binding.compactTitle.text = (
            if (item.manga.manga.isNovel()) {
                "${itemView.context.getString(MR.strings.novel)} • ${binding.title.text}"
            } else {
                binding.title.text
            }
            )?.toString()?.highlightText(item.filter, color)

        titleLayoutTask?.let(binding.title::removeCallbacks)
        val layoutTask = Runnable {
            val hasAuthorInFilter =
                item.filter.isNotBlank() && authorArtist.contains(item.filter, true)
            binding.subtitle.isVisible =
                subtitle.isNotBlank() && (binding.title.lineCount <= 1 || hasAuthorInFilter || item.manga.manga.isNovel())
            binding.title.maxLines = if (hasAuthorInFilter) 1 else 2
        }
        titleLayoutTask = layoutTask
        binding.title.post(layoutTask)

        setUnreadBadge(binding.unreadDownloadBadge.badgeView, item)
        setReadingButton(item)
        setSelected(adapter.isSelected(flexibleAdapterPosition))

        // Update the cover.
        coverOnlyLayout = item.libraryLayout == LibraryItem.LAYOUT_COVER_ONLY_GRID
        setCoverIfChanged(item.manga.manga)
    }

    override fun toggleActivation() {
        super.toggleActivation()
        setSelected(adapter.isSelected(flexibleAdapterPosition), animate = true)
    }

    /** [animate] only for a change the user sees happen; binds snap so recycled cells never spring. */
    fun setSelected(isSelected: Boolean, animate: Boolean = false) {
        val scale = if (isSelected) SELECTED_SCALE else 1f
        if (animate && !ReducedMotion.isEnabled()) {
            selectScaleX.animateToFinalPosition(scale)
            selectScaleY.animateToFinalPosition(scale)
        } else {
            selectScaleX.cancel()
            selectScaleY.cancel()
            binding.card.scaleX = scale
            binding.card.scaleY = scale
        }
        with(binding) {
            card.strokeWidth = when {
                isSelected -> 2.dpToPx
                adapter.showOutline -> 1.dpToPx
                else -> 0
            }
            arrayOf(card, unreadDownloadBadge.root, title, subtitle).forEach {
                it.isSelected = isSelected
            }
        }
    }

    private var coverOnlyLayout = false

    private fun setCoverIfChanged(manga: Manga) {
        val cover = CoverContent(
            mangaId = manga.id,
            sourceId = manga.source,
            url = manga.thumbnail_url,
            lastModified = manga.cover_last_modified,
            inLibrary = manga.favorite,
        )
        if (cover == boundCover) return
        boundCover = cover
        if ((adapter.recyclerView.context as? Activity)?.isDestroyed == true) return
        binding.coverThumbnail.dispose()
        binding.coverThumbnail.loadManga(manga) {
            val hasRatio = binding.coverThumbnail.layoutParams.height != ViewGroup.LayoutParams.WRAP_CONTENT
            if (!fixedSize && !hasRatio) {
                scale(Scale.FIT)
            }
            listener(
                onStart = { binding.behindTitle.isVisible = coverOnlyLayout },
                // Without a cover the card would otherwise be a blank tile.
                onError = { _, _ -> binding.behindTitle.isVisible = true },
                onSuccess = { _, _ ->
                    binding.behindTitle.isVisible = coverOnlyLayout
                    if (!fixedSize && !hasRatio && MangaCoverMetadata.getRatio(manga) != null) {
                        setFreeformCoverRatio(manga)
                    }
                },
            )
        }
    }

    fun setFreeformCoverRatio(manga: Manga, parent: AutofitRecyclerView? = null) {
        val ratioLayout = RatioLayout(
            ratio = MangaCoverMetadata.getRatio(manga),
            itemWidth = parent?.itemWidth ?: binding.root.width,
        )
        if (ratioLayout == appliedRatioLayout) return
        appliedRatioLayout = ratioLayout
        binding.setFreeformCoverRatio(manga, parent)
    }

    override fun recycle() {
        selectScaleX.cancel()
        selectScaleY.cancel()
        titleLayoutTask?.let(binding.title::removeCallbacks)
        titleLayoutTask = null
        binding.coverThumbnail.dispose()
        boundSignature = null
        boundCover = null
        appliedRatioLayout = null
    }

    private fun playButtonClicked() {
        adapter.libraryListener?.startReading(flexibleAdapterPosition, binding.playButton)
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

    private companion object {
        /** Selected covers sit this much smaller, inside their accent outline. */
        const val SELECTED_SCALE = 0.94f
    }
}

fun MangaGridItemBinding.setFreeformCoverRatio(manga: Manga?, parent: AutofitRecyclerView? = null) {
    val ratio = manga?.let { MangaCoverMetadata.getRatio(it) }
    val itemWidth = parent?.itemWidth ?: root.width
    if (ratio != null) {
        coverThumbnail.adjustViewBounds = false
        coverThumbnail.maxHeight = (itemWidth / 3f * 10f).toInt()
        coverThumbnail.minimumHeight = 56.dpToPx
        constraintLayout.minHeight = 56.dpToPx
    } else {
        val coverHeight = (itemWidth / 3f * 4f).toInt()
        constraintLayout.minHeight = coverHeight / 2
        coverThumbnail.minimumHeight =
            (itemWidth / 3f * 3.6f).toInt()
        coverThumbnail.maxHeight = (itemWidth / 3f * 6f).toInt()
        coverThumbnail.adjustViewBounds = true
    }
    coverThumbnail.updateLayoutParams<ConstraintLayout.LayoutParams> {
        if (ratio != null) {
            height = ConstraintLayout.LayoutParams.MATCH_CONSTRAINT
            matchConstraintMaxHeight = coverThumbnail.maxHeight
            matchConstraintMinHeight = coverThumbnail.minimumHeight
            dimensionRatio = "W,1:$ratio"
        } else {
            height = ViewGroup.LayoutParams.WRAP_CONTENT
            dimensionRatio = null
        }
    }
}

fun MangaGridItemBinding.setBGAndFG(libraryLayout: Int) {
    val bottom =
        if (libraryLayout == LibraryItem.LAYOUT_COMFORTABLE_GRID) {
            2.dpToPx
        } else {
            card.marginBottom - 2.dpToPx
        }
    // Ripple hugs the card: its sides match the card's 4dp margin, its top the 8dp row gap.
    val others = card.marginStart
    (constraintLayout.background as? RippleDrawable)?.apply {
        for (i in 0 until numberOfLayers) {
            setLayerInset(i, others, card.marginTop, others, bottom)
        }
    }
    (constraintLayout.foreground as? RippleDrawable)?.apply {
        if (libraryLayout == LibraryItem.LAYOUT_COMFORTABLE_GRID) {
            setLayerSize(1, 0, 0)
        }
        for (i in 0 until numberOfLayers) {
            setLayerInset(i, others, card.marginTop, others, bottom)
        }
    }
}
