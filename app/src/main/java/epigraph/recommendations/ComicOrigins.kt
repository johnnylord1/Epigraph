package epigraph.recommendations

import android.content.Context
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.network.NetworkHelper
import java.io.File
import java.util.Locale
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/** Desktop `comicTypeFromCountry`: the publisher's country of origin. */
fun comicTypeFromCountry(country: String?): RecommendationContentType? =
    when (country?.trim()?.uppercase(Locale.ROOT)) {
        "KR" -> RecommendationContentType.MANHWA
        "CN", "TW", "HK" -> RecommendationContentType.MANHUA
        "JP" -> RecommendationContentType.MANGA
        else -> null
    }

/** Cache key of a tracker entry, `trackerId:remoteId`. */
fun comicOriginTrackKey(trackerId: Long, remoteId: Long) = "$trackerId:$remoteId"

/** Cache key of a library title. */
fun comicOriginTitleKey(title: String) = recommendationTitleKey(title, RecommendationContentType.MANGA)

/**
 * The country AniList gives a library title, or "" when it cannot tell for sure: only results
 * whose title or synonym is the same title count, and they must all come from one country.
 */
fun exactTitleCountry(title: String, results: List<AniListTitleResult>): String {
    val key = comparableRecommendationTitle(title)
    if (key.isEmpty()) return ""
    val countries = results
        .filter { result -> result.titles.any { comparableRecommendationTitle(it) == key } }
        .map { it.country.trim().uppercase(Locale.ROOT) }
        .toSet()
    return countries.singleOrNull()?.takeIf { comicTypeFromCountry(it) != null } ?: ""
}

data class AniListTitleResult(val titles: List<String>, val country: String)

/** The countries known for a Discover visit: by tracker entry first, then by library title. */
class ComicOrigins(
    private val byTrack: Map<String, String>,
    private val byTitle: Map<String, String>,
) {
    /** The format of a work with these tracker entries ([comicOriginTrackKey]) and title, if known. */
    fun of(trackKeys: List<String>, title: String): RecommendationContentType? =
        trackKeys.firstNotNullOfOrNull { byTrack[it]?.let(::comicTypeFromCountry) }
            ?: byTitle[comicOriginTitleKey(title)]?.let(::comicTypeFromCountry)

    companion object {
        val NONE = ComicOrigins(emptyMap(), emptyMap())
    }
}

/**
 * Desktop `comicOriginForRecords` + the library's AniList lookup: which comic format a work is,
 * from the publisher's country. Source and tag guesses call most aggregator manhwa "manga", so
 * without this a manhwa reader's profile reads as a manga reader's and Discover opens with manga.
 *
 * Tracker entries are looked up by id (AniList, or MyAnimeList through AniList's `idMal`). Untracked
 * works are searched by title and only an exact, single-country match is kept. Answers, misses
 * included, are kept in a small file so each work is asked once; misses are asked again after
 * [MISS_RETRY_MS]. Nothing is tracked: the country only feeds the recommendation profile.
 */
class ComicOriginLookup(
    private val store: ComicOriginStore,
    /** Posts a GraphQL payload to AniList; null when the request failed or timed out. */
    private val post: suspend (String) -> String?,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /** Countries already known for [trackKeys] (see [comicOriginTrackKey]); "" entries are left out. */
    suspend fun cachedTracks(trackKeys: Collection<String>): Map<String, String> =
        store.read { data -> trackKeys.mapNotNull { key -> data.tracks[key]?.country?.takeIf { it.isNotEmpty() }?.let { key to it } }.toMap() }

    /** Countries already known for [titles], keyed by [comicOriginTitleKey]. */
    suspend fun cachedTitles(titles: Collection<String>): Map<String, String> =
        store.read { data ->
            titles.map(::comicOriginTitleKey).mapNotNull { key ->
                data.titles[key]?.country?.takeIf { it.isNotEmpty() }?.let { key to it }
            }.toMap()
        }

    /**
     * Asks AniList for the tracker entries not answered yet. [tracks] are (trackerId, remoteId);
     * only AniList and MyAnimeList entries can be asked. Stops at the first failed request.
     */
    suspend fun refreshTracks(tracks: Collection<Pair<Long, Long>>) {
        val due = store.read { data -> tracks.filter { (tracker, id) -> isDue(data.tracks[comicOriginTrackKey(tracker, id)]) } }
        for (tracker in listOf(TrackManager.ANILIST, TrackManager.MYANIMELIST)) {
            val ids = due.filter { it.first == tracker && it.second > 0 }.map { it.second }.distinct()
            for (chunk in ids.chunked(ID_BATCH_SIZE)) {
                val body = post(idQuery(tracker, chunk)) ?: return
                val found = parseIdCountries(body, tracker) ?: return
                val checkedAt = now()
                store.write { data ->
                    chunk.forEach { id ->
                        data.tracks[comicOriginTrackKey(tracker, id)] = OriginEntry(found[id].orEmpty(), checkedAt)
                    }
                }
            }
        }
    }

    /**
     * Searches AniList for the [titles] not answered yet, in order, using at most [maxRequests]
     * requests. Stops at the first failed request.
     */
    suspend fun refreshTitles(titles: List<String>, maxRequests: Int) {
        val due = store.read { data ->
            titles.filter { comparableRecommendationTitle(it).isNotEmpty() }
                .distinctBy(::comicOriginTitleKey)
                .filter { isDue(data.titles[comicOriginTitleKey(it)]) }
        }
        for (chunk in due.chunked(TITLE_BATCH_SIZE).take(maxRequests)) {
            val body = post(titleQuery(chunk)) ?: return
            val found = parseTitleResults(body, chunk.size) ?: return
            val checkedAt = now()
            store.write { data ->
                chunk.forEachIndexed { i, title ->
                    data.titles[comicOriginTitleKey(title)] = OriginEntry(exactTitleCountry(title, found[i].orEmpty()), checkedAt)
                }
            }
        }
    }

    private fun isDue(entry: OriginEntry?): Boolean =
        entry == null || (entry.country.isEmpty() && now() - entry.checkedAtMs >= MISS_RETRY_MS)

    companion object {
        internal const val ID_BATCH_SIZE = 50
        internal const val TITLE_BATCH_SIZE = 10
        internal const val MISS_RETRY_MS = 14L * 24 * 60 * 60 * 1000
        private const val REQUEST_TIMEOUT_MS = 8_000L

        fun create(context: Context, network: NetworkHelper = Injekt.get()) = ComicOriginLookup(
            store = ComicOriginStore(File(File(context.noBackupFilesDir, "recommendations"), "comic-origins-v1.json")),
            post = { payload -> AniListGate.shared.post(network.client, payload, AniListGate.Priority.LOOKUP, REQUEST_TIMEOUT_MS) },
        )
    }
}

internal fun idQuery(tracker: Long, ids: List<Long>): String {
    val filter = if (tracker == TrackManager.MYANIMELIST) "idMal_in" else "id_in"
    return buildJsonObject {
        put("query", "query (\$ids: [Int]) { Page(page: 1, perPage: ${ids.size}) { media($filter: \$ids, type: MANGA) { id idMal countryOfOrigin } } }")
        putJsonObject("variables") { putJsonArray("ids") { ids.forEach { add(it) } } }
    }.toString()
}

internal fun titleQuery(titles: List<String>): String {
    val defs = titles.indices.joinToString(", ") { "\$s$it: String" }
    val pages = titles.indices.joinToString(" ") { i ->
        "q$i: Page(page: 1, perPage: 8) { media(type: MANGA, format_not_in: [NOVEL], search: \$s$i) { countryOfOrigin title { romaji english native } synonyms } }"
    }
    return buildJsonObject {
        put("query", "query ($defs) { $pages }")
        putJsonObject("variables") { titles.forEachIndexed { i, title -> put("s$i", title) } }
    }.toString()
}

/** `remoteId -> country` from an id query; null when the answer is not a media page. */
internal fun parseIdCountries(body: String, tracker: Long): Map<Long, String>? {
    val media = runCatching {
        Json.parseToJsonElement(body).jsonObject["data"]?.jsonObject?.get("Page")?.jsonObject?.get("media") as? JsonArray
    }.getOrNull() ?: return null
    val idField = if (tracker == TrackManager.MYANIMELIST) "idMal" else "id"
    return media.mapNotNull { element ->
        val item = element as? JsonObject ?: return@mapNotNull null
        val id = item[idField]?.longValue() ?: return@mapNotNull null
        id to (item["countryOfOrigin"]?.stringValue() ?: "")
    }.toMap()
}

/** The results of each `qN` alias of a title query; null when the answer has no data. */
internal fun parseTitleResults(body: String, count: Int): List<List<AniListTitleResult>>? {
    val data = runCatching { Json.parseToJsonElement(body).jsonObject["data"] as? JsonObject }.getOrNull() ?: return null
    return (0 until count).map { i ->
        val media = data["q$i"]?.let { it as? JsonObject }?.get("media") as? JsonArray ?: return@map emptyList()
        media.mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val title = item["title"] as? JsonObject
            val titles = listOfNotNull(
                title?.get("romaji")?.stringValue(),
                title?.get("english")?.stringValue(),
                title?.get("native")?.stringValue(),
            ) + (item["synonyms"] as? JsonArray)?.mapNotNull { it.stringValue() }.orEmpty()
            AniListTitleResult(titles, item["countryOfOrigin"]?.stringValue() ?: "")
        }
    }
}

private fun JsonElement.stringValue(): String? =
    runCatching { jsonPrimitive.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() } }.getOrNull()

private fun JsonElement.longValue(): Long? = runCatching { jsonPrimitive.longOrNull }.getOrNull()

@Serializable
data class OriginEntry(val country: String, val checkedAtMs: Long)

@Serializable
data class ComicOriginData(
    val tracks: MutableMap<String, OriginEntry> = mutableMapOf(),
    val titles: MutableMap<String, OriginEntry> = mutableMapOf(),
)

/**
 * The lookup's answers, in `noBackupFilesDir`: a cache of public AniList data, so it never enters a
 * backup or a restore, and a bad or missing file only means asking again.
 */
class ComicOriginStore(private val file: File?) {
    private val lock = Mutex()
    private var data: ComicOriginData? = null

    suspend fun <T> read(block: (ComicOriginData) -> T): T = lock.withLock { block(loaded()) }

    suspend fun write(block: (ComicOriginData) -> Unit) = lock.withLock {
        val current = loaded()
        block(current)
        trim(current.tracks)
        trim(current.titles)
        save(current)
    }

    private fun loaded(): ComicOriginData = data ?: (
        runCatching {
            file?.takeIf { it.isFile && it.length() <= MAX_FILE_BYTES }?.readText()?.let { json.decodeFromString(ComicOriginData.serializer(), it) }
        }.getOrNull() ?: ComicOriginData()
        ).also { data = it }

    private fun trim(entries: MutableMap<String, OriginEntry>) {
        if (entries.size <= MAX_ENTRIES) return
        entries.entries.sortedBy { it.value.checkedAtMs }.take(entries.size - MAX_ENTRIES).map { it.key }.forEach(entries::remove)
    }

    private fun save(value: ComicOriginData) {
        val target = file ?: return
        runCatching {
            val directory = target.parentFile ?: return
            if (!directory.exists()) directory.mkdirs()
            val part = File(directory, "${target.name}.part")
            part.writeText(json.encodeToString(ComicOriginData.serializer(), value))
            if (!part.renameTo(target)) {
                target.delete()
                if (!part.renameTo(target)) part.delete()
            }
        }
    }

    private companion object {
        const val MAX_ENTRIES = 6000
        const val MAX_FILE_BYTES = 2L * 1024 * 1024
        val json = Json { ignoreUnknownKeys = true }
    }
}
