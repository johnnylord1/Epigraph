package epigraph.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PageTransitionsTest {

    @Test
    fun `normal speed keeps the pager's own durations`() {
        assertEquals(1f, PageTransitions.speedFactor(PageTransitions.SPEED_NORMAL))
    }

    @Test
    fun `slow lengthens and fast shortens the turn`() {
        val slow = PageTransitions.speedFactor(PageTransitions.SPEED_SLOW)
        val fast = PageTransitions.speedFactor(PageTransitions.SPEED_FAST)
        assertTrue(slow > 1f)
        assertTrue(fast < 1f)
    }

    @Test
    fun `unknown stored speed falls back to normal`() {
        assertEquals(1f, PageTransitions.speedFactor(7))
        assertEquals(1f, PageTransitions.speedFactor(-1))
    }

    @Test
    fun `stored values match the settings array order`() {
        // arrays.xml page_turn_styles / page_turn_speeds are indexed by these values.
        assertEquals(listOf(0, 1, 2), listOf(PageTransitions.STYLE_SLIDE, PageTransitions.STYLE_DEPTH, PageTransitions.STYLE_FADE))
        assertEquals(listOf(0, 1, 2), listOf(PageTransitions.SPEED_SLOW, PageTransitions.SPEED_NORMAL, PageTransitions.SPEED_FAST))
    }
}
