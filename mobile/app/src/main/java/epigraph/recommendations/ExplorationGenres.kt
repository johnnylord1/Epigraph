package epigraph.recommendations

import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.sqrt

/** AniList's comic genres, without the adult ones (desktop `exploration.ts`). */
internal val ANILIST_EXPLORATION_GENRES = listOf(
    "Action",
    "Adventure",
    "Comedy",
    "Drama",
    "Fantasy",
    "Horror",
    "Mahou Shoujo",
    "Mecha",
    "Music",
    "Mystery",
    "Psychological",
    "Romance",
    "Sci-Fi",
    "Slice of Life",
    "Sports",
    "Supernatural",
    "Thriller",
)

private const val MIN_EXPLORATION_SEEDS = 5
// Only the rarest genres are worth exploring; the window rotates through them so the row changes.
private const val EXPLORATION_GENRE_POOL = 8
// Same square-root scale as tag affinity in ranking: a genre at 4% of the reader's strongest
// still matches 0.2, so only genres below this can carry a title outside the reader's habits.
private const val RARE_GENRE_MATCH_MAX = 0.35
private const val CORE_GENRE_MATCH_MIN = 0.85
// Same count as the principal genres the page shows and the ranking keeps out of "outside".
private const val PRINCIPAL_GENRE_COUNT = 6

private const val TASTE_CATALOG_GENRE_LIMIT = 3
private const val TASTE_CATALOG_PAGE_BUDGET = 6
// Below this share of the library a format gets no search of its own.
private const val TASTE_CATALOG_MIN_SHARE = 0.1
private val COMIC_FORMAT_COUNTRIES = listOf(
    RecommendationContentType.MANGA to "JP",
    RecommendationContentType.MANHWA to "KR",
    RecommendationContentType.MANHUA to "CN",
)

/** The comic format an AniList country of origin stands for. */
internal val COMIC_COUNTRY_FORMATS: Map<String, RecommendationContentType> = COMIC_FORMAT_COUNTRIES.associate { it.second to it.first }

data class ExplorationGenres(
    /** Genres the reader rarely reads: a rotating window over the rarest ones. */
    val include: List<String>,
    /** Genres the reader reads the most; titles carrying one of them are not outside the usual. */
    val exclude: List<String>,
)

/** One day, so the explored genres change from day to day. */
internal fun explorationRotation(nowMs: Long): Int = (nowMs / 86_400_000L).toInt()

/**
 * Genres to search when looking for works outside the reader's habits. Catalogs trend toward the
 * same few genres a heavy reader already has, so without a search of its own the "outside your
 * usual reads" row has almost nothing to pick from.
 */
internal fun explorationGenres(profile: TasteProfile, limit: Int = 4, rotation: Int = 0): ExplorationGenres? {
    if (profile.seedCount < MIN_EXPLORATION_SEEDS) return null
    val strongest = profile.tagWeights.values.fold(0.0, ::max)
    if (strongest <= 0) return null

    // The reader's principal genres (the ones the page names as their taste) are never "outside".
    val principal = profile.topTags.take(PRINCIPAL_GENRE_COUNT).toSet()
    data class Entry(val genre: String, val match: Double, val disliked: Boolean, val principal: Boolean)
    val genres = ANILIST_EXPLORATION_GENRES.map { genre ->
        val tokens = recommendationTagTokens(genre)
        val weights = tokens.map { profile.tagWeights[it] ?: 0.0 }
        Entry(
            genre = genre,
            match = sqrt(weights.fold(0.0, ::max) / strongest),
            disliked = weights.any { it < 0 },
            principal = tokens.any { it in principal },
        )
    }

    val rare = genres
        .filter { !it.disliked && !it.principal && it.match < RARE_GENRE_MATCH_MAX }
        .sortedBy { it.match }
        .take(EXPLORATION_GENRE_POOL)
        .map { it.genre }
    if (rare.isEmpty()) return null
    val count = minOf(limit, rare.size)
    val start = abs(rotation) % rare.size
    return ExplorationGenres(
        include = List(count) { index -> rare[(start + index) % rare.size] },
        exclude = genres.filter { it.match >= CORE_GENRE_MATCH_MIN || it.principal }.map { it.genre },
    )
}

private fun comicFormatWeights(profile: TasteProfile): List<Pair<String, Double>> =
    COMIC_FORMAT_COUNTRIES.map { (format, country) -> country to max(0.0, profile.contentTypeWeights[format] ?: 0.0) }

/**
 * The comic formats the library holds enough of to search apart, as AniList countries, most read
 * first. Catalogs sorted by score are mostly Japanese; asked per country, a manhwa reader's
 * searches bring manhwa in the library's proportions.
 */
internal fun comicFormatCountries(profile: TasteProfile): List<String> {
    val weights = comicFormatWeights(profile)
    val total = weights.sumOf { it.second }
    if (total <= 0) return emptyList()
    return weights
        .filter { it.second / total >= TASTE_CATALOG_MIN_SHARE }
        .sortedByDescending { it.second }
        .map { it.first }
}

data class TasteCatalogRequest(
    /** AniList country of origin: Japan for manga, Korea for manhwa, China for manhua. */
    val country: String,
    /** One of the reader's strongest AniList genres. */
    val genre: String,
    /** Pages of works the reader does not have yet to look for. */
    val pages: Int,
)

/**
 * Catalog searches that follow the reader's taste: their strongest genres, in each comic format the
 * library holds, with pages in proportion to it, shared out over the genres. Trending catalogs are
 * mostly Japanese and mostly what a heavy reader already has, so a manhwa reader would otherwise
 * get only manga.
 */
internal fun tasteCatalogRequests(profile: TasteProfile): List<TasteCatalogRequest> {
    if (profile.seedCount < MIN_EXPLORATION_SEEDS) return emptyList()
    val genres = ANILIST_EXPLORATION_GENRES
        .map { genre ->
            val weights = recommendationTagTokens(genre).map { profile.tagWeights[it] ?: 0.0 }
            genre to if (weights.any { it < 0 }) 0.0 else weights.fold(0.0, ::max)
        }
        .filter { it.second > 0 }
        .sortedByDescending { it.second }
        .take(TASTE_CATALOG_GENRE_LIMIT)
        .map { it.first }
    if (genres.isEmpty()) return emptyList()

    val weights = comicFormatWeights(profile)
    val total = weights.sumOf { it.second }
    if (total <= 0) return emptyList()
    return weights
        .filter { it.second / total >= TASTE_CATALOG_MIN_SHARE }
        .flatMap { (country, weight) ->
            // JavaScript's Math.round: halves round up.
            val pages = max(1, floor((weight / total) * TASTE_CATALOG_PAGE_BUDGET + 0.5).toInt())
            genres
                .mapIndexed { index, genre ->
                    TasteCatalogRequest(country, genre, pages / genres.size + if (index < pages % genres.size) 1 else 0)
                }
                .filter { it.pages > 0 }
        }
}
