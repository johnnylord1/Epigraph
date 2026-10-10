package epigraph.books.pdf

/**
 * The text of the pages on screen (one, or two in a spread) joined for a single selection
 * surface, and the way back from a selection in that text to one page's own offsets.
 */
class PdfSelectionSegments(pages: List<Pair<Int, String>>) {

    data class Selection(val page: Int, val start: Int, val end: Int, val text: String)

    private class Segment(val page: Int, val offset: Int, val text: String)

    private val segments: List<Segment>

    val text: String

    init {
        val builder = StringBuilder()
        segments = pages.mapIndexed { index, (page, pageText) ->
            if (index > 0) builder.append(PAGE_SEPARATOR)
            Segment(page, builder.length, pageText).also { builder.append(pageText) }
        }
        text = builder.toString()
    }

    /**
     * The page holding the start of [start]..[end] and the selection within it. A selection that
     * runs into the next page stops at the end of the first, since a highlight belongs to one page.
     */
    fun resolve(start: Int, end: Int): Selection? {
        if (start < 0 || end <= start) return null
        val segment = segments.lastOrNull { it.offset <= start } ?: return null
        val localStart = start - segment.offset
        val localEnd = (end - segment.offset).coerceAtMost(segment.text.length)
        if (localEnd <= localStart) return null
        return Selection(segment.page, localStart, localEnd, segment.text.substring(localStart, localEnd))
    }

    private companion object {
        const val PAGE_SEPARATOR = "\n\n"
    }
}
