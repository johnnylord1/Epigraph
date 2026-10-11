package eu.kanade.tachiyomi.ui.migration.manga.design

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class MigrationSourceSelectionTest {

    private val comics = setOf(1L, 2L, 3L)
    private val novels = setOf(10L, 11L)

    @Test
    fun `each kind reads only its own saved sources`() {
        val saved = "2/1/10/junk"

        assertEquals(listOf(2L, 1L), MigrationSourceSelection.ofKind(saved, comics))
        assertEquals(listOf(10L), MigrationSourceSelection.ofKind(saved, novels))
        assertEquals(emptyList<Long>(), MigrationSourceSelection.ofKind("2/1", novels))
    }

    @Test
    fun `saving one kind keeps the other kind's selection`() {
        val afterNovels = MigrationSourceSelection.merge("2/1/10", novels, listOf(11L))
        assertEquals("11/2/1", afterNovels)

        val afterComics = MigrationSourceSelection.merge(afterNovels, comics, listOf(3L))
        assertEquals("3/11", afterComics)
    }

    @Test
    fun `an empty selection clears only that kind`() {
        assertEquals("10", MigrationSourceSelection.merge("2/1/10", comics, emptyList()))
        assertEquals("", MigrationSourceSelection.merge("", novels, emptyList()))
    }
}
