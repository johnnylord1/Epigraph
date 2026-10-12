package epigraph.recommendations

import eu.kanade.tachiyomi.source.model.Filter
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class GenreRecommendationFeedsTest {

    private class Box(name: String) : Filter.CheckBox(name)
    private class Tri(name: String) : Filter.TriState(name)
    private class Boxes(name: String, boxes: List<Box>) : Filter.Group<Box>(name, boxes)
    private class Tris(name: String, tris: List<Tri>) : Filter.Group<Tri>(name, tris)
    private class Choice(name: String, values: Array<String>) : Filter.Select<String>(name, values)

    private fun profile(seedCount: Int = 10) = TasteProfile(
        tagWeights = mapOf("action" to 1.0, "fantasy" to 0.9, "drama" to 0.6),
        contentTypeWeights = mapOf(RecommendationContentType.MANHWA to 3.0, RecommendationContentType.MANGA to 1.0),
        sourceWeights = emptyMap(),
        topTags = listOf("action", "fantasy"),
        positiveTags = listOf("action", "fantasy"),
        negativeTags = emptyList(),
        seedCount = seedCount,
    )

    private fun entry(
        title: String,
        sourceId: Long = 1L,
        url: String = "/${title.lowercase().replace(' ', '-')}",
        cover: String? = "https://example.com/$sourceId$url.jpg",
        isNovel: Boolean = false,
        genres: List<String> = emptyList(),
    ) = RecommendationEntryInput(
        mangaId = null,
        url = url,
        title = title,
        genres = genres,
        sourceId = sourceId,
        sourceName = "Source $sourceId",
        coverUrl = cover,
        isNovel = isNovel,
        inLibrary = false,
    )

    private fun tracker(remoteId: String, title: String, trackerId: Long = 2L) =
        TrackerCatalogInput(trackerId = trackerId, trackerName = "AniList", remoteId = remoteId, title = title)

    private fun pool(mode: DiscoverMode) = DiscoverPool(
        mode = mode,
        candidates = emptyList(),
        profile = buildTasteProfile(emptyList()),
        seedCount = 0,
        knownTitleKeys = emptySet(),
        knownProviderKeys = emptySet(),
        failedProviders = emptyList(),
        gatheredAtMs = 1_000L,
    )

    @Test
    fun `exploration genres need a profile and rotate over the rare genres`() {
        assertNull(explorationGenres(profile(seedCount = 4)))
        val today = explorationGenres(profile(), limit = 2, rotation = 0)
        assertNotNull(today)
        assertEquals(listOf("Adventure", "Comedy"), today!!.include)
        assertTrue(today.exclude.containsAll(listOf("Action", "Fantasy")))
        assertFalse("Drama" in today.include)
        assertEquals(listOf("Comedy", "Horror"), explorationGenres(profile(), limit = 2, rotation = 1)!!.include)
    }

    @Test
    fun `taste catalog requests follow the library's formats and genres`() {
        val requests = tasteCatalogRequests(profile())
        assertEquals(
            listOf(
                TasteCatalogRequest("JP", "Action", 1),
                TasteCatalogRequest("JP", "Fantasy", 1),
                TasteCatalogRequest("KR", "Action", 2),
                TasteCatalogRequest("KR", "Fantasy", 2),
                TasteCatalogRequest("KR", "Drama", 1),
            ),
            requests,
        )
        val (taste, explore) = comicGenreFeedGenres(profile(), rotation = 0)
        assertEquals(listOf("Action", "Fantasy", "Drama"), taste)
        assertEquals(explorationGenres(profile(), rotation = 0)!!.include, explore)
    }

    @Test
    fun `anilist explore feed searches each rare genre in every format the library holds`() {
        val feed = aniListExploreFeed(profile(), rotation = 0)!!
        assertEquals(listOf("KR", "JP"), comicFormatCountries(profile()))
        assertEquals(
            listOf(AniListExploreSearch("Adventure", "KR"), AniListExploreSearch("Adventure", "JP")),
            feed.searches.take(2),
        )
        assertEquals(8, feed.searches.size)
        assertEquals(4, feed.later.size)
        assertTrue(feed.later.all { group -> group.map { it.country } == listOf("KR", "JP") })
        assertTrue(feed.exclude.containsAll(listOf("Action", "Fantasy")))
        assertNull(aniListExploreFeed(profile(seedCount = 2), rotation = 0))
    }

    @Test
    fun `genre filter checks the genre list and never an excluding one`() {
        val status = Choice("Status", arrayOf("All", "Ongoing"))
        val excluded = Boxes("Exclude genres", listOf(Box("Action")))
        val action = Box("Action (171)")
        val genres = Boxes("Genres", listOf(Box("Comedy"), action))
        assertTrue(applySourceGenreFilter(listOf(status, excluded, genres), "Action"))
        assertTrue(action.state)
        assertFalse(excluded.state.single().state)
        assertEquals(0, status.state)
    }

    @Test
    fun `strict genre filter only uses lists named for genres`() {
        val order = Choice("Order", arrayOf("Popular", "Action"))
        assertFalse(applySourceGenreFilter(listOf(order), "Action", strict = true))
        assertEquals(0, order.state)
        assertTrue(applySourceGenreFilter(listOf(order), "Action"))
        assertEquals(1, order.state)

        val fantasy = Tri("Fantasy")
        assertTrue(applySourceGenreFilter(listOf(Tris("Gêneros", listOf(Tri("Action"), fantasy))), "Fantasy", strict = true))
        assertEquals(Filter.TriState.STATE_INCLUDE, fantasy.state)
    }

    @Test
    fun `kitsu answers keep only novels with their categories`() {
        val body = """
            {
              "data": [
                {
                  "id": "41",
                  "type": "manga",
                  "attributes": {
                    "canonicalTitle": "Mushoku Tensei",
                    "titles": {"en": "Mushoku Tensei: Jobless Reincarnation", "ja_jp": "無職転生"},
                    "abbreviatedTitles": ["Jobless Reincarnation"],
                    "subtype": "novel",
                    "averageRating": "82.5",
                    "userCount": 4200,
                    "ageRating": "R18",
                    "posterImage": {"medium": "https://example.com/41.jpg"}
                  },
                  "relationships": {"categories": {"data": [{"type": "categories", "id": "7"}]}}
                },
                {
                  "id": "42",
                  "type": "manga",
                  "attributes": {"canonicalTitle": "Berserk", "subtype": "manga"}
                }
              ],
              "included": [
                {"id": "7", "type": "categories", "attributes": {"title": "Fantasy"}}
              ]
            }
        """.trimIndent()
        val novels = parseKitsuNovels(body)
        val novel = novels.single()
        assertEquals(41, novel.id)
        assertEquals("Mushoku Tensei", novel.title)
        assertEquals(82.5, novel.averageRating)
        assertEquals(listOf("Fantasy"), novel.categories)
        assertEquals("https://example.com/41.jpg", novel.coverUrl)
        assertTrue(novel.adult)
        assertSame(novel, matchKitsuNovel("Jobless Reincarnation", novels))
        assertNull(matchKitsuNovel("Lord of Mysteries", novels))
        assertTrue(parseKitsuNovels("not json").isEmpty())

        val provider = kitsuNovelToProvider(novel)
        assertEquals("kitsu", provider.providerId)
        assertEquals(RecommendationProviderKind.TRACKER, provider.kind)
        val candidate = kitsuNovelToRecommendationCandidate(novel, listOf("Fantasy", "Drama"))
        assertEquals("kitsu-novel:41", candidate.id)
        assertEquals(listOf("novel", "Fantasy", "Drama"), candidate.tags)
        assertEquals(RecommendationSafetyLevel.ADULT, candidate.safety)
    }

    @Test
    fun `genre feed reads the taste lists and the first explored genres first`() {
        val feed = buildGenreSourceFeed(
            sourceIds = listOf(1L, 2L),
            tasteGenres = listOf("Action", "Fantasy"),
            exploreGenres = listOf("Horror", "Comedy", "Mystery"),
            novels = false,
        ) { sourceId, genre -> !(sourceId == 2L && genre == "Fantasy") }
        assertEquals(9, feed.cursors.size)
        assertEquals(
            listOf("Action", "Action", "Fantasy"),
            feed.cursors.filter { it.kind == GenreFeedKind.TASTE }.map { it.genre },
        )

        val initial = initialGenreCursors(feed)
        assertEquals(7, initial.size)
        assertFalse(initial.any { it.genre == "Mystery" })

        val read = initial.filter { it.genre == "Horror" }
            .fold(feed) { current, cursor -> current.withCursor(cursor.copy(page = 2)) }
        val scroll = scrollGenreCursors(read, GenreFeedKind.EXPLORE)
        assertEquals(listOf("Comedy", "Comedy", "Mystery", "Mystery", "Horror", "Horror"), scroll.map { it.genre })
        assertTrue(scrollGenreCursors(dropGenreSource(read, 2L), GenreFeedKind.EXPLORE).all { it.sourceId == 1L })
    }

    @Test
    fun `genre entries are tagged and only new ones are kept`() {
        val feed = GenreSourceFeed(novels = true, sourceIds = listOf(1L), tasteGenres = listOf("Action"), exploreGenres = emptyList())
        val withCover = entry("Alpha")
        val noCover = entry("Beta", cover = null)
        val (first, fresh) = addGenreSourceEntries(feed, listOf(withCover, noCover, withCover), "Action", requireCover = true)
        assertEquals(listOf(withCover), fresh)
        assertEquals(listOf(withCover), first.entries)
        assertEquals(listOf("Action"), first.tags[genreEntryKey(noCover)])

        val (second, again) = addGenreSourceEntries(first, listOf(withCover), "fantasy", requireCover = true)
        assertTrue(again.isEmpty())
        assertEquals(listOf("Action", "fantasy"), second.tags[genreEntryKey(withCover)])
        val (third, _) = addGenreSourceEntries(second, listOf(withCover), "ACTION", requireCover = true)
        assertEquals(listOf("Action", "fantasy"), third.tags[genreEntryKey(withCover)])

        val gamma = entry("Gamma")
        val (_, known) = addGenreSourceEntries(first, listOf(gamma), "Action", requireCover = false, known = setOf(genreEntryKey(gamma)))
        assertTrue(known.isEmpty())
    }

    @Test
    fun `dropping a source keeps the works found by title`() {
        val linked = entry("Linked", sourceId = 1L)
        val listed = entry("Listed", sourceId = 1L)
        val other = entry("Other", sourceId = 2L)
        val feed = GenreSourceFeed(
            novels = true,
            sourceIds = listOf(1L, 2L),
            tasteGenres = listOf("Action"),
            exploreGenres = emptyList(),
            cursors = listOf(GenreSourceCursor(1L, "Action", GenreFeedKind.TASTE), GenreSourceCursor(2L, "Action", GenreFeedKind.TASTE)),
            entries = listOf(linked, listed, other),
            tags = listOf(linked, listed, other).associate { genreEntryKey(it) to listOf("Action") },
            linkedKeys = setOf(genreEntryKey(linked)),
        )
        val dropped = dropGenreSource(feed, 1L)
        assertEquals(setOf(1L), dropped.ignoringSources)
        assertEquals(listOf(linked, other), dropped.entries)
        assertEquals(setOf(genreEntryKey(linked), genreEntryKey(other)), dropped.tags.keys)
        assertTrue(dropped.cursors.single { it.sourceId == 1L }.done)
        assertFalse(dropped.cursors.single { it.sourceId == 2L }.done)
    }

    @Test
    fun `misses make a source unusable until it answers`() {
        var feed = GenreSourceFeed(novels = true, sourceIds = listOf(1L), tasteGenres = emptyList(), exploreGenres = emptyList())
        repeat(SEARCH_NOVEL_GENRE_SOURCE_MAX_MISSES) { feed = feed.missed(1L, "list") }
        assertFalse(feed.usable(1L, "list"))
        assertTrue(feed.usable(1L, "search"))
        assertTrue(feed.answered(1L, "list").usable(1L, "list"))
    }

    @Test
    fun `lookups take turns between genres`() {
        val items = listOf(1 to "A", 2 to "A", 3 to "B", 4 to "C")
        assertEquals(listOf(3, 1, 4), interleaveByGenre(items, listOf("B", "A"), 3).map { it.first })
        assertEquals(listOf(3, 1, 4, 2), interleaveByGenre(items, listOf("B", "A"), 10).map { it.first })
    }

    @Test
    fun `novels are searched by their main and latin titles`() {
        assertEquals(
            listOf("Solo Leveling", "Only I Level Up"),
            latinTitleQueries(listOf("Solo Leveling", "solo leveling!", "나 혼자만 레벨업", "Only I Level Up")),
        )
        assertEquals(
            listOf("転生したらスライムだった件", "Tensei Shitara Slime Datta Ken"),
            latinTitleQueries(listOf("転生したらスライムだった件", "Tensei Shitara Slime Datta Ken", "That Time I Got Reincarnated as a Slime")),
        )
    }

    @Test
    fun `only a certain title match is taken`() {
        val items = listOf("Solo Leveling", "Solo Leveling: Ragnarok")
        assertEquals("Solo Leveling", bestCertainTitleMatch(items, listOf("Solo Leveling")) { it })
        assertNull(bestCertainTitleMatch(items, listOf("Omniscient Reader")) { it })
    }

    @Test
    fun `newest tracker scores come first and are capped`() {
        val merged = mergeTrackerScoreResults(
            existing = listOf(tracker("1", "Old A"), tracker("2", "Old B")),
            incoming = listOf(tracker("2", "New B"), tracker("3", "New C")),
        )
        assertEquals(listOf("New B", "New C", "Old A"), merged.map { it.title })
        val many = (1..SEARCH_TRACKER_SCORE_RESULT_CAP + 100).map { tracker("$it", "Work $it") }
        assertEquals(SEARCH_TRACKER_SCORE_RESULT_CAP, mergeTrackerScoreResults(emptyList(), many).size)
    }

    @Test
    fun `known tracker works are recognized by id or title`() {
        val item = tracker("105398", "Solo Leveling").copy(alternativeTitles = listOf("Na Honjaman Level Up"))
        val byTitle = setOf(recommendationTitleKey("Na Honjaman Level Up", RecommendationContentType.MANGA))
        assertTrue(isKnownTrackerResult(item, byTitle, emptySet()))
        assertTrue(isKnownTrackerResult(item, emptySet(), setOf(recommendationTrackerRemoteKey("2", "105398")!!)))
        assertFalse(isKnownTrackerResult(item, emptySet(), emptySet()))
    }

    @Test
    fun `comic genre entries come after the source entries with their genres`() {
        val seed = entry("Alpha", sourceId = 1L)
        val seeds = listOf(seed to true)
        assertSame(seeds, mergeComicGenreEntries(seeds, null))
        val feed = GenreSourceFeed(
            novels = false,
            sourceIds = listOf(2L),
            tasteGenres = listOf("Action"),
            exploreGenres = emptyList(),
            entries = listOf(entry("Alpha", sourceId = 2L), entry("Beta", sourceId = 2L)),
            tags = mapOf(genreEntryKey(seed) to listOf("Action"), genreEntryKey(entry("Beta", sourceId = 2L)) to listOf("Fantasy")),
        )
        val merged = mergeComicGenreEntries(seeds, feed)
        assertEquals(listOf("Alpha", "Beta"), merged.map { it.first.title })
        assertEquals(listOf(1L, 2L), merged.map { it.first.sourceId })
        assertEquals(listOf(true, false), merged.map { it.second })
        assertEquals(listOf("Action"), merged[0].first.genres)
        assertEquals(listOf("Fantasy"), merged[1].first.genres)
    }

    @Test
    fun `novel genre entries are deduped by source work`() {
        val seed = entry("Alpha", sourceId = 1L, isNovel = true)
        val feed = GenreSourceFeed(
            novels = true,
            sourceIds = listOf(1L),
            tasteGenres = listOf("Fantasy"),
            exploreGenres = emptyList(),
            entries = listOf(seed, entry("Beta", sourceId = 1L, isNovel = true)),
        )
        assertEquals(listOf("Alpha", "Beta"), mergeNovelGenreEntries(listOf(seed), feed).map { it.title })
        assertEquals(listOf(seed), mergeNovelGenreEntries(listOf(seed), null))
    }

    @Test
    fun `kitsu feed reads today's rare genres and keeps the rest for later`() {
        val feed = initialKitsuNovelFeed(profile(), rotation = 0)
        val include = explorationGenres(profile(), KITSU_NOVEL_EXPLORE_GENRE_LIMIT, 0)!!.include
        assertEquals(include, feed.explore.map { it.category })
        assertTrue(feed.explore.all { it.limit == KITSU_NOVEL_EXPLORE_PER_GENRE && it.offset == 0 && !it.done })
        assertTrue(feed.later.isNotEmpty())
        assertTrue(feed.later.none { it in include })
        assertTrue("action" in feed.usualGenres)
        assertTrue(feed.taste.size <= KITSU_NOVEL_TASTE_CATEGORY_LIMIT)

        val read = feed.withCursor(GenreFeedKind.EXPLORE, feed.explore.first().copy(offset = 20, done = true))
        assertTrue(read.explore.first().done)
        assertEquals(feed.explore.drop(1), read.explore.drop(1))
    }

    @Test
    fun `rows map to their genre feeds`() {
        assertEquals(GenreFeedKind.EXPLORE, genreFeedKind(DiscoverMode.COMICS, RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS))
        assertNull(genreFeedKind(DiscoverMode.NOVELS, RecommendationSectionKey.FRESH_IN_YOUR_SOURCES))
        assertNull(genreFeedKind(DiscoverMode.COMICS, RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE))
        assertEquals(GenreFeedKind.TASTE, genreFeedKind(DiscoverMode.NOVELS, RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE))
        assertEquals(GenreFeedKind.TASTE, genreFeedKind(DiscoverMode.COMICS, RecommendationSectionKey.HIGH_CONFIDENCE))
    }

    @Test
    fun `a row is not exhausted while its genre feeds have lists left`() {
        val genreFeed = GenreSourceFeed(
            novels = false,
            sourceIds = listOf(1L),
            tasteGenres = listOf("Action"),
            exploreGenres = listOf("Horror"),
            cursors = listOf(
                GenreSourceCursor(1L, "Action", GenreFeedKind.TASTE, done = true),
                GenreSourceCursor(1L, "Horror", GenreFeedKind.EXPLORE),
            ),
        )
        val comics = pool(DiscoverMode.COMICS).copy(genreFeed = genreFeed)
        assertTrue(hasGenreFeedLeft(comics, GenreFeedKind.EXPLORE))
        assertFalse(hasGenreFeedLeft(comics, GenreFeedKind.TASTE))
        assertFalse(hasGenreFeedLeft(comics.copy(genreFeed = dropGenreSource(genreFeed, 1L)), GenreFeedKind.EXPLORE))

        val kitsu = KitsuNovelFeed(
            taste = listOf(KitsuNovelFeedCursor("Fantasy", 20, done = true)),
            explore = emptyList(),
            later = listOf("Horror"),
        )
        val novels = pool(DiscoverMode.NOVELS).copy(kitsuFeed = kitsu)
        assertTrue(hasGenreFeedLeft(novels, GenreFeedKind.EXPLORE))
        assertFalse(hasGenreFeedLeft(novels, GenreFeedKind.TASTE))
    }

    @Test
    fun `a tracker work found in an extension merges with its source work`() {
        val source = entry("Solo Leveling", sourceId = 1L)
        val feed = GenreSourceFeed(
            novels = false,
            sourceIds = listOf(1L),
            tasteGenres = listOf("Action"),
            exploreGenres = emptyList(),
            entries = listOf(source),
            tags = mapOf(genreEntryKey(source) to listOf("Action")),
            trackerLinks = listOf(tracker("105398", "Solo Leveling").copy(score = 85.0)),
        )
        val candidates = assembleDiscoverCandidates(pool(DiscoverMode.COMICS).copy(genreFeed = feed))
        val merged = candidates.single { it.title == "Solo Leveling" }
        assertTrue(merged.providers.any { it.kind == RecommendationProviderKind.SOURCE })
        assertTrue(merged.providers.any { it.kind == RecommendationProviderKind.TRACKER && it.remoteId == "105398" })
        assertTrue(merged.tags.any { it.equals("action", ignoreCase = true) })
    }

    @Test
    fun `a novel found for a kitsu work carries kitsu's rating and categories`() {
        val source = entry("Mushoku Tensei", sourceId = 3L, isNovel = true)
        val kitsuProvider = RecommendationProviderSignal(
            providerId = "kitsu",
            providerName = "Kitsu",
            kind = RecommendationProviderKind.TRACKER,
            remoteId = "41",
        )
        val key = recommendationTitleKey("Mushoku Tensei", RecommendationContentType.NOVEL)
        val feed = GenreSourceFeed(
            novels = true,
            sourceIds = listOf(3L),
            tasteGenres = listOf("Fantasy"),
            exploreGenres = emptyList(),
            entries = listOf(source),
            linkedKeys = setOf(genreEntryKey(source)),
            kitsuLinks = mapOf(key to KitsuSourceLink(kitsuProvider, listOf("Isekai"))),
        )
        val discovered = kitsuNovelToRecommendationCandidate(
            KitsuNovel(id = 77, title = "Lord of Mysteries", mainTitles = listOf("Lord of Mysteries"), titles = listOf("Lord of Mysteries")),
        )
        val kitsu = KitsuNovelFeed(taste = emptyList(), explore = emptyList(), discovered = mapOf(77 to discovered))
        val candidates = assembleDiscoverCandidates(pool(DiscoverMode.NOVELS).copy(genreFeed = feed, kitsuFeed = kitsu))
        val novel = candidates.single { it.title == "Mushoku Tensei" }
        assertTrue(novel.providers.any { it.providerId == "kitsu" && it.remoteId == "41" })
        assertTrue(novel.tags.any { it.equals("isekai", ignoreCase = true) })
        assertTrue(candidates.any { it.title == "Lord of Mysteries" })
    }
}
