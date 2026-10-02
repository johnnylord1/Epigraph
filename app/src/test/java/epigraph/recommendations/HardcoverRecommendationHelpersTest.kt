package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.hardcover.HardcoverBookResult
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverLibraryBook
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class HardcoverRecommendationHelpersTest {

    @Test
    fun `discovery queries filter useless tags and cap at limit`() {
        val tags = listOf("fantasy", "book", "web_novel", "ongoing", "sci-fi", "1234", "ab", "adventure")
        val queries = hardcoverDiscoveryQueries(tags)
        assertEquals(listOf("Fantasy novel", "Sci Fi novel"), queries)
    }

    @Test
    fun `discovery queries returns empty when no useful tags`() {
        val tags = listOf("book", "ab", "1234")
        val queries = hardcoverDiscoveryQueries(tags)
        assertTrue(queries.isEmpty())
    }

    @Test
    fun `score titles dedupes and excludes user books and caps at limit`() {
        val pool = listOf(
            "Alpha",
            "alpha!",
            "Beta",
            "Gamma",
            "Delta",
            "Epsilon",
            "Zeta",
            "Eta",
        )
        val userBooks = listOf("Beta")
        val result = hardcoverScoreTitles(pool, userBooks)
        assertEquals(6, result.size)
        assertTrue(result.contains("Alpha"))
        assertFalse(result.contains("alpha!"))
        assertFalse(result.contains("Beta"))
    }

    @Test
    fun `discovery filter applies rating threshold and per-query cap`() {
        data class Item(val name: String, val rating: Double?)
        val items = (1..10).map { Item("item$it", if (it <= 5) 4.0 else 2.0) }
        val result = filterHardcoverDiscovery(items) { it.rating }
        assertEquals(5, result.size)
        assertTrue(result.all { it.rating == 4.0 })
    }

    @Test
    fun `discovery filter caps at results per query`() {
        data class Item(val name: String, val rating: Double?)
        val items = (1..10).map { Item("item$it", 5.0) }
        val result = filterHardcoverDiscovery(items) { it.rating }
        assertEquals(HARDCOVER_DISCOVERY_RESULTS_PER_QUERY, result.size)
    }

    @Test
    fun `useRemoteHardcoverBooks returns false when not logged in`() {
        assertFalse(useRemoteHardcoverBooks(logged = false, lastFailureAtMs = null, nowMs = 100_000L))
    }

    @Test
    fun `useRemoteHardcoverBooks returns false after recent failure`() {
        val now = 100_000L
        val lastFailure = now - 60_000L
        assertFalse(useRemoteHardcoverBooks(logged = true, lastFailureAtMs = lastFailure, nowMs = now))
    }

    @Test
    fun `useRemoteHardcoverBooks returns true after old failure`() {
        val now = 100_000L
        val lastFailure = now - (HARDCOVER_RECORD_REFRESH_COOLDOWN_MS + 1)
        assertTrue(useRemoteHardcoverBooks(logged = true, lastFailureAtMs = lastFailure, nowMs = now))
    }

    @Test
    fun `mergeHardcoverBookTags fills empty tags from genres`() {
        val book = HardcoverLibraryBook(
            bookId = 1L,
            title = "Test",
            authors = emptyList(),
            coverUrl = null,
            rating = null,
            userRating = null,
            statusId = null,
            tags = emptyList(),
            updatedAtMs = null,
        )
        val genres = mapOf(1L to listOf("fantasy", "adventure"))
        val result = mergeHardcoverBookTags(listOf(book), genres)
        assertEquals(listOf("fantasy", "adventure"), result[0].tags)
    }

    @Test
    fun `mergeHardcoverBookTags keeps existing tags`() {
        val book = HardcoverLibraryBook(
            bookId = 1L,
            title = "Test",
            authors = emptyList(),
            coverUrl = null,
            rating = null,
            userRating = null,
            statusId = null,
            tags = listOf("existing"),
            updatedAtMs = null,
        )
        val genres = mapOf(1L to listOf("fantasy"))
        val result = mergeHardcoverBookTags(listOf(book), genres)
        assertEquals(listOf("existing"), result[0].tags)
    }

    @Test
    fun `gate is blocked during error cooldown and allowed after`() {
        var time = 0L
        val gate = HardcoverEnrichmentGate<String> { time }
        assertFalse(gate.blocked())
        gate.markFailure()
        time = 1_000L
        assertTrue(gate.blocked())
        time = HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS
        assertFalse(gate.blocked())
    }

    @Test
    fun `gate returns cached result inside min gap and null after or with different key`() {
        var time = 0L
        val gate = HardcoverEnrichmentGate<String> { time }
        gate.store("key1", "value1")
        time = 1_000L
        assertEquals("value1", gate.cached("key1"))
        assertNull(gate.cached("key2"))
        time = HARDCOVER_BACKGROUND_ENRICHMENT_MIN_GAP_MS
        assertNull(gate.cached("key1"))
    }

    @Test
    fun `identical token lists have full similarity`() {
        val tokens = listOf("mother", "of", "learning")
        assertEquals(1.0, hardcoverTitleSimilarity(tokens, tokens))
    }

    @Test
    fun `matchHardcoverBook matches Mother of Learning with Book 1 suffix`() {
        val result = HardcoverBookResult(
            id = 1,
            title = "Mother of Learning (Book 1)",
            authors = emptyList(),
            genres = emptyList(),
            tags = emptyList(),
            moods = emptyList(),
            coverUrl = null,
            releaseYear = null,
            rating = null,
            ratingsCount = null,
        )
        val match = matchHardcoverBook("Mother of Learning", listOf(result))
        assertNotNull(match)
        assertEquals(1L, match!!.id)
    }

    @Test
    fun `matchHardcoverBook does not match unrelated titles`() {
        val result = HardcoverBookResult(
            id = 1,
            title = "Mother of Learning",
            authors = emptyList(),
            genres = emptyList(),
            tags = emptyList(),
            moods = emptyList(),
            coverUrl = null,
            releaseYear = null,
            rating = null,
            ratingsCount = null,
        )
        val match = matchHardcoverBook("Lord of the Mysteries", listOf(result))
        assertNull(match)
    }

    @Test
    fun `tokenizeHardcoverTitle strips apostrophes and short tokens`() {
        assertEquals(listOf("heros", "journey"), tokenizeHardcoverTitle("Hero's Journey: A"))
    }
}
