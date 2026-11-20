package epigraph.reader

import kotlin.math.roundToInt

/**
 * The text of the bottom page indicator, shared by every reader (comics, novels, EPUB and PDF) so
 * they all read the same: the page within the current chapter and how much of the chapter is read,
 * as in `3/12 · 25%`.
 */
object ReaderFooterLabel {

    private const val SEPARATOR = " · "

    /** From this shown share on, a scrolled chapter counts as read: last page and 100%. */
    private const val END_PERCENT = 98

    /** Whole-percent share of a scrolled chapter, 100 once it counts as read (as in the novel reader). */
    fun scrollPercent(fraction: Float): Int {
        val percent = (fraction.coerceIn(0f, 1f) * 100f).roundToInt()
        return if (percent >= END_PERCENT) 100 else percent
    }

    /**
     * [page] is the visible page (`"3"`, or `"3-4"` for a spread) and [pages] the chapter's page
     * count. Right-to-left layouts put the count first, as the comics indicator always has.
     * Without a known page count only the percentage is shown.
     */
    fun format(page: String?, pages: Int, percent: Int, isLtr: Boolean = true): String {
        val share = "${percent.coerceIn(0, 100)}%"
        if (page == null || pages <= 0) return share
        val position = if (isLtr) "$page/$pages" else "$pages/$page"
        return position + SEPARATOR + share
    }

    fun format(page: Int, pages: Int, percent: Int, isLtr: Boolean = true): String =
        format(page.toString(), pages, percent, isLtr)

    /** Share of a paged chapter reached once [lastShownPage] (1-based) is on screen. */
    fun pagedPercent(lastShownPage: Int, pages: Int): Int =
        if (pages <= 0) 0 else (lastShownPage.coerceIn(0, pages) * 100f / pages).roundToInt()

    /**
     * Screen-sized pages of a scrolled chapter: [contentHeight] split by [viewportHeight], with the
     * page whose top edge is at or above [scrollOffset]. The last page is reached at the bottom,
     * or once [scrollPercent] shows 100%.
     */
    fun scrollPages(scrollOffset: Int, contentHeight: Int, viewportHeight: Int): Pair<Int, Int>? {
        if (viewportHeight <= 0 || contentHeight <= 0) return null
        val pages = ((contentHeight + viewportHeight - 1) / viewportHeight).coerceAtLeast(1)
        val maxOffset = contentHeight - viewportHeight
        val atEnd = maxOffset <= 1 || scrollOffset >= maxOffset - 1 ||
            scrollPercent(scrollOffset.toFloat() / maxOffset) == 100
        val page = if (atEnd) pages else (scrollOffset.coerceAtLeast(0) / viewportHeight + 1).coerceAtMost(pages)
        return page to pages
    }
}
