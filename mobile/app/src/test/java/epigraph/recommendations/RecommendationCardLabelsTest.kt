package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class RecommendationCardLabelsTest {

    private fun candidate(
        contentType: RecommendationContentType = RecommendationContentType.NOVEL,
        status: String? = null,
        inLibrary: Boolean = false,
        providers: List<RecommendationProviderSignal> = emptyList(),
    ) = RecommendationCandidate(
        id = "id",
        title = "Shadow Slave",
        contentType = contentType,
        status = status,
        inLibrary = inLibrary,
        providers = providers,
    )

    private fun provider(
        id: String,
        name: String,
        kind: RecommendationProviderKind,
        score: Double? = null,
        confidence: Double = 0.8,
    ) = RecommendationProviderSignal(
        providerId = id,
        providerName = name,
        kind = kind,
        score = score?.let { NormalizedMetric(it, confidence, "test") },
    )

    private val hardcover = provider("hardcover", "Hardcover", RecommendationProviderKind.TRACKER, score = 0.84)
    private val kitsu = provider("kitsu", "Kitsu", RecommendationProviderKind.TRACKER, score = 0.79)
    private val kitsuCatalog = provider("kitsu-catalog", "Kitsu", RecommendationProviderKind.SOURCE)
    private val centralNovel = provider("lnreader:centralnovel", "Central Novel", RecommendationProviderKind.SOURCE, score = 0.9, confidence = 0.4)

    @Test
    fun `the provider is the first source, then the first provider`() {
        assertEquals("Central Novel", candidate(providers = listOf(hardcover, centralNovel, kitsuCatalog)).cardProviderLabel())
        assertEquals("Kitsu", candidate(providers = listOf(kitsu, kitsuCatalog)).cardProviderLabel())
        assertEquals("Hardcover", candidate(providers = listOf(hardcover)).cardProviderLabel())
        assertEquals("Epigraph", candidate().cardProviderLabel())
    }

    @Test
    fun `a novel with a Hardcover score shows it as its status`() {
        assertEquals(
            RecommendationCardStatus.Text("HC 4.2"),
            candidate(status = "RELEASING", providers = listOf(hardcover)).cardStatus(),
        )
        // A comic never shows Hardcover's score.
        assertEquals(
            RecommendationCardStatus.Known(RecommendationCardKnownStatus.ONGOING),
            candidate(RecommendationContentType.MANHWA, status = "RELEASING", providers = listOf(hardcover)).cardStatus(),
        )
    }

    @Test
    fun `the status reads trackers' words, else whether it is in the library`() {
        assertEquals(RecommendationCardStatus.Known(RecommendationCardKnownStatus.COMPLETED), workStatus("FINISHED"))
        assertEquals(RecommendationCardStatus.Known(RecommendationCardKnownStatus.ONGOING), workStatus("current"))
        assertEquals(RecommendationCardStatus.Known(RecommendationCardKnownStatus.HIATUS), workStatus("on-hiatus"))
        assertEquals(RecommendationCardStatus.Known(RecommendationCardKnownStatus.UNKNOWN), workStatus("  "))
        assertEquals(RecommendationCardStatus.Text("Not Yet Released"), workStatus("NOT_YET_RELEASED"))
        assertEquals(
            RecommendationCardStatus.Known(RecommendationCardKnownStatus.IN_LIBRARY),
            candidate(inLibrary = true).cardStatus(),
        )
        assertEquals(RecommendationCardStatus.Known(RecommendationCardKnownStatus.ONGOING), candidate().cardStatus())
    }

    @Test
    fun `a novel's cover shows Hardcover, then Kitsu, then its surest source`() {
        assertEquals(
            RecommendationCardBanner("hardcover", "4.2"),
            candidate(providers = listOf(centralNovel, kitsu, hardcover)).cardBanner(badge = null),
        )
        assertEquals(
            RecommendationCardBanner("kitsu", "7.9"),
            candidate(providers = listOf(centralNovel, kitsu)).cardBanner(badge = null),
        )
        val surer = provider("lnreader:other", "Other", RecommendationProviderKind.SOURCE, score = 0.6, confidence = 0.9)
        assertEquals(
            RecommendationCardBanner("source", "6.0"),
            candidate(providers = listOf(centralNovel, surer)).cardBanner(badge = null),
        )
        assertNull(candidate(providers = listOf(kitsuCatalog)).cardBanner(badge = null))
    }

    @Test
    fun `a comic's cover shows its tracker badge`() {
        val badge = TrackerScoreBadge(
            consensus = false,
            providerIds = listOf("anilist"),
            iconKeys = listOf("anilist"),
            score = 0.82,
            displayScore = "8.2",
            confidence = 0.9,
        )
        assertEquals(
            RecommendationCardBanner("anilist", "8.2"),
            candidate(RecommendationContentType.MANHWA, providers = listOf(hardcover)).cardBanner(badge),
        )
        assertEquals(
            RecommendationCardBanner("myanimelist", "8.2"),
            candidate(RecommendationContentType.MANGA).cardBanner(badge.copy(iconKeys = listOf("myanimelist"))),
        )
        assertNull(candidate(RecommendationContentType.MANGA).cardBanner(badge = null))
    }
}
