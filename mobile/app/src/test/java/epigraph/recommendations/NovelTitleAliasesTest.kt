package epigraph.recommendations

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.Assertions.assertEquals

class NovelTitleAliasesTest {

    @Test
    fun `normalize strips bracketed novel tag`() {
        assertEquals("lorde dos misterios", normalizeNovelTitleAliasKey("Lorde dos Mistérios (Novel)"))
    }

    @Test
    fun `normalize strips volume number`() {
        assertEquals("shadow slave", normalizeNovelTitleAliasKey("Shadow Slave Vol. 2"))
    }

    @Test
    fun `normalize expands ampersand and strips brackets`() {
        assertEquals("beware and chickens", normalizeNovelTitleAliasKey("Beware & Chicken's [EN]"))
    }

    @Test
    fun `candidates returns original and alias for known title`() {
        assertEquals(
            listOf("Lorde dos Mistérios", "Lord of the Mysteries"),
            canonicalNovelTitleCandidates("Lorde dos Mistérios")
        )
    }

    @Test
    fun `candidates dedupes alias with same normalized key`() {
        assertEquals(listOf("Knight of Chaos"), canonicalNovelTitleCandidates("Knight of Chaos"))
    }

    @Test
    fun `candidates returns empty for blank input`() {
        assertEquals(emptyList<String>(), canonicalNovelTitleCandidates("   "))
    }
}
