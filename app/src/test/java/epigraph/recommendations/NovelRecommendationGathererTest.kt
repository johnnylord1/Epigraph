package epigraph.recommendations

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class NovelRecommendationGathererTest {

    @Test
    fun `novelRecommendationFallbackTerms prefers profile tags and drops banned or short tags`() {
        val terms = novelRecommendationFallbackTerms(tasteProfile(listOf("Fantasy", "epub", "go", "Romance")))

        assertEquals(listOf("Fantasy", "Romance", "adventure", "action"), terms)
    }

    @Test
    fun `novelRecommendationFallbackTerms falls back to generic terms when the profile is empty`() {
        val terms = novelRecommendationFallbackTerms(tasteProfile(emptyList()))

        assertEquals(listOf("fantasy", "romance", "adventure", "action"), terms)
    }

    @Test
    fun `novelRecommendationFallbackTerms caps at four terms`() {
        val terms = novelRecommendationFallbackTerms(tasteProfile(listOf("Alpha", "Beta", "Gamma", "Delta", "Epsilon")))

        assertEquals(listOf("Alpha", "Beta", "Gamma", "Delta"), terms)
    }

    @Test
    fun `novelSourceLocalizedFallbackTerms puts Portuguese terms first for pt-BR sources`() {
        val source = FakeSource(id = 1, name = "Foo", lang = "pt-BR")

        val terms = novelSourceLocalizedFallbackTerms(source, listOf("fantasy", "romance", "adventure", "action"))

        assertEquals(listOf("fantasia", "romance", "ação", "aventura", "fantasy"), terms)
    }

    @Test
    fun `novelSourceLocalizedFallbackTerms keeps only base terms for English sources`() {
        val source = FakeSource(id = 1, name = "Foo", lang = "en")

        val terms = novelSourceLocalizedFallbackTerms(source, listOf("fantasy", "romance", "adventure", "action"))

        assertEquals(listOf("fantasy", "romance", "adventure", "action"), terms)
    }

    @Test
    fun `dedupeNovelEntries keeps the same url from different sources and drops same source plus url`() {
        val first = entry("A", sourceId = 1, url = "https://example.com/x")
        val otherSource = entry("B", sourceId = 2, url = "https://example.com/x")
        val duplicate = entry("C", sourceId = 1, url = "https://example.com/x")

        val deduped = dedupeNovelEntries(listOf(first, otherSource, duplicate))

        assertEquals(listOf("A", "B"), deduped.map { it.title })
    }

    @Test
    fun `dedupeNovelEntries falls back to the lowercased title when the url is empty`() {
        val first = entry("Alpha", sourceId = 1, url = "")
        val duplicate = entry("alpha", sourceId = 2, url = "")

        val deduped = dedupeNovelEntries(listOf(first, duplicate))

        assertEquals(listOf("Alpha"), deduped.map { it.title })
    }

    @Test
    fun `mergeTags keeps the first spelling of each tag`() {
        val merged = mergeTags(listOf("Fantasy", "Action"), listOf("fantasy", "Mystery"))

        assertEquals(listOf("Fantasy", "Action", "Mystery"), merged)
    }

    @Test
    fun `normalizeTimestampMs converts seconds to milliseconds and maps non-positive to null`() {
        assertEquals(1_700_000_000_000L, normalizeTimestampMs(1_700_000_000L))
        assertEquals(null, normalizeTimestampMs(0L))
        assertEquals(null, normalizeTimestampMs(-5L))
        assertEquals(1_700_000_000_000L, normalizeTimestampMs(1_700_000_000_000L))
    }

    @Test
    fun `normalizeBrowseSourceName strips parentheticals and generic words`() {
        assertEquals("foo", normalizeBrowseSourceName("Foo (EN)"))
        assertEquals("bar", normalizeBrowseSourceName("Bar Novel Source (PT)"))
    }

    @Test
    fun `interleaveNovelRecommendationSources sorts the preferred language first inside a bucket`() {
        val en = FakeSource(id = 1, name = "Foo (EN)", lang = "en")
        val pt = FakeSource(id = 2, name = "Foo (PT)", lang = "pt-BR")

        val interleaved = interleaveNovelRecommendationSources(listOf(en, pt), preferredLang = "pt-BR")

        assertEquals(listOf("Foo (PT)", "Foo (EN)"), interleaved.map { it.name })
    }

    @Test
    fun `interleaveNovelRecommendationSources round-robins across buckets`() {
        val fooEn = FakeSource(id = 1, name = "Foo (EN)", lang = "en")
        val fooPt = FakeSource(id = 2, name = "Foo (PT)", lang = "pt-BR")
        val barEn = FakeSource(id = 3, name = "Bar (EN)", lang = "en")

        val interleaved = interleaveNovelRecommendationSources(listOf(fooEn, fooPt, barEn), preferredLang = "en")

        assertEquals(listOf("Bar (EN)", "Foo (EN)", "Foo (PT)"), interleaved.map { it.name })
    }

    @Test
    fun `sourceBatch round-robins through the pool and wraps to page 2`() {
        val pool = (1..14).toList()
        val batchSize = 6

        val (batch1, page1) = sourceBatch(pool, 1, batchSize)
        assertEquals(listOf(1, 2, 3, 4, 5, 6), batch1)
        assertEquals(1, page1)

        val (batch2, page2) = sourceBatch(pool, 2, batchSize)
        assertEquals(listOf(7, 8, 9, 10, 11, 12), batch2)
        assertEquals(1, page2)

        val (batch3, page3) = sourceBatch(pool, 3, batchSize)
        assertEquals(listOf(13, 14), batch3)
        assertEquals(1, page3)

        val (batch4, page4) = sourceBatch(pool, 4, batchSize)
        assertEquals(listOf(1, 2, 3, 4, 5, 6), batch4)
        assertEquals(2, page4)
    }

    @Test
    fun `sourceBatch returns the whole pool when it is smaller than the batch size`() {
        val pool = listOf(1, 2, 3, 4)
        val (batch, sourcePage) = sourceBatch(pool, 2, 6)
        assertEquals(listOf(1, 2, 3, 4), batch)
        assertEquals(2, sourcePage)
    }

    private fun tasteProfile(topTags: List<String>) = TasteProfile(
        tagWeights = emptyMap(),
        contentTypeWeights = emptyMap(),
        sourceWeights = emptyMap(),
        topTags = topTags,
        positiveTags = emptyList(),
        negativeTags = emptyList(),
        seedCount = 0,
    )

    private fun entry(title: String, sourceId: Long, url: String = "https://example.com/$title") = RecommendationEntryInput(
        mangaId = null,
        url = url,
        title = title,
        sourceId = sourceId,
        sourceName = "Source $sourceId",
        isNovel = true,
        inLibrary = false,
    )

    private class FakeSource(
        override val id: Long,
        override val name: String,
        override val lang: String,
    ) : CatalogueSource {
        override val supportsLatest: Boolean get() = false

        override suspend fun getPopularManga(page: Int): MangasPage = error("unused")
        override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage = error("unused")
        override suspend fun getLatestUpdates(page: Int): MangasPage = error("unused")
        override fun getFilterList(): FilterList = FilterList()
        override suspend fun getMangaDetails(manga: SManga): SManga = error("unused")
        override suspend fun getChapterList(manga: SManga): List<SChapter> = error("unused")
    }
}
