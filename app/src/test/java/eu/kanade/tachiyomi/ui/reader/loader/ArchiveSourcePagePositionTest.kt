package eu.kanade.tachiyomi.ui.reader.loader

import eu.kanade.tachiyomi.ui.reader.model.ReaderPage
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class ArchiveSourcePagePositionTest {
    @Test
    fun `maps split archive entries back to their source page indexes`() {
        val positions = archiveSourcePagePositions(
            listOf(
                "001.webp",
                "002__001.jpg",
                "002__002.jpg",
                "003.webp",
            ),
        )

        assertEquals(listOf(0, 1, 1, 2), positions.map { it?.index })
        assertEquals(listOf(3, 3, 3, 3), positions.map { it?.count })
    }

    @Test
    fun `leaves nonstandard archives on the existing local index behavior`() {
        val positions = archiveSourcePagePositions(listOf("cover.webp", "001.webp"))

        positions.forEach(::assertNull)
    }

    @Test
    fun `maps an online source position to its first offline split segment`() {
        val pages = pagesWithSourceIndexes(0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6)

        assertEquals(
            9,
            resolveRequestedPage(storedPageIndex = 5, storedPageCount = 7, pages = pages),
        )
    }

    @Test
    fun `preserves an existing offline segment position`() {
        val pages = pagesWithSourceIndexes(0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 6)

        assertEquals(
            5,
            resolveRequestedPage(storedPageIndex = 5, storedPageCount = 11, pages = pages),
        )
    }

    private fun pagesWithSourceIndexes(vararg indexes: Int): List<ReaderPage> = indexes.mapIndexed { index, sourceIndex ->
        ReaderPage(index).apply {
            sourcePageIndex = sourceIndex
            sourcePageCount = 7
        }
    }
}
