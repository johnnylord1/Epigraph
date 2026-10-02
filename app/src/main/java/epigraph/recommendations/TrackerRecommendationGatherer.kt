package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.network.jsonMime
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlinx.serialization.json.putJsonArray
import okhttp3.RequestBody.Companion.toRequestBody
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

class TrackerRecommendationGatherer(
    private val trackManager: TrackManager = Injekt.get(),
    private val network: NetworkHelper = Injekt.get(),
) {
    data class Result(val trending: List<TrackerCatalogInput>, val scores: List<TrackerCatalogInput>, val failed: List<String>)

    /**
     * Phone port of the desktop `refreshSearchTrackerTrendingFeed` (BrowseV3 4708) and
     * `refreshSearchTrackerScores` (4633). The desktop's 850-950 ms per-request timeouts
     * become [TRACKER_TIMEOUT_MS] (8 s) on the phone.
     *
     * Trending is the AniList catalog pages 1-2 plus the desktop's 250 ms prefetch of pages
     * 3-4, fetched eagerly here. MAL trending is skipped: the phone API has no ranking
     * endpoint (the desktop uses Jikan `top/manga`).
     *
     * Scores are AniList lookups for [trackerScoreTitles] plus a MAL `search` fallback for
     * the first [TRACKER_SCORE_MAL_FALLBACK_LIMIT] titles AniList did not match. Each
     * tracker failure is recorded in [Result.failed] instead of throwing.
     */
    suspend fun gather(comicPoolTitles: List<String>): Result = coroutineScope {
        val failed = mutableListOf<String>()

        val trending = async {
            val pages = listOf(1, 2, 3, 4).map { page ->
                async { runCatching { fetchAniListCatalog(page) }.getOrDefault(emptyList()) }
            }.awaitAll()
            if (pages.all { it.isEmpty() }) synchronized(failed) { failed += "AniList" }
            capProviderResults(dedupeTrackSearches(pages.flatten()))
        }

        val scoreTitles = trackerScoreTitles(comicPoolTitles)
        val scores = async {
            val scoreMap = linkedMapOf<String, TrackerCatalogInput>()
            val anilistScores = runCatching { fetchAniListScoresByTitles(scoreTitles) }
                .onFailure { synchronized(failed) { failed += "AniList" } }
                .getOrDefault(emptyList())
            for (input in anilistScores) {
                scoreMap.putIfAbsent(trackerScoreSearchKey(input.trackerId.toString(), input.title), input)
            }

            if (trackManager.myAnimeList.isLogged && !malTrackerPause.isPaused()) {
                val covered = scoreMap.values.mapTo(mutableSetOf()) {
                    recommendationTitleKey(it.title, RecommendationContentType.MANGA)
                }
                val fallbackTitles = scoreTitles
                    .filter { title -> recommendationTitleKey(title, RecommendationContentType.MANGA) !in covered }
                    .take(TRACKER_SCORE_MAL_FALLBACK_LIMIT)
                for (title in fallbackTitles) {
                    val match = runCatching { fetchMalScoreByTitle(title) }
                        .onFailure { malTrackerPause.pause() }
                        .getOrNull()
                    if (match != null) {
                        scoreMap.putIfAbsent(trackerScoreSearchKey(match.trackerId.toString(), match.title), match)
                    }
                }
            }
            capProviderResults(scoreMap.values.toList())
        }

        Result(trending.await(), scores.await(), failed.distinct())
    }

    /**
     * Desktop `fetchAniListTrackerCatalog` (BrowseV3 4179): comics only
     * (`format_not_in: [NOVEL]`), sorted by [anilistSortForFeed].
     */
    private suspend fun fetchAniListCatalog(page: Int): List<TrackerCatalogInput> {
        val query = """
            query(${'$'}page: Int!, ${'$'}perPage: Int!, ${'$'}sort: [MediaSort]) {
              Page(page: ${'$'}page, perPage: ${'$'}perPage) {
                media(type: MANGA, sort: ${'$'}sort, isAdult: false, format_not_in: [NOVEL]) {
                  id title { romaji english native } coverImage { large extraLarge } siteUrl status format
                  countryOfOrigin chapters averageScore meanScore popularity trending genres startDate { year month day }
                }
              }
            }
        """.trimIndent()
        val payload = buildJsonObject {
            put("query", query)
            putJsonObject("variables") {
                put("page", page)
                put("perPage", ANILIST_PAGE_SIZE)
                putJsonArray("sort") { anilistSortForFeed().forEach { add(it) } }
            }
        }
        val body = withTimeoutOrNull(TRACKER_TIMEOUT_MS) {
            network.client.newCall(POST(ANILIST_URL, body = payload.toString().toRequestBody(jsonMime)))
                .awaitSuccess()
                .use { it.body.string() }
        } ?: error("AniList catalog timed out")
        val media = Json.parseToJsonElement(body).jsonObject["data"]?.jsonObject
            ?.get("Page")?.jsonObject?.get("media") as? JsonArray ?: return emptyList()
        val trackerName = "AniList"
        return media.mapNotNull { (it as? JsonObject)?.toAniListInput(trackerName) }
    }

    /**
     * Desktop `fetchAniListTrackerScoresByTitles` (BrowseV3 4353): one GraphQL request per
     * [TRACKER_SCORE_BATCH_SIZE] titles, with `q0`...`qN` aliases.
     */
    private suspend fun fetchAniListScoresByTitles(titles: List<String>): List<TrackerCatalogInput> {
        val results = mutableListOf<TrackerCatalogInput>()
        val trackerName = "AniList"
        for (chunk in titles.chunked(TRACKER_SCORE_BATCH_SIZE)) {
            val variableDefs = chunk.indices.joinToString(", ") { "\$search$it: String!" }
            val pages = chunk.indices.joinToString("\n") { i ->
                """
                q$i: Page(page: 1, perPage: 5) {
                  media(type: MANGA, search: ${'$'}search$i, isAdult: false) {
                    id title { romaji english native } coverImage { large extraLarge } siteUrl status format
                    countryOfOrigin chapters averageScore meanScore popularity trending genres startDate { year month day }
                  }
                }
                """.trimIndent()
            }
            val query = "query SearchTrackerScores($variableDefs) { $pages }"
            val payload = buildJsonObject {
                put("query", query)
                putJsonObject("variables") { chunk.forEachIndexed { i, title -> put("search$i", title) } }
            }
            val body = withTimeoutOrNull(TRACKER_TIMEOUT_MS) {
                network.client.newCall(POST(ANILIST_URL, body = payload.toString().toRequestBody(jsonMime)))
                    .awaitSuccess()
                    .use { it.body.string() }
            } ?: continue
            val data = runCatching { Json.parseToJsonElement(body).jsonObject }.getOrNull() ?: continue
            chunk.forEachIndexed { i, title ->
                val media = data["data"]?.jsonObject?.get("q$i")?.jsonObject?.get("media") as? JsonArray
                    ?: return@forEachIndexed
                val candidates = media.mapNotNull { element ->
                    (element as? JsonObject)?.let { item ->
                        val candidateTitle = (item["title"] as? JsonObject)
                            ?.let { t -> t["english"]?.primitiveString() ?: t["romaji"]?.primitiveString() ?: t["native"]?.primitiveString() }
                            ?: return@let null
                        candidateTitle to item
                    }
                }
                val match = bestTitleMatch(title, candidates)
                    ?: candidates.firstOrNull { it.second["averageScore"] != null || it.second["meanScore"] != null }
                    ?: candidates.firstOrNull()
                if (match != null) {
                    val input = match.second.toAniListInput(trackerName, title)
                    if (input != null) results.add(input)
                }
            }
        }
        return results
    }

    /**
     * Desktop `fetchTrackerScoreByTitle` (BrowseV3 4448), MAL branch: the phone API has no
     * Jikan search, so the authenticated MAL `search` is used instead. Any failure (HTTP 429
     * included) pauses MAL requests via [malTrackerPause].
     */
    private suspend fun fetchMalScoreByTitle(title: String): TrackerCatalogInput? {
        val candidates = trackManager.myAnimeList.search(title).map { it.title to it }
        val match = bestTitleMatch(title, candidates)
            ?: candidates.firstOrNull { it.second.score > 0f }
            ?: candidates.firstOrNull()
            ?: return null
        return match.second.toMalInput(match.first)
    }

    private fun <T> bestTitleMatch(title: String, candidates: List<Pair<String, T>>): Pair<String, T>? {
        return candidates
            .map { candidate -> candidate to trackerTitleMatchScore(title, candidate.first) }
            .filter { it.second >= 0.8 }
            .maxByOrNull { it.second }
            ?.first
    }

    private fun JsonObject.toAniListInput(trackerName: String, titleOverride: String? = null): TrackerCatalogInput? {
        val id = this["id"]?.primitiveInt() ?: return null
        val titles = this["title"] as? JsonObject
        val english = titles?.get("english")?.primitiveString()
        val romaji = titles?.get("romaji")?.primitiveString()
        val native = titles?.get("native")?.primitiveString()
        val title = titleOverride ?: english ?: romaji ?: native ?: return null
        val cover = (this["coverImage"] as? JsonObject)?.let {
            it["extraLarge"]?.primitiveString() ?: it["large"]?.primitiveString()
        }
        val format = this["format"]?.primitiveString()
        val publishingType = when (this["countryOfOrigin"]?.primitiveString()) {
            "KR" -> "MANHWA"
            "CN", "TW" -> "MANHUA"
            "JP" -> if (format == "NOVEL") "NOVEL" else "MANGA"
            else -> format
        }.let { if (format == "NOVEL") "NOVEL" else it }
        val start = this["startDate"] as? JsonObject
        val startMs = start?.get("year")?.primitiveInt()?.let { year ->
            runCatching {
                LocalDate.of(year, start["month"]?.primitiveInt() ?: 1, start["day"]?.primitiveInt() ?: 1)
                    .atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
            }.getOrNull()
        }
        return TrackerCatalogInput(
            trackerId = TrackManager.ANILIST,
            trackerName = trackerName,
            remoteId = id.toString(),
            title = title,
            alternativeTitles = listOfNotNull(english, romaji, native),
            coverUrl = cover,
            genres = (this["genres"] as? JsonArray)?.mapNotNull { it.primitiveString() }.orEmpty(),
            publishingType = publishingType,
            publishingStatus = this["status"]?.primitiveString(),
            score = (this["averageScore"]?.primitiveDouble() ?: this["meanScore"]?.primitiveDouble()),
            scoreMax = 100.0,
            popularity = this["popularity"]?.primitiveDouble(),
            trending = this["trending"]?.primitiveDouble(),
            startDateMs = startMs,
        )
    }

    private fun TrackSearch.toMalInput(titleOverride: String): TrackerCatalogInput {
        return TrackerCatalogInput(
            trackerId = TrackManager.MYANIMELIST,
            trackerName = "MyAnimeList",
            remoteId = media_id.toString(),
            title = titleOverride,
            coverUrl = cover_url.ifBlank { null },
            publishingType = publishing_type.ifBlank { null },
            publishingStatus = publishing_status.ifBlank { null },
            score = if (score > 0f) score.toDouble() else null,
            startDateMs = runCatching {
                LocalDate.parse(start_date).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli()
            }.getOrNull(),
        )
    }

    private fun JsonElement.primitiveString(): String? =
        runCatching { jsonPrimitive.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() } }.getOrNull()

    private fun JsonElement.primitiveInt(): Int? = runCatching { jsonPrimitive.intOrNull }.getOrNull()

    private fun JsonElement.primitiveDouble(): Double? = runCatching { jsonPrimitive.doubleOrNull }.getOrNull()

    companion object {
        private const val ANILIST_URL = "https://graphql.anilist.co"
        private const val ANILIST_PAGE_SIZE = 40
        /** Desktop BrowseV3 uses 850-950 ms per tracker request; the phone gets 8 s. */
        private const val TRACKER_TIMEOUT_MS = 8_000L
    }
}

internal const val TRACKER_SCORE_ENRICHMENT_LIMIT = 32
internal const val TRACKER_SCORE_BATCH_SIZE = 12
internal const val TRACKER_SCORE_MAL_FALLBACK_LIMIT = 3
internal const val TRACKER_SCORE_MAL_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000L
internal const val SEARCH_RECOMMENDATION_PROVIDER_RESULT_CAP = 120

internal fun <T> capProviderResults(items: List<T>): List<T> = items.take(SEARCH_RECOMMENDATION_PROVIDER_RESULT_CAP)

internal fun trackerScoreTitles(titles: List<String>): List<String> {
    val seen = mutableSetOf<String>()
    return titles
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .filter { title ->
            val key = recommendationTitleKey(title, RecommendationContentType.MANGA)
            if (key in seen) false else {
                seen.add(key)
                true
            }
        }
        .take(TRACKER_SCORE_ENRICHMENT_LIMIT)
}

internal fun dedupeTrackSearches(items: List<TrackerCatalogInput>): List<TrackerCatalogInput> {
    val seen = mutableSetOf<String>()
    val result = mutableListOf<TrackerCatalogInput>()
    for (item in items) {
        val key = if (item.remoteId.isNotEmpty()) "${item.trackerId}:${item.remoteId}" else "${item.trackerId}:${item.title.lowercase()}"
        if (key in seen) continue
        seen.add(key)
        result.add(item)
    }
    return result
}

internal fun anilistSortForFeed(): List<String> = listOf("TRENDING_DESC", "POPULARITY_DESC")

internal fun trackerScoreSearchKey(trackerId: String, title: String, contentType: RecommendationContentType = RecommendationContentType.MANGA) = "$trackerId:${recommendationTitleKey(title, contentType)}"

internal fun comparableRecommendationTitle(title: String): String =
    recommendationTitleKey(title, RecommendationContentType.MANGA)
        .removePrefix("comic:")
        .replace(Regex("\\b(the|a|an)\\b"), "")
        .replace(Regex("\\s+"), "")

internal fun trackerTitleMatchScore(queryTitle: String, resultTitle: String?): Double {
    val query = comparableRecommendationTitle(queryTitle)
    val result = comparableRecommendationTitle(resultTitle ?: "")
    if (query.isEmpty() || result.isEmpty()) return 0.0
    if (query == result) return 1.0
    if (query.length >= 10 && result.length >= 10 && (query.contains(result) || result.contains(query))) return 0.82
    return 0.0
}

internal class MalTrackerPause(private val now: () -> Long = System::currentTimeMillis) {
    private var pausedUntil: Long = 0L

    fun isPaused(): Boolean = now() < pausedUntil

    fun pause() {
        pausedUntil = now() + TRACKER_SCORE_MAL_RATE_LIMIT_COOLDOWN_MS
    }
}

internal val malTrackerPause = MalTrackerPause()
