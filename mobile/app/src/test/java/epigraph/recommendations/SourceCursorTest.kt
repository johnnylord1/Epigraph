package epigraph.recommendations

import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.MetadataMangasPage
import eu.kanade.tachiyomi.source.model.SManga
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SourceCursorTest {

    private val manga = SManga.create().apply { title = "a"; url = "/a" }

    @Test
    fun `page 1 always resolves to 1`() {
        assertEquals(1, resolveSourcePage(1, 3_600_000L))
    }

    @Test
    fun `page 2 with no cursor resolves to 2`() {
        assertEquals(2, resolveSourcePage(2, null))
    }

    @Test
    fun `page 2 with cursor resolves to cursor`() {
        assertEquals(3_600_000, resolveSourcePage(2, 3_600_000L))
    }

    @Test
    fun `page 3 with END cursor resolves to null`() {
        assertNull(resolveSourcePage(3, SOURCE_CURSOR_END))
    }

    @Test
    fun `cursorAfter plain page with more pages is null`() {
        assertNull(cursorAfter(MangasPage(listOf(manga), true)))
    }

    @Test
    fun `cursorAfter plain page with no more pages is END`() {
        assertEquals(SOURCE_CURSOR_END, cursorAfter(MangasPage(listOf(manga), false)))
    }

    @Test
    fun `cursorAfter empty page is END`() {
        assertEquals(SOURCE_CURSOR_END, cursorAfter(MangasPage(emptyList(), true)))
    }

    @Test
    fun `cursorAfter metadata page with nextKey returns it`() {
        assertEquals(42L, cursorAfter(MetadataMangasPage(listOf(manga), true, emptyList(), 42L)))
    }

    @Test
    fun `cursorAfter metadata page with null nextKey is null`() {
        assertNull(cursorAfter(MetadataMangasPage(listOf(manga), true, emptyList(), null)))
    }

    @Test
    fun `sourceCursorKey latest`() {
        assertEquals("7:latest", sourceCursorKey(7L, true))
    }

    @Test
    fun `sourceCursorKey popular`() {
        assertEquals("7:popular", sourceCursorKey(7L, false))
    }
}
