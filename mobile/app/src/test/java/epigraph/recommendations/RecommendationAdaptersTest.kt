package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.hardcover.HardcoverBookResult
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverLibraryBook
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RecommendationAdaptersTest {
    private val now = 1_800_000_000_000L

    private fun entry(
        title: String,
        genres: List<String> = listOf("Action", "Fantasy"),
        inLibrary: Boolean = true,
        isNovel: Boolean = false,
        sourceName: String = "MangaDex",
        sourceLang: String? = "en",
        tracks: List<RecommendationTrackInput> = emptyList(),
        mangaId: Long? = 1L,
        unread: Int = 0,
        downloads: Int = 0,
        chapters: Int = 0,
    ) = RecommendationEntryInput(
        mangaId = mangaId,
        url = "/title/$title",
        title = title,
        genres = genres,
        sourceId = 42L,
        sourceName = sourceName,
        sourceLang = sourceLang,
        coverUrl = "https://example.test/$title.jpg",
        isNovel = isNovel,
        inLibrary = inLibrary,
        unreadCount = unread,
        downloadCount = downloads,
        chapterCount = chapters,
        tracks = tracks,
    )

    @Test
    fun `comic content type follows dedicated sources, markers, then language`() {
        assertEquals(RecommendationContentType.MANHWA, inferComicContentType("X", null, emptyList(), "Asura Scans", "en"))
        assertEquals(RecommendationContentType.MANHWA, inferComicContentType("Solo Leveling Webtoon", null, emptyList(), "MangaDex", "en"))
        assertEquals(RecommendationContentType.MANGA, inferComicContentType("Tower of God", null, emptyList(), "MangaDex", "en"))
        assertEquals(RecommendationContentType.MANHUA, inferComicContentType("X", null, listOf("Cultivation"), "Src", "en"))
        assertEquals(RecommendationContentType.MANHWA, inferComicContentType("X", null, emptyList(), "Naver", "ko"))
        assertEquals(RecommendationContentType.MANHUA, inferComicContentType("X", null, emptyList(), "Bilibili", "zh-Hans"))
        // Aggregators host every format, so their language says nothing about the work.
        assertEquals(RecommendationContentType.MANGA, inferComicContentType("X", null, emptyList(), "MangaDex", "ko"))
    }

    @Test
    fun `track record seed status prefers the status name over progress`() {
        fun track(status: TasteSeedStatus?, dateMs: Long? = null) =
            RecommendationTrackInput(1L, "AniList", "1", null, status = status, dateMs = dateMs)

        assertEquals(TasteSeedStatus.COMPLETED, trackRecordSeedStatus(track(TasteSeedStatus.COMPLETED)))
        assertEquals(TasteSeedStatus.DROPPED, trackRecordSeedStatus(track(TasteSeedStatus.DROPPED)))
        assertEquals(TasteSeedStatus.READING, trackRecordSeedStatus(track(TasteSeedStatus.READING)))
        assertEquals(TasteSeedStatus.PLANNING, trackRecordSeedStatus(track(TasteSeedStatus.PLANNING)))
        // A finish date completes the work even when the status name is unknown.
        assertEquals(TasteSeedStatus.COMPLETED, trackRecordSeedStatus(track(TasteSeedStatus.UNKNOWN, dateMs = 1_700_000_000_000L)))
        // No name, no date: the desktop falls back to planning.
        assertEquals(TasteSeedStatus.PLANNING, trackRecordSeedStatus(track(TasteSeedStatus.UNKNOWN)))
    }

    @Test
    fun `library seed uses best tracker score and implicit weights`() {
        val seed = entryToTasteProfileSeed(
            entry(
                "Rated",
                tracks = listOf(
                    RecommendationTrackInput(2L, "AniList", "10", score10 = 6.0),
                    RecommendationTrackInput(1L, "MyAnimeList", "20", score10 = 9.0, status = TasteSeedStatus.COMPLETED),
                ),
                unread = 3,
            ),
        )
        assertEquals("manga:1", seed.id)
        assertEquals(9.0, seed.userRating)
        assertEquals(10.0, seed.userRatingMax)
        assertEquals(0.55, seed.implicitWeight)
        assertEquals(TasteSeedStatus.COMPLETED, seed.status)

        val unrated = entryToTasteProfileSeed(entry("Plain", downloads = 2))
        assertNull(unrated.userRating)
        assertEquals(0.65, unrated.implicitWeight)

        val novel = entryToTasteProfileSeed(entry("Long novel", isNovel = true, chapters = 120))
        assertEquals("novel:1", novel.id)
        assertEquals(RecommendationContentType.NOVEL, novel.contentType)
        assertEquals(0.55, novel.implicitWeight)
    }

    @Test
    fun `book seed weight and status follow reading progress`() {
        val unopened = bookToTasteProfileSeed(RecommendationBookInput("a", "A", "epub"))
        assertEquals(0.3, unopened.implicitWeight)
        assertEquals(TasteSeedStatus.PLANNING, unopened.status)

        val finished = bookToTasteProfileSeed(RecommendationBookInput("b", "B", "pdf", progress = 0.99))
        assertEquals(0.75, finished.implicitWeight)
        assertEquals(TasteSeedStatus.COMPLETED, finished.status)

        val reading = bookToTasteProfileSeed(RecommendationBookInput("c", "C", "epub", progress = 0.4))
        assertEquals(0.6, reading.implicitWeight)
        assertEquals(TasteSeedStatus.READING, reading.status)
    }

    @Test
    fun `latest feed rank replaces source recency from 1 down to 0_2`() {
        val ranked = applyLatestFeedRank(
            (0 until 5).map { entryToRecommendationCandidate(entry("T$it", inLibrary = false, mangaId = null), now) },
        )
        val recencies = ranked.map { c -> c.providers.first { it.kind == RecommendationProviderKind.SOURCE }.recency!!.value }
        assertEquals(1.0, recencies.first(), 1e-9)
        assertEquals(0.2, recencies.last(), 1e-9)
        assertTrue(recencies.zipWithNext().all { (a, b) -> a > b })
        assertTrue(ranked.all { it.updatedAtMs == null })
    }

    @Test
    fun `tracker catalog candidate carries remote key and normalized metrics`() {
        val candidate = trackerCatalogToRecommendationCandidate(
            TrackerCatalogInput(
                trackerId = 2L,
                trackerName = "AniList",
                remoteId = "30013",
                title = "One Piece",
                genres = listOf("Adventure"),
                publishingType = "MANHWA",
                publishingStatus = "RELEASING",
                score = 88.0,
                popularity = 250_000.0,
                trending = 900.0,
            ),
            now,
        )
        assertEquals("tracker:2:30013", candidate.id)
        assertEquals(RecommendationContentType.MANHWA, candidate.contentType)
        val provider = candidate.providers.single()
        assertEquals("tracker:2:30013", provider.remoteKey())
        assertEquals(0.88, provider.score!!.value, 1e-9)
        assertEquals("anilist", provider.iconKey)
        assertTrue(candidate.tags.containsAll(listOf("Adventure", "MANHWA", "RELEASING")))
    }

    @Test
    fun `library entries and their tracked works are excluded from sections`() {
        val trackedLibrary = entry(
            "Owned",
            genres = listOf("Action", "Fantasy", "Magic"),
            tracks = listOf(RecommendationTrackInput(2L, "AniList", "777", score10 = 9.5)),
        )
        val seeds = listOf(entryToTasteProfileSeed(trackedLibrary))
        val profile = buildTasteProfile(seeds)

        val sameWorkFromTracker = trackerCatalogToRecommendationCandidate(
            TrackerCatalogInput(2L, "AniList", "777", "Different romanization", genres = listOf("Action", "Fantasy"), score = 90.0),
            now,
        )
        val fresh = trackerCatalogToRecommendationCandidate(
            TrackerCatalogInput(
                2L, "AniList", "888", "New work",
                genres = listOf("Action", "Fantasy", "Magic"), score = 85.0, popularity = 200_000.0, trending = 5_000.0,
            ),
            now,
        )
        val sections = buildRecommendationSections(
            mergeRecommendationCandidates(
                listOf(entryToRecommendationCandidate(trackedLibrary, now), sameWorkFromTracker, fresh),
            ),
            profile,
            BuildRecommendationSectionsOptions(
                knownTitleKeys = knownTitleKeys(seeds),
                knownProviderKeys = knownProviderKeys(listOf(trackedLibrary)),
                nowMs = now,
            ),
        )
        val titles = sections.flatMap { s -> s.items.map { it.candidate.title } }.toSet()
        assertFalse("Owned" in titles)
        assertFalse("Different romanization" in titles)
        assertTrue("New work" in titles)
    }

    @Test
    fun `hardcover candidate uses base tags and user rating for score`() {
        val book = HardcoverLibraryBook(
            bookId = 42,
            title = "Mother of Learning",
            authors = emptyList(),
            coverUrl = null,
            rating = 3.0,
            userRating = 4.0,
            statusId = 2,
            tags = listOf("fantasy"),
            updatedAtMs = null,
        )
        val candidate = hardcoverBookToRecommendationCandidate(book)
        assertEquals(RecommendationContentType.NOVEL, candidate.contentType)
        assertEquals("tracker:hardcover:42", candidate.providers.first().remoteKey())
        assertTrue("hardcover" in candidate.tags)
        assertTrue("fantasy" in candidate.tags)
        assertNotNull(candidate.providers.first().score)
    }

    @Test
    fun `hardcover seed uses base tags and implicit weight from rating`() {
        val book = HardcoverLibraryBook(
            bookId = 42,
            title = "Mother of Learning",
            authors = emptyList(),
            coverUrl = null,
            rating = 3.0,
            userRating = 4.0,
            statusId = 2,
            tags = listOf("fantasy"),
            updatedAtMs = null,
        )
        val seed = hardcoverBookToTasteProfileSeed(book)
        assertEquals(4.0, seed.userRating)
        assertEquals(5.0, seed.userRatingMax)
        assertEquals(listOf("novel", "book", "fantasy"), seed.tags)
        assertNull(seed.implicitWeight)

        val unrated = HardcoverLibraryBook(
            bookId = 42,
            title = "Mother of Learning",
            authors = emptyList(),
            coverUrl = null,
            rating = null,
            userRating = null,
            statusId = 2,
            tags = listOf("fantasy"),
            updatedAtMs = null,
        )
        val unratedSeed = hardcoverBookToTasteProfileSeed(unrated)
        assertEquals(0.45, unratedSeed.implicitWeight)
    }

    @Test
    fun `hardcover discovery candidate has correct id contentType tags and providers`() {
        val book = HardcoverBookResult(
            id = 7,
            title = "Test Book",
            authors = listOf("Author A"),
            genres = listOf("fantasy"),
            tags = listOf("adventure"),
            moods = listOf("dark"),
            coverUrl = "https://example.com/cover.jpg",
            releaseYear = 2024,
            rating = 4.0,
            ratingsCount = 100,
        )
        val candidate = hardcoverDiscoveryToRecommendationCandidate(book, listOf("Fantasy"))
        assertEquals("hardcover-discovery:7", candidate.id)
        assertEquals(RecommendationContentType.BOOK, candidate.contentType)
        assertTrue(candidate.tags.contains("hardcover"))
        assertEquals(1, candidate.tags.count { it.equals("fantasy", ignoreCase = true) })
        assertEquals("tracker:hardcover:7", candidate.providers.first().remoteKey())
        assertEquals("hardcover-catalog", candidate.providers[1].providerId)
    }

    @Test
    fun `hardcover discovery candidate popularity falls back when ratingsCount is null`() {
        val book = HardcoverBookResult(
            id = 7,
            title = "Test Book",
            authors = emptyList(),
            genres = emptyList(),
            tags = emptyList(),
            moods = emptyList(),
            coverUrl = null,
            releaseYear = null,
            rating = null,
            ratingsCount = null,
        )
        val candidate = hardcoverDiscoveryToRecommendationCandidate(book, emptyList())
        assertEquals(0.38, candidate.providers.first().popularity?.value)
    }
}
