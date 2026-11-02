package eu.kanade.tachiyomi.data.database.models

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class ChapterResumablePageTest {
    @Test
    fun `an unread chapter resumes`() {
        assertTrue(chapter(read = false, pagesLeft = 0).hasResumablePage)
    }

    @Test
    fun `a read chapter left part-way resumes`() {
        assertTrue(chapter(read = true, pagesLeft = 5).hasResumablePage)
    }

    @Test
    fun `a chapter finished on its last page starts over`() {
        assertFalse(chapter(read = true, pagesLeft = 1).hasResumablePage)
    }

    @Test
    fun `a chapter marked read starts over`() {
        assertFalse(chapter(read = true, pagesLeft = 0).hasResumablePage)
    }

    private fun chapter(read: Boolean, pagesLeft: Int) = Chapter.create().apply {
        this.read = read
        pages_left = pagesLeft
    }
}
