package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DiscoverCatalogTest {

    private fun candidate(
        id: String,
        sourceId: Long? = 1L,
        title: String = "Title $id",
        inLibrary: Boolean = false,
        safety: RecommendationSafetyLevel = RecommendationSafetyLevel.SAFE,
        tags: List<String> = emptyList(),
        providers: List<RecommendationProviderSignal> = emptyList(),
    ) = RecommendationCandidate(
        id = id,
        title = title,
        tags = tags,
        contentType = RecommendationContentType.MANGA,
        inLibrary = inLibrary,
        safety = safety,
        providers = providers,
        targets = sourceId?.let { listOf(RecommendationTarget(it, "/$id", title)) }.orEmpty(),
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

    @Test
    fun `genres must all match, through their aliases`() {
        assertTrue(matchesAllGenres(listOf("Action", "Comedy"), emptyList()))
        assertTrue(matchesAllGenres(listOf("action", "Romantic Comedy"), listOf("Action", "Comedy")))
        assertFalse(matchesAllGenres(listOf("Action"), listOf("Action", "Comedy")))
        assertTrue(matchesAllGenres(listOf("Boys Love"), listOf("Yaoi")))
        assertTrue(matchesAllGenres(listOf("BL"), listOf("Yaoi")))
        // Short aliases only match a whole tag.
        assertFalse(matchesAllGenres(listOf("Possible"), listOf("Yaoi")))
    }

    @Test
    fun `adult genres are offered only with NSFW on and blocked tags are left out`() {
        val safe = discoverGenreOptions(includeNsfw = false, blockedTags = emptyList())
        assertEquals(DISCOVER_COMMON_GENRES, safe)
        assertTrue(DISCOVER_ADULT_GENRES.none { it in safe })

        val nsfw = discoverGenreOptions(includeNsfw = true, blockedTags = listOf("ecchi"))
        assertTrue(DISCOVER_ADULT_GENRES.all { it in nsfw })
        assertFalse("Ecchi" in nsfw)
    }

    @Test
    fun `genre catalog lists matching gathered works first, then new search results`() {
        val pool = listOf(
            candidate("romance", tags = listOf("Romance")),
            candidate("action", tags = listOf("Action")),
        )
        val search = listOf(
            candidate("same-id", tags = listOf("Romance")).copy(id = "romance"),
            candidate("same-title", sourceId = 2L, title = "Title romance"),
            candidate("adult", safety = RecommendationSafetyLevel.ADULT),
            candidate("new"),
        )
        val catalog = buildDiscoverGenreCatalog(pool, search, BuildRecommendationSectionsOptions(), listOf("Romance"))
        assertEquals(listOf("romance", "new"), catalog.map { it.candidate.id })
    }

    @Test
    fun `untagged search results count only for a single genre`() {
        assertTrue(genreSearchKeeps(emptyList(), listOf("Romance")))
        assertFalse(genreSearchKeeps(emptyList(), listOf("Romance", "Comedy")))
        assertTrue(genreSearchKeeps(listOf("Romance", "Comedy"), listOf("Romance", "Comedy")))
        assertFalse(genreSearchKeeps(listOf("Romance"), listOf("Romance", "Comedy")))
    }

    @Test
    fun `card size follows the library grid columns`() {
        assertEquals(3, discoverGridColumns(411f, 1f))
        assertEquals(4, discoverGridColumns(411f, 0f))
        assertEquals(5, discoverGridColumns(411f, -0.5f))
        assertEquals(1, discoverGridColumns(411f, 3f))
        assertEquals(5, discoverGridColumns(800f, 1f))
    }
}
