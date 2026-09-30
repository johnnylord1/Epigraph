package epigraph.books.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpubContentWidthTest {
    @Test
    fun `default and legacy pixel values keep the engine margins`() {
        assertNull(epubPageMarginsForContentWidth(0))
        assertNull(epubPageMarginsForContentWidth(760))
        assertNull(epubPageMarginsForContentWidth(-5))
    }

    @Test
    fun `percentage maps to readium margin factor`() {
        assertEquals(0.0, epubPageMarginsForContentWidth(100))
        assertEquals(1.0, epubPageMarginsForContentWidth(75))
        assertEquals(2.0, epubPageMarginsForContentWidth(50))
        assertEquals(3.0, epubPageMarginsForContentWidth(5))
    }

    @Test
    fun `wider content never produces larger margins`() {
        val margins = (1..100).map { epubPageMarginsForContentWidth(it)!! }
        assertTrue(margins.zipWithNext().all { (narrower, wider) -> wider <= narrower })
    }
}
