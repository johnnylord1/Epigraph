package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class ComicRecommendationGathererTest {

    @Test
    fun `balanceBySource interleaves sources and drops entries over the per-source cap`() {
        val a1 = entry("A1", sourceId = 1)
        val a2 = entry("A2", sourceId = 1)
        val a3 = entry("A3", sourceId = 1)
        val b1 = entry("B1", sourceId = 2)
        val b2 = entry("B2", sourceId = 2)

        val balanced = balanceBySource(listOf(a1, a2, a3, b1, b2), perSourceCap = 2)

        assertEquals(listOf("A1", "B1", "A2", "B2"), balanced.map { it.title })
    }

    @Test
    fun `dedupeByTitle keeps only the first entry per normalized title`() {
        val first = entry("Solo Leveling", sourceId = 1)
        val second = entry("solo  leveling!", sourceId = 2)

        val deduped = dedupeByTitle(listOf(first, second))

        assertEquals(listOf("Solo Leveling"), deduped.map { it.title })
    }

    private fun entry(title: String, sourceId: Long) = RecommendationEntryInput(
        mangaId = null,
        url = "https://example.com/$title",
        title = title,
        sourceId = sourceId,
        sourceName = "Source $sourceId",
        isNovel = false,
        inLibrary = false,
    )
}
