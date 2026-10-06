package epigraph.books.pdf

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PdfSelectionSegmentsTest {

    private val spread = PdfSelectionSegments(listOf(4 to "Left page text", 5 to "Right page text"))

    @Test
    fun `a single page keeps its own offsets`() {
        val single = PdfSelectionSegments(listOf(2 to "Only page"))
        assertEquals("Only page", single.text)
        assertEquals(PdfSelectionSegments.Selection(2, 5, 9, "page"), single.resolve(5, 9))
    }

    @Test
    fun `a selection on the right page of a spread maps to that page`() {
        val start = spread.text.indexOf("page text", spread.text.indexOf("Right"))
        assertEquals(
            PdfSelectionSegments.Selection(5, 6, 15, "page text"),
            spread.resolve(start, start + "page text".length),
        )
    }

    @Test
    fun `a selection across both pages stops at the end of the first`() {
        val start = spread.text.indexOf("text")
        assertEquals(
            PdfSelectionSegments.Selection(4, 10, 14, "text"),
            spread.resolve(start, spread.text.length),
        )
    }

    @Test
    fun `an empty selection or one on the separator alone resolves to nothing`() {
        assertNull(spread.resolve(3, 3))
        assertNull(spread.resolve(-1, 2))
        val separator = "Left page text".length
        assertNull(spread.resolve(separator, separator + 2))
    }
}
