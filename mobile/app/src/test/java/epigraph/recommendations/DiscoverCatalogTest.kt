package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class DiscoverCatalogTest {

    private fun candidate(
        id: String,
        sourceId: Long? = 1L,
        inLibrary: Boolean = false,
        safety: RecommendationSafetyLevel = RecommendationSafetyLevel.SAFE,
        tags: List<String> = emptyList(),
        providers: List<RecommendationProviderSignal> = emptyList(),
    ) = RecommendationCandidate(
        id = id,
        title = "Title $id",
        tags = tags,
        contentType = RecommendationContentType.MANGA,
        inLibrary = inLibrary,
        safety = safety,
        providers = providers,
        targets = sourceId?.let { listOf(RecommendationTarget(it, "/$id", "Title $id")) }.orEmpty(),
    )

    private val tracker = RecommendationProviderSignal(
        providerId = "anilist",
        providerName = "AniList",
        kind = RecommendationProviderKind.TRACKER,
        score = NormalizedMetric(value = 0.84, confidence = 0.9, method = "test"),
    )

    @Test
    fun `lists source works in source order with tracker badges`() {
        val catalog = buildDiscoverCatalog(
            listOf(candidate("b", providers = listOf(tracker)), candidate("a"), candidate("tracker-only", sourceId = null)),
            BuildRecommendationSectionsOptions(),
        )
        assertEquals(listOf("b", "a"), catalog.map { it.candidate.id })
        assertNotNull(catalog.first().badge)
        assertEquals(listOf("anilist"), catalog.first().badge!!.providerIds)
        assertNull(catalog.last().badge)
    }

    @Test
    fun `applies the For you filters`() {
        val candidates = listOf(
            candidate("library", inLibrary = true),
            candidate("adult", safety = RecommendationSafetyLevel.ADULT),
            candidate("blocked", tags = listOf("Gore")),
            candidate("ok"),
        )
        val filtered = buildDiscoverCatalog(candidates, BuildRecommendationSectionsOptions(blockedTags = listOf("gore")))
        assertEquals(listOf("ok"), filtered.map { it.candidate.id })

        val everything = buildDiscoverCatalog(
            candidates,
            BuildRecommendationSectionsOptions(includeInLibrary = true, includeNsfw = true),
        )
        assertEquals(listOf("library", "adult", "blocked", "ok"), everything.map { it.candidate.id })
    }
}
