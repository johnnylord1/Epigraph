package eu.kanade.tachiyomi.ui.reader

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NovelTextPositionTest {
    @Test
    fun `legacy zero anchor falls back to percentage away from chapter start`() {
        assertFalse(NovelTextPosition(0, 0).isExactAnchor(progression = 0.62))
    }

    @Test
    fun `zero anchor is exact at chapter start`() {
        assertTrue(NovelTextPosition(0, 0).isExactAnchor(progression = 0.0))
    }

    @Test
    fun `nonzero block or text offset is an exact anchor`() {
        assertTrue(NovelTextPosition(4, 0).isExactAnchor(progression = 0.62))
        assertTrue(NovelTextPosition(0, 120).isExactAnchor(progression = 0.62))
    }
}
