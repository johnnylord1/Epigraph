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
    fun `a leading acronym of the title is recognized`() {
        assertEquals(
            listOf("Ldm Lorde Dos Misterios", "Lorde Dos Misterios", "Lord of the Mysteries"),
            canonicalNovelTitleCandidates("Ldm Lorde Dos Misterios"),
        )
        assertEquals("Escravo Das Sombras", withoutTitleAcronym("Eds Escravo Das Sombras"))
        assertEquals("Trono Do Deus Arcanista", withoutTitleAcronym("Tda Trono Do Deus Arcanista"))
        // The initials of the English title.
        assertEquals("O Lendario Mecanico", withoutTitleAcronym("Tlm O Lendario Mecanico"))
    }

    @Test
    fun `a first word that is not the initials stays`() {
        assertEquals(null, withoutTitleAcronym("Advento Das Tres Calamidades"))
        assertEquals(null, withoutTitleAcronym("My Vampire System"))
        assertEquals(null, withoutTitleAcronym("Ldm Lorde"))
    }

    @Test
    fun `candidates returns empty for blank input`() {
        assertEquals(emptyList<String>(), canonicalNovelTitleCandidates("   "))
    }
}
