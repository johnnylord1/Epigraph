package eu.kanade.tachiyomi.ui.manga

import android.content.Context
import java.text.DecimalFormat
import yokai.i18n.MR
import yokai.util.lang.getString

internal enum class MangaReadingButtonLabel {
    START,
    START_CHAPTER,
    CONTINUE,
    CONTINUE_CHAPTER,
}

internal data class MangaReadingButtonState(
    val chapterNumber: Double,
    val hasProgress: Boolean,
    /** The chapter's own name, such as a PDF outline entry, shown in place of its number. */
    val chapterTitle: String? = null,
) {
    val label: MangaReadingButtonLabel
        get() = when {
            chapterNumber > 0 && hasProgress -> MangaReadingButtonLabel.CONTINUE_CHAPTER
            chapterNumber > 0 -> MangaReadingButtonLabel.START_CHAPTER
            hasProgress -> MangaReadingButtonLabel.CONTINUE
            else -> MangaReadingButtonLabel.START
        }
}

internal fun shouldShowMangaReadingFab(
    isTablet: Boolean,
    hasReadingTarget: Boolean,
    isSelectionMode: Boolean,
    headerActionVisible: Boolean,
    headerActionInViewport: Boolean,
): Boolean {
    if (isTablet || !hasReadingTarget || isSelectionMode) return false
    return !headerActionVisible || !headerActionInViewport
}

internal fun Context.getReadingButtonText(
    state: MangaReadingButtonState,
    decimalFormat: DecimalFormat,
): String = when (state.label) {
    MangaReadingButtonLabel.START -> getString(MR.strings.start_reading)
    MangaReadingButtonLabel.CONTINUE -> getString(MR.strings.continue_reading)
    MangaReadingButtonLabel.START_CHAPTER -> state.chapterTitle
        ?.let { getString(MR.strings.start_reading_titled_, it) }
        ?: getString(MR.strings.start_reading_chapter_, decimalFormat.format(state.chapterNumber))
    MangaReadingButtonLabel.CONTINUE_CHAPTER -> state.chapterTitle
        ?.let { getString(MR.strings.continue_reading_titled_, it) }
        ?: getString(MR.strings.continue_reading_chapter_, decimalFormat.format(state.chapterNumber))
}
