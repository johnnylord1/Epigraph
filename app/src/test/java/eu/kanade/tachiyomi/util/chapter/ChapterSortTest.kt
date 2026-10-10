package eu.kanade.tachiyomi.util.chapter

import eu.kanade.tachiyomi.data.database.models.Chapter
import eu.kanade.tachiyomi.domain.manga.models.Manga
import io.mockk.every
import io.mockk.mockk
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ChapterSortTest {

    @Test
    fun `chapters sharing source order zero keep their number order`() {
        val chapters = listOf(3f, 1f, 4f, 2f).map { chapter(sourceOrder = 0, number = it) }

        assertEquals(listOf(4f, 3f, 2f, 1f), sorted(chapters, descending = true))
        assertEquals(listOf(1f, 2f, 3f, 4f), sorted(chapters, descending = false))
    }

    @Test
    fun `distinct source order still decides`() {
        val chapters = listOf(
            chapter(sourceOrder = 1, number = 1f),
            chapter(sourceOrder = 0, number = 2f),
            chapter(sourceOrder = 2, number = 9f),
        )

        assertEquals(listOf(2f, 1f, 9f), sorted(chapters, descending = true))
    }

    private fun sorted(chapters: List<Chapter>, descending: Boolean): List<Float> {
        val manga = mockk<Manga> {
            every { usesLocalSort } returns true
            every { sorting } returns Manga.CHAPTER_SORTING_SOURCE
            every { sortDescending } returns descending
        }
        val sort = ChapterSort(manga, chapterFilter = mockk(), preferences = mockk())
        return chapters.sortedWith(sort.sortComparator()).map { it.chapter_number }
    }

    private fun chapter(sourceOrder: Int, number: Float) = Chapter.create().apply {
        source_order = sourceOrder
        chapter_number = number
    }
}
