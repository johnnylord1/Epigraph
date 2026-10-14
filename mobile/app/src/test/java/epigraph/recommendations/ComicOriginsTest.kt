package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.TrackManager
import java.io.File
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class ComicOriginsTest {
    @TempDir
    lateinit var dir: File

    private fun idAnswer(vararg media: Triple<Long, Long?, String>) =
        """{"data":{"Page":{"media":[${media.joinToString(",") { (id, mal, country) -> """{"id":$id,"idMal":${mal ?: "null"},"countryOfOrigin":"$country"}""" }}]}}}"""

    private fun titleAnswer(vararg perQuery: List<Pair<String, String>>) =
        """{"data":{${perQuery.withIndex().joinToString(",") { (i, results) ->
            """"q$i":{"media":[${results.joinToString(",") { (title, country) -> """{"countryOfOrigin":"$country","title":{"romaji":"$title","english":null,"native":null},"synonyms":[]}""" }}]}"""
        }}}}"""

    @Test
    fun `the country names the comic format`() {
        assertEquals(RecommendationContentType.MANHWA, comicTypeFromCountry("KR"))
        assertEquals(RecommendationContentType.MANHUA, comicTypeFromCountry("cn"))
        assertEquals(RecommendationContentType.MANHUA, comicTypeFromCountry("TW"))
        assertEquals(RecommendationContentType.MANGA, comicTypeFromCountry("JP"))
        assertNull(comicTypeFromCountry(""))
        assertNull(comicTypeFromCountry(null))
    }

    @Test
    fun `a title search keeps only an exact single-country match`() {
        val exact = listOf(AniListTitleResult(listOf("Solo Leveling"), "KR"), AniListTitleResult(listOf("Solo Leveling: Ragnarok"), "KR"))
        assertEquals("KR", exactTitleCountry("Solo Leveling", exact))

        val mixed = listOf(AniListTitleResult(listOf("Blue"), "JP"), AniListTitleResult(listOf("Blue"), "KR"))
        assertEquals("", exactTitleCountry("Blue", mixed))

        val near = listOf(AniListTitleResult(listOf("Solo Leveling: Ragnarok"), "KR"))
        assertEquals("", exactTitleCountry("Solo Leveling", near))

        val synonym = listOf(AniListTitleResult(listOf("Na Honjaman Level Up", "Solo Leveling"), "KR"))
        assertEquals("KR", exactTitleCountry("solo leveling", synonym))
    }

    @Test
    fun `the publisher's country beats the source guess for a library work`() {
        val aggregatorManhwa = RecommendationEntryInput(
            mangaId = 1L, url = "/x", title = "The Greatest Estate Developer", genres = listOf("Action", "Comedy"),
            sourceId = 1L, sourceName = "MangaDex", sourceLang = "en", isNovel = false, inLibrary = true,
        )
        assertEquals(RecommendationContentType.MANGA, aggregatorManhwa.contentType())
        val known = aggregatorManhwa.copy(comicOrigin = RecommendationContentType.MANHWA)
        assertEquals(RecommendationContentType.MANHWA, known.contentType())
        assertEquals(RecommendationContentType.MANHWA, entryToTasteProfileSeed(known).contentType)
        // Novels keep their own type.
        assertEquals(RecommendationContentType.NOVEL, known.copy(isNovel = true).contentType())
    }

    @Test
    fun `a library of aggregator manhwa reads as a manhwa library once the countries are known`() {
        val entries = (1..8).map { i ->
            RecommendationEntryInput(
                mangaId = i.toLong(), url = "/$i", title = "Work $i", genres = listOf("Action", "Fantasy"),
                sourceId = 1L, sourceName = "MangaDex", sourceLang = "en", isNovel = false, inLibrary = true,
                comicOrigin = if (i <= 6) RecommendationContentType.MANHWA else null,
            )
        }
        val weights = buildTasteProfile(entries.map(::entryToTasteProfileSeed)).contentTypeWeights
        val manhwa = weights[RecommendationContentType.MANHWA] ?: 0.0
        val manga = weights[RecommendationContentType.MANGA] ?: 0.0
        assertTrue(manhwa > manga, "manhwa $manhwa should outweigh manga $manga")
    }

    @Test
    fun `tracker entries come first, then the library title`() {
        val origins = ComicOrigins(
            byTrack = mapOf(comicOriginTrackKey(TrackManager.ANILIST, 5) to "KR"),
            byTitle = mapOf(comicOriginTitleKey("Tower of God") to "CN", comicOriginTitleKey("Vagabond") to "JP"),
        )
        assertEquals(RecommendationContentType.MANHWA, origins.of(listOf(comicOriginTrackKey(TrackManager.ANILIST, 5)), "Tower of God"))
        assertEquals(RecommendationContentType.MANGA, origins.of(emptyList(), "Vagabond"))
        assertNull(origins.of(emptyList(), "Unknown"))
    }

    @Test
    fun `tracked works are asked by id once and kept`() = runTest {
        val payloads = mutableListOf<String>()
        val lookup = ComicOriginLookup(ComicOriginStore(File(dir, "origins.json")), post = { payload ->
            payloads += payload
            if ("idMal_in" in payload) idAnswer(Triple(900L, 77L, "JP")) else idAnswer(Triple(5L, null, "KR"))
        })
        val tracks = listOf(TrackManager.ANILIST to 5L, TrackManager.ANILIST to 6L, TrackManager.MYANIMELIST to 77L)

        lookup.refreshTracks(tracks)
        assertEquals(2, payloads.size)
        assertTrue("id_in" in payloads[0] && "idMal_in" in payloads[1])

        val keys = tracks.map { comicOriginTrackKey(it.first, it.second) }
        val expected = mapOf(comicOriginTrackKey(TrackManager.ANILIST, 5) to "KR", comicOriginTrackKey(TrackManager.MYANIMELIST, 77) to "JP")
        assertEquals(expected, lookup.cachedTracks(keys))

        // Answers (and the miss for id 6) are kept: nothing is asked again, even after a restart.
        lookup.refreshTracks(tracks)
        assertEquals(2, payloads.size)
        val reopened = ComicOriginLookup(ComicOriginStore(File(dir, "origins.json")), post = { error("no request expected") })
        reopened.refreshTracks(tracks)
        assertEquals(expected, reopened.cachedTracks(keys))
    }

    @Test
    fun `a miss is asked again after two weeks`() = runTest {
        var now = 1_000L
        var requests = 0
        val lookup = ComicOriginLookup(ComicOriginStore(null), post = { requests += 1; idAnswer() }, now = { now })
        lookup.refreshTracks(listOf(TrackManager.ANILIST to 6L))
        lookup.refreshTracks(listOf(TrackManager.ANILIST to 6L))
        assertEquals(1, requests)
        now += ComicOriginLookup.MISS_RETRY_MS
        lookup.refreshTracks(listOf(TrackManager.ANILIST to 6L))
        assertEquals(2, requests)
    }

    @Test
    fun `title searches stay within their request budget and stop at a failure`() = runTest {
        val titles = (1..25).map { "Title Number $it" }
        var requests = 0
        val lookup = ComicOriginLookup(ComicOriginStore(null), post = { payload ->
            requests += 1
            if (requests == 2) null else titleAnswer(*Array(ComicOriginLookup.TITLE_BATCH_SIZE) { i -> listOf("Title Number ${(requests - 1) * 10 + i + 1}" to "KR") })
        })

        lookup.refreshTitles(titles, maxRequests = 3)
        // The second request failed: the first ten are known, the rest wait for a later visit.
        assertEquals(2, requests)
        val known = lookup.cachedTitles(titles)
        assertEquals(10, known.size)
        assertTrue(known.values.all { it == "KR" })
        assertFalse(comicOriginTitleKey("Title Number 11") in known)
    }

    @Test
    fun `an unreadable answer stores nothing`() = runTest {
        val lookup = ComicOriginLookup(ComicOriginStore(null), post = { """{"errors":[{"message":"Too Many Requests"}]}""" })
        lookup.refreshTracks(listOf(TrackManager.ANILIST to 5L))
        lookup.refreshTitles(listOf("Solo Leveling"), maxRequests = 1)
        assertEquals(emptyMap<String, String>(), lookup.cachedTracks(listOf(comicOriginTrackKey(TrackManager.ANILIST, 5))))
        assertEquals(emptyMap<String, String>(), lookup.cachedTitles(listOf("Solo Leveling")))
    }
}
