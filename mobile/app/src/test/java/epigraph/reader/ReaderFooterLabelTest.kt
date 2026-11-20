package epigraph.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class ReaderFooterLabelTest {

    @Test
    fun `shows the page within the chapter and the share read`() {
        assertEquals("1/5 · 20%", ReaderFooterLabel.format(1, 5, 20))
        assertEquals("3-4/10 · 40%", ReaderFooterLabel.format("3-4", 10, 40))
    }

    @Test
    fun `right-to-left puts the count first`() {
        assertEquals("5/1 · 20%", ReaderFooterLabel.format(1, 5, 20, isLtr = false))
    }

    @Test
    fun `falls back to the percentage while the page count is unknown`() {
        assertEquals("37%", ReaderFooterLabel.format(null, 0, 37))
        assertEquals("100%", ReaderFooterLabel.format(null, 0, 140))
    }

    @Test
    fun `paged share counts the pages on screen`() {
        assertEquals(20, ReaderFooterLabel.pagedPercent(1, 5))
        assertEquals(100, ReaderFooterLabel.pagedPercent(5, 5))
        assertEquals(0, ReaderFooterLabel.pagedPercent(1, 0))
    }

    @Test
    fun `scrolled chapters split into screen-sized pages`() {
        assertEquals(1 to 4, ReaderFooterLabel.scrollPages(scrollOffset = 0, contentHeight = 3500, viewportHeight = 1000))
        assertEquals(2 to 4, ReaderFooterLabel.scrollPages(scrollOffset = 1200, contentHeight = 3500, viewportHeight = 1000))
        assertEquals(4 to 4, ReaderFooterLabel.scrollPages(scrollOffset = 2500, contentHeight = 3500, viewportHeight = 1000))
        assertEquals(1 to 1, ReaderFooterLabel.scrollPages(scrollOffset = 0, contentHeight = 600, viewportHeight = 1000))
        assertNull(ReaderFooterLabel.scrollPages(scrollOffset = 0, contentHeight = 600, viewportHeight = 0))
    }

    @Test
    fun `the last 2 percent of a scrolled chapter reads as its end`() {
        assertEquals(97, ReaderFooterLabel.scrollPercent(0.97f))
        assertEquals(100, ReaderFooterLabel.scrollPercent(0.976f))
        assertEquals(0, ReaderFooterLabel.scrollPercent(-1f))
        // 2440 of 2500 shows as 98%, so the last page shows with 100%.
        assertEquals(4 to 4, ReaderFooterLabel.scrollPages(scrollOffset = 2440, contentHeight = 3500, viewportHeight = 1000))
        assertEquals(3 to 4, ReaderFooterLabel.scrollPages(scrollOffset = 2400, contentHeight = 3500, viewportHeight = 1000))
    }
}
