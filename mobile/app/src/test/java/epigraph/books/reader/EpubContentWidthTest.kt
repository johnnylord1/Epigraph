package epigraph.books.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EpubContentWidthTest {
    @Test
    fun `default and legacy pixel values keep the engine margins`() {
        assertNull(epubPageMarginsForContentWidth(0, 360))
        assertNull(epubPageMarginsForContentWidth(760, 360))
        assertNull(epubPageMarginsForContentWidth(-5, 360))
    }

    @Test
    fun `the column takes the chosen share of the screen`() {
        assertEquals(0.0, contentWidthSideMargin(100, 1080))
        assertEquals(135.0, contentWidthSideMargin(75, 1080))
        assertEquals(270.0, contentWidthSideMargin(50, 1080))
    }

    @Test
    fun `margin factor divides by the gutter of the screen width`() {
        assertEquals(0.0, epubPageMarginsForContentWidth(100, 360))
        // 90dp a side over the 20px phone gutter.
        assertEquals(4.5, epubPageMarginsForContentWidth(50, 360))
        // 150dp a side over the 30px gutter from 560px up, 200dp over the 40px gutter from 720px up.
        assertEquals(5.0, epubPageMarginsForContentWidth(50, 600))
        assertEquals(5.0, epubPageMarginsForContentWidth(50, 800))
    }

    @Test
    fun `wider content never produces larger margins`() {
        val margins = (1..100).map { epubPageMarginsForContentWidth(it, 360)!! }
        assertTrue(margins.zipWithNext().all { (narrower, wider) -> wider <= narrower })
    }
}
