package epigraph.library

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Mirrors `src/lib/library/sharePayload.test.ts` in Epigraph Desktop. */
class LibraryShareTextTest {
    @Test
    fun `builds a Discord markdown list without link previews`() {
        val text = LibraryShareText.buildText(
            listOf(
                LibraryShareWork("Solo Leveling", "https://example.com/manga/solo-leveling"),
                LibraryShareWork("Local Work", null),
            ),
        )
        assertEquals(
            "- [Solo Leveling](<https://example.com/manga/solo-leveling>)\n- Local Work",
            text,
        )
    }

    @Test
    fun `escapes markdown in titles and drops blank titles`() {
        val text = LibraryShareText.buildText(
            listOf(
                LibraryShareWork("  [Oshi]  no *Ko*_~|`<x>\\  ", "https://example.com/a"),
                LibraryShareWork("   ", "https://example.com/b"),
            ),
        )
        assertEquals("- [\\[Oshi\\] no \\*Ko\\*\\_\\~\\|\\`\\<x\\>\\\\](<https://example.com/a>)", text)
    }

    @Test
    fun `keeps only http and https addresses`() {
        assertEquals("https://example.com/a%20b", LibraryShareText.shareableUrl(" https://example.com/a b "))
        assertEquals("http://example.com/x", LibraryShareText.shareableUrl("http://example.com/x"))
        assertNull(LibraryShareText.shareableUrl("javascript:alert(1)"))
        assertNull(LibraryShareText.shareableUrl("/manga/12"))
        assertNull(LibraryShareText.shareableUrl("file:///sdcard/x"))
        assertNull(LibraryShareText.shareableUrl(""))
        assertNull(LibraryShareText.shareableUrl(null))
    }

    @Test
    fun `lays out the collage like the desktop card`() {
        assertEquals(LibraryShareCollageLayout(0, 0, 0, 0), LibraryShareText.collageLayout(0))
        assertEquals(LibraryShareCollageLayout(1, 1, 1, 0), LibraryShareText.collageLayout(1))
        assertEquals(LibraryShareCollageLayout(3, 1, 3, 0), LibraryShareText.collageLayout(3))
        val many = LibraryShareText.collageLayout(100)
        assertEquals(39, many.covers)
        assertEquals(61, many.overflow)
        assertTrue(many.columns <= 8)
        assertTrue(many.columns * many.rows >= LibraryShareText.MAX_CELLS)
        val exact = LibraryShareText.collageLayout(40)
        assertEquals(40, exact.covers)
        assertEquals(0, exact.overflow)
    }

    @Test
    fun `wraps titles to two lines and ends a cut title with an ellipsis`() {
        // One unit per character keeps the arithmetic readable.
        val measure: (String) -> Float = { it.length.toFloat() }
        assertEquals(listOf("Short"), LibraryShareText.wrapTitle("Short", 10f, 2, measure))
        assertEquals(
            listOf("The", "Beginning…"),
            LibraryShareText.wrapTitle("The Beginning After the End", 10f, 2, measure),
        )
        assertEquals(listOf("one two", "three"), LibraryShareText.wrapTitle(" one  two three ", 7f, 2, measure))
    }
}
