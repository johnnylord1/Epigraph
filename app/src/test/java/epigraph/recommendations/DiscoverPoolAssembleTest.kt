package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DiscoverPoolAssembleTest {

    @Test
    fun `comics pool marks nsfw source entries as adult`() {
        val popular = RecommendationEntryInput(
            mangaId = 100L,
            url = "https://example.com/1",
            title = "Blue Lock",
            sourceId = 1L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val latest = RecommendationEntryInput(
            mangaId = 200L,
            url = "https://example.com/2",
            title = "Kaiju No 8",
            sourceId = 2L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val pool = DiscoverPool(
            mode = DiscoverMode.COMICS,
            candidates = emptyList(),
            profile = buildTasteProfile(emptyList()),
            seedCount = 0,
            knownTitleKeys = emptySet(),
            knownProviderKeys = emptySet(),
            failedProviders = emptyList(),
            comicEntries = listOf(popular to false, latest to true),
            nsfwSourceIds = setOf(2L),
            gatheredAtMs = 1_000L,
        )
        val candidates = assembleDiscoverCandidates(pool)
        assertEquals(2, candidates.size)
        val adult = candidates.single { it.title == "Kaiju No 8" }
        assertEquals(RecommendationSafetyLevel.ADULT, adult.safety)
    }

    @Test
    fun `novels pool attaches hardcover provider signal`() {
        val entry = RecommendationEntryInput(
            mangaId = 300L,
            url = "https://example.com/3",
            title = "Lord of Mysteries",
            sourceId = 3L,
            sourceName = "TestSource",
            isNovel = true,
            inLibrary = false,
        )
        val signal = RecommendationProviderSignal(
            providerId = "hardcover",
            providerName = "Hardcover",
            kind = RecommendationProviderKind.SOURCE,
        )
        val titleKey = recommendationTitleKey("Lord of Mysteries", RecommendationContentType.NOVEL)
        val pool = DiscoverPool(
            mode = DiscoverMode.NOVELS,
            candidates = emptyList(),
            profile = buildTasteProfile(emptyList()),
            seedCount = 0,
            knownTitleKeys = emptySet(),
            knownProviderKeys = emptySet(),
            failedProviders = emptyList(),
            novelEntries = listOf(entry),
            hardcoverScores = mapOf(titleKey to signal),
            gatheredAtMs = 1_000L,
        )
        val candidates = assembleDiscoverCandidates(pool)
        assertEquals(1, candidates.size)
        assertTrue(candidates.single().providers.contains(signal))
    }
}
