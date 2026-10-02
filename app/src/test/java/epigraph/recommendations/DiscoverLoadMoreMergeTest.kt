package epigraph.recommendations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DiscoverLoadMoreMergeTest {

    @Test
    fun `mergeComicMore with latest false merges popular entries`() {
        val existing = RecommendationEntryInput(
            mangaId = 100L,
            url = "https://example.com/1",
            title = "Blue Lock",
            sourceId = 1L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val incoming = RecommendationEntryInput(
            mangaId = 200L,
            url = "https://example.com/2",
            title = "Kaiju No 8",
            sourceId = 2L,
            sourceName = "OtherSource",
            isNovel = false,
            inLibrary = false,
        )
        val result = mergeComicMore(listOf(existing to false), listOf(incoming), latest = false)
        assertEquals(2, result.size)
        assertTrue(result.all { !it.second })
    }

    @Test
    fun `mergeComicMore with latest true flags new entries as fresh`() {
        val existing = RecommendationEntryInput(
            mangaId = 100L,
            url = "https://example.com/1",
            title = "Blue Lock",
            sourceId = 1L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val incoming = RecommendationEntryInput(
            mangaId = 200L,
            url = "https://example.com/2",
            title = "Kaiju No 8",
            sourceId = 2L,
            sourceName = "OtherSource",
            isNovel = false,
            inLibrary = false,
        )
        val result = mergeComicMore(listOf(existing to false), listOf(incoming), latest = true)
        assertEquals(2, result.size)
        val newEntry = result.single { it.first.title == "Kaiju No 8" }
        assertTrue(newEntry.second)
    }

    @Test
    fun `mergeComicMore with latest false deduplicates by source and url`() {
        val entry = RecommendationEntryInput(
            mangaId = 100L,
            url = "https://example.com/1",
            title = "Blue Lock",
            sourceId = 1L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val duplicate = RecommendationEntryInput(
            mangaId = 100L,
            url = "https://example.com/1",
            title = "Blue Lock",
            sourceId = 1L,
            sourceName = "TestSource",
            isNovel = false,
            inLibrary = false,
        )
        val result = mergeComicMore(listOf(entry to false), listOf(duplicate), latest = false)
        assertEquals(1, result.size)
    }

    @Test
    fun `mergeNovelMore merges and deduplicates novel entries`() {
        val existing = RecommendationEntryInput(
            mangaId = 300L,
            url = "https://example.com/3",
            title = "Lord of Mysteries",
            sourceId = 3L,
            sourceName = "NovelSource",
            isNovel = true,
            inLibrary = false,
        )
        val incoming = RecommendationEntryInput(
            mangaId = 400L,
            url = "https://example.com/4",
            title = "Solo Leveling",
            sourceId = 4L,
            sourceName = "NovelSource2",
            isNovel = true,
            inLibrary = false,
        )
        val result = mergeNovelMore(listOf(existing), listOf(incoming))
        assertEquals(2, result.size)
    }
}
