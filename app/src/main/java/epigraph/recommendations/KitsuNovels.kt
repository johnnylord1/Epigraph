package epigraph.recommendations

import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.awaitSuccess
import java.io.IOException
import java.net.URLEncoder
import java.time.LocalDate
import java.time.ZoneOffset
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import okhttp3.Headers.Companion.headersOf
import uy.kohesive.injekt.Injekt
import uy.kohesive.injekt.api.get

/**
 * Kitsu's novel catalogue (desktop `kitsuNovels.ts`): light novels and web novels, public and
 * without an account. The novel section uses it to rate and discover novels next to Hardcover.
 * AniList is never asked about novels.
 */
data class KitsuNovel(
    val id: Int,
    val title: String,
    /** The work's own names (canonical, romaji, English, native). */
    val mainTitles: List<String>,
    /** Its own names followed by the abbreviations. */
    val titles: List<String>,
    /** Kitsu's average rating, 0-100; null until enough users rated it. */
    val averageRating: Double? = null,
    val userCount: Double? = null,
    val popularityRank: Double? = null,
    val categories: List<String> = emptyList(),
    val credits: List<String> = emptyList(),
    val coverUrl: String? = null,
    val startDate: String? = null,
    val status: String? = null,
    val adult: Boolean = false,
)

private const val KITSU_API = "https://kitsu.io/api/edge/manga"
private const val KITSU_REQUEST_TIMEOUT_MS = 8_000L
private const val KITSU_MAX_TITLES = 16
// Kitsu's most read novels have a few tens of thousands of readers.
private const val KITSU_POPULAR_USER_COUNT = 30_000.0
private const val KITSU_RANKED_NOVELS = 25_000
private const val KITSU_CACHE_MAX_QUERIES = 300
private const val KITSU_CACHE_TTL_MS = 3 * 24 * 60 * 60 * 1000L

private val KITSU_NOVEL_FIELDS = listOf(
    "fields%5Bmanga%5D=canonicalTitle,titles,abbreviatedTitles,subtype,averageRating,userCount,popularityRank,startDate,status,ageRating,posterImage,categories,staff",
    "fields%5Bcategories%5D=title",
    "fields%5BmediaStaff%5D=person",
    "fields%5Bpeople%5D=name",
    "include=categories,staff.person",
)

private fun cleanList(values: List<String?>): List<String> =
    values.mapNotNull { it?.trim()?.takeIf(String::isNotEmpty) }.distinct()

private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.contentOrNull

private fun JsonElement?.finiteNumber(): Double? {
    val primitive = this as? JsonPrimitive ?: return null
    val value = if (primitive.isString) primitive.content.trim().toDoubleOrNull() else primitive.doubleOrNull
    return value?.takeIf { it.isFinite() }
}

/** The novels of a Kitsu answer; works of any other kind are left out. */
internal fun parseKitsuNovels(body: String): List<KitsuNovel> {
    val root = runCatching { Json.parseToJsonElement(body) as? JsonObject }.getOrNull() ?: return emptyList()
    val included = (root["included"] as? JsonArray).orEmpty()
        .mapNotNull { it as? JsonObject }
        .associateBy { "${it["type"].text()}:${it["id"].text()}" }
    // A to-many relationship holds a list; a to-one relationship, such as a staff credit's person, one reference.
    fun resources(owner: JsonObject, name: String): List<JsonObject> {
        val data = ((owner["relationships"] as? JsonObject)?.get(name) as? JsonObject)?.get("data")
        val refs = when (data) {
            is JsonArray -> data.mapNotNull { it as? JsonObject }
            is JsonObject -> listOf(data)
            else -> emptyList()
        }
        return refs.mapNotNull { included["${it["type"].text()}:${it["id"].text()}"] }
    }
    return (root["data"] as? JsonArray).orEmpty().mapNotNull { element ->
        val item = element as? JsonObject ?: return@mapNotNull null
        val attributes = item["attributes"] as? JsonObject ?: JsonObject(emptyMap())
        val id = item["id"].text()?.toIntOrNull() ?: return@mapNotNull null
        if (attributes["subtype"].text()?.lowercase() != "novel" || id <= 0) return@mapNotNull null
        val titleMap = (attributes["titles"] as? JsonObject)?.values?.map { it.text() }.orEmpty()
        val mainTitles = cleanList(listOf(attributes["canonicalTitle"].text()) + titleMap)
        if (mainTitles.isEmpty()) return@mapNotNull null
        val abbreviations = (attributes["abbreviatedTitles"] as? JsonArray)?.map { it.text() }.orEmpty()
        val poster = attributes["posterImage"] as? JsonObject
        KitsuNovel(
            id = id,
            title = mainTitles.first(),
            mainTitles = mainTitles,
            titles = cleanList(mainTitles + abbreviations).take(KITSU_MAX_TITLES),
            averageRating = attributes["averageRating"].finiteNumber(),
            userCount = attributes["userCount"].finiteNumber(),
            popularityRank = attributes["popularityRank"].finiteNumber(),
            categories = cleanList(resources(item, "categories").map { (it["attributes"] as? JsonObject)?.get("title").text() }),
            credits = cleanList(
                resources(item, "staff")
                    .flatMap { resources(it, "person") }
                    .map { (it["attributes"] as? JsonObject)?.get("name").text() },
            ),
            coverUrl = poster?.let { it["medium"].text() ?: it["small"].text() ?: it["original"].text() }?.takeIf { it.isNotEmpty() },
            startDate = attributes["startDate"].text(),
            status = attributes["status"].text(),
            adult = attributes["ageRating"].text()?.uppercase() == "R18",
        )
    }
}

/**
 * The novel a title names among Kitsu's answers, or null. Like the tracker score lookups, only a
 * certain title match counts: a work Kitsu may not know is left unrated rather than guessed.
 */
internal fun matchKitsuNovel(title: String, novels: List<KitsuNovel>): KitsuNovel? =
    novels
        .map { novel -> novel to novel.titles.maxOf { trackerTitleMatchScore(title, it) } }
        .filter { it.second >= 0.8 }
        .maxByOrNull { it.second }
        ?.first

/** Kitsu's category for a taste tag ("Slice of Life" is "slice-of-life"). */
internal fun kitsuCategorySlug(tag: String): String =
    normalizeToken(tag).replace(Regex("[^a-z0-9]+"), "-").trim('-')

/** What Kitsu says of a novel: its rating, how many read it and how high it ranks. */
internal fun kitsuNovelToProvider(novel: KitsuNovel): RecommendationProviderSignal {
    val readers = novel.userCount ?: 0.0
    // A rating from a handful of readers says little.
    val ratingConfidence = when {
        readers >= 1_000 -> 0.86
        readers >= 100 -> 0.72
        else -> 0.5
    }
    return RecommendationProviderSignal(
        providerId = "kitsu",
        providerName = "Kitsu",
        kind = RecommendationProviderKind.TRACKER,
        remoteId = novel.id.toString(),
        iconKey = "kitsu",
        score = novel.averageRating?.let { normalizedMetric(it / 100, ratingConfidence, "kitsu-average-rating", "${formatKitsuNumber(it)}%") },
        popularity = if (readers > 0) normalizeLogCount(readers, KITSU_POPULAR_USER_COUNT, 0.7) else null,
        trending = novel.popularityRank?.takeIf { it != 0.0 }?.let { normalizeRank(it.toInt(), KITSU_RANKED_NOVELS, 0.36) },
    )
}

private fun formatKitsuNumber(value: Double): String =
    if (value == Math.floor(value)) value.toLong().toString() else value.toString()

/** A novel Kitsu suggests for the reader's taste, as a recommendation. */
internal fun kitsuNovelToRecommendationCandidate(novel: KitsuNovel, queryTags: List<String> = emptyList()): RecommendationCandidate {
    val startedAt = novel.startDate?.let { date ->
        runCatching { LocalDate.parse(date.take(10)).atStartOfDay().toInstant(ZoneOffset.UTC).toEpochMilli() }.getOrNull()
    }
    return RecommendationCandidate(
        id = "kitsu-novel:${novel.id}",
        title = novel.title,
        alternativeTitles = novel.titles.filter { it != novel.title },
        cover = novel.coverUrl?.let { RecommendationCover(it) },
        tags = (listOf("novel") + novel.categories + queryTags).distinct(),
        contentType = RecommendationContentType.NOVEL,
        status = novel.status,
        format = "NOVEL",
        inLibrary = false,
        safety = if (novel.adult) RecommendationSafetyLevel.ADULT else RecommendationSafetyLevel.SAFE,
        publishedAtMs = startedAt,
        providers = listOf(
            kitsuNovelToProvider(novel),
            RecommendationProviderSignal(
                providerId = "kitsu-catalog",
                providerName = "Kitsu",
                kind = RecommendationProviderKind.SOURCE,
                remoteId = novel.id.toString(),
                availability = NormalizedMetric(0.72, 0.6, "kitsu-catalog"),
            ),
        ),
    )
}

internal fun kitsuSearchParams(query: String, limit: Int): List<String> = listOf(
    "filter%5Btext%5D=${URLEncoder.encode(query.trim(), "UTF-8").replace("+", "%20")}",
    "filter%5Bsubtype%5D=novel",
    "page%5Blimit%5D=$limit",
)

internal fun kitsuDiscoverParams(slug: String, limit: Int, offset: Int): List<String> = listOfNotNull(
    "filter%5Bcategories%5D=${URLEncoder.encode(slug, "UTF-8")}",
    "filter%5Bsubtype%5D=novel",
    "sort=popularityRank",
    "page%5Blimit%5D=$limit",
    if (offset > 0) "page%5Boffset%5D=$offset" else null,
)

/** Kitsu's public novel search and category lists; a request that fails throws. */
class KitsuNovelClient(private val network: NetworkHelper = Injekt.get()) {

    /** Novels Kitsu finds by a title. */
    suspend fun search(query: String, limit: Int): List<KitsuNovel> {
        if (query.isBlank()) return emptyList()
        return request(kitsuSearchParams(query, limit))
    }

    /**
     * The most read novels of a Kitsu category. Kitsu ignores a category it does not have and
     * answers with every novel, so only novels that carry the category are kept.
     */
    suspend fun discover(category: String, limit: Int, offset: Int = 0): List<KitsuNovel> {
        val slug = kitsuCategorySlug(category)
        if (slug.isEmpty()) return emptyList()
        return request(kitsuDiscoverParams(slug, limit, offset))
            .filter { novel -> novel.categories.any { kitsuCategorySlug(it) == slug } }
    }

    private suspend fun request(params: List<String>): List<KitsuNovel> {
        val key = params.joinToString("&")
        cached(key)?.let { return it }
        val url = "$KITSU_API?${(params + KITSU_NOVEL_FIELDS).joinToString("&")}"
        val body = withTimeoutOrNull(KITSU_REQUEST_TIMEOUT_MS) {
            network.client.newCall(GET(url, headersOf("Accept", "application/vnd.api+json")))
                .awaitSuccess()
                .use { it.body.string() }
        } ?: throw IOException("Kitsu did not answer")
        val novels = parseKitsuNovels(body)
        remember(key, novels)
        return novels
    }

    private companion object {
        // The answers of this session, so a scroll or a refresh does not ask Kitsu the same again.
        private val answers = object : LinkedHashMap<String, Pair<Long, List<KitsuNovel>>>(16, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<Long, List<KitsuNovel>>>?) =
                size > KITSU_CACHE_MAX_QUERIES
        }

        fun cached(key: String): List<KitsuNovel>? = synchronized(answers) {
            val entry = answers[key] ?: return null
            if (System.currentTimeMillis() - entry.first >= KITSU_CACHE_TTL_MS) {
                answers.remove(key)
                null
            } else {
                entry.second
            }
        }

        fun remember(key: String, novels: List<KitsuNovel>) = synchronized(answers) {
            answers[key] = System.currentTimeMillis() to novels
        }
    }
}
