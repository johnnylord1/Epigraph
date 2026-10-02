package epigraph.content

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BlockedTagsTest {

    @Test
    fun `normalizeBlockedTag trims and lowercases`() {
        assertEquals("erotic", normalizeBlockedTag("  Erotic  "))
        assertEquals("gl", normalizeBlockedTag("GL"))
    }

    @Test
    fun `normalizeBlockedTag returns null for blank input`() {
        assertNull(normalizeBlockedTag(""))
        assertNull(normalizeBlockedTag("   "))
        assertNull(normalizeBlockedTag("\t\n"))
    }

    @Test
    fun `matchesBlockedTags substring match`() {
        assertTrue(matchesBlockedTags(listOf("Erotica"), setOf("erotic")))
        assertTrue(matchesBlockedTags(listOf("erotic content"), setOf("erotic")))
        assertTrue(matchesBlockedTags(listOf("Romance", "GL"), setOf("gl")))
    }

    @Test
    fun `matchesBlockedTags is case insensitive`() {
        assertTrue(matchesBlockedTags(listOf("ROMANCE"), setOf("romance")))
        assertTrue(matchesBlockedTags(listOf("Romance"), setOf("ROMANCE")))
    }

    @Test
    fun `matchesBlockedTags no match`() {
        assertFalse(matchesBlockedTags(listOf("Action", "Adventure"), setOf("erotic")))
        assertFalse(matchesBlockedTags(listOf("Action"), setOf("action!")))
    }

    @Test
    fun `matchesBlockedTags empty or null genres returns false`() {
        assertFalse(matchesBlockedTags(emptyList(), setOf("erotic")))
        assertFalse(matchesBlockedTags(null, setOf("erotic")))
    }

    @Test
    fun `matchesBlockedTags empty blocked set returns false`() {
        assertFalse(matchesBlockedTags(listOf("Erotica"), emptySet()))
    }

    @Test
    fun `splitGenreString splits comma separated field`() {
        assertEquals(listOf("Action", "Adventure"), splitGenreString("Action, Adventure"))
        assertEquals(listOf("Action", "Adventure", "Comedy"), splitGenreString("Action,Adventure, Comedy "))
    }

    @Test
    fun `splitGenreString drops empty items`() {
        assertEquals(listOf("Action"), splitGenreString("Action,, "))
        assertEquals(emptyList<String>(), splitGenreString(""))
        assertEquals(emptyList<String>(), splitGenreString(null))
    }
}
