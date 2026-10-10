package epigraph.recommendations

import kotlin.math.max
import kotlin.math.pow
import kotlin.math.roundToInt

/** One work in Discover › Catalog: something an installed extension lists, with its tracker score. */
data class DiscoverCatalogEntry(
    val candidate: RecommendationCandidate,
    val badge: TrackerScoreBadge?,
)

/**
 * Discover › Catalog: every work the installed extensions listed while Discover gathered its pool,
 * in the order the sources returned them, with the tracker score badge when a tracker knows the
 * title. Tracker-only picks are left out because they cannot be opened from a source. Library,
 * NSFW and blocked-tag filters are the same ones the For you rails use. With [genres], only works
 * tagged with every one of them are kept.
 */
fun buildDiscoverCatalog(
    candidates: List<RecommendationCandidate>,
    options: BuildRecommendationSectionsOptions,
    genres: List<String> = emptyList(),
): List<DiscoverCatalogEntry> =
    candidates
        .filter { it.targets.isNotEmpty() && passesFilters(it, options) && matchesAllGenres(it.tags, genres) }
        .distinctBy { it.id }
        .map { DiscoverCatalogEntry(it, buildTrackerScoreBadge(it)) }

/**
 * Catalog with genres selected, like the desktop Browse genre search: the gathered works tagged
 * with every genre first, then the source search results (already matched by [genreSearchKeeps]).
 * A title already listed is not repeated.
 */
fun buildDiscoverGenreCatalog(
    poolCandidates: List<RecommendationCandidate>,
    searchCandidates: List<RecommendationCandidate>,
    options: BuildRecommendationSectionsOptions,
    genres: List<String>,
): List<DiscoverCatalogEntry> {
    val fromPool = buildDiscoverCatalog(poolCandidates, options, genres)
    val seen = HashSet<String>()
    fromPool.forEach { seen += it.candidate.id; seen += it.candidate.catalogTitleKey() }
    val fromSearch = searchCandidates
        .filter { it.targets.isNotEmpty() && passesFilters(it, options) }
        .filter { seen.add(it.id) and seen.add(it.catalogTitleKey()) }
        .map { DiscoverCatalogEntry(it, buildTrackerScoreBadge(it)) }
    return fromPool + fromSearch
}

private fun RecommendationCandidate.catalogTitleKey() = "title:" + recommendationTitleKey(title, contentType)

/** Desktop BrowseV3 `COMMON_GENRES`. */
val DISCOVER_COMMON_GENRES = listOf(
    "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Romance", "Sci-Fi", "Slice of Life",
    "Horror", "Mystery", "Thriller", "Sports", "Supernatural", "Mecha", "Historical", "Psychological",
    "School Life", "Shounen", "Seinen", "Josei", "Shoujo", "Isekai", "Martial Arts", "Magic", "Music",
    "Cooking", "Medical", "Military", "Harem", "Ecchi", "Doujinshi", "Yaoi", "Yuri",
)

/** Desktop BrowseV3 `ADULT_GENRES`: offered only while NSFW is on. */
val DISCOVER_ADULT_GENRES = listOf("Adult", "Suggestive", "Hentai", "Mature", "Smut", "Erotica")

/** Desktop BrowseV3 `GENRE_ALIASES`; the first alias is the search term. */
private val DISCOVER_GENRE_ALIASES = mapOf(
    "Adult" to listOf("Adult", "Mature", "18+", "Smut", "Erotica", "Explicit", "Pornographic"),
    "Suggestive" to listOf("Suggestive", "Fanservice", "Mature", "Smut"),
    "Hentai" to listOf("Hentai", "Adult", "Erotica", "Pornographic"),
    "Mature" to listOf("Mature", "Adult", "18+", "Seinen"),
    "Smut" to listOf("Smut", "Adult", "Erotica"),
    "Erotica" to listOf("Erotica", "Erotic", "Adult", "Smut"),
    "Doujinshi" to listOf("Doujinshi", "Doujin", "Fan Comic"),
    "Yaoi" to listOf("Yaoi", "Boys Love", "BL"),
    "Yuri" to listOf("Yuri", "Girls Love", "GL"),
)

fun discoverGenreAliases(genre: String): List<String> = DISCOVER_GENRE_ALIASES[genre] ?: listOf(genre)

fun discoverGenreSearchTerm(genre: String): String = discoverGenreAliases(genre).first()

/** The genres the Catalog offers: adult ones only with NSFW on, and none the user blocked. */
fun discoverGenreOptions(includeNsfw: Boolean, blockedTags: List<String>): List<String> {
    val blocked = blockedTags.map(::normalizeToken).filter { it.isNotEmpty() }.toSet()
    val genres = if (includeNsfw) DISCOVER_COMMON_GENRES + DISCOVER_ADULT_GENRES else DISCOVER_COMMON_GENRES
    return genres.filter { normalizeToken(it) !in blocked }
}

/**
 * Desktop `matchesAllTags`: every genre (or one of its aliases) equals or is contained in a tag.
 * Short aliases such as "BL" must match a whole tag, or "Possible" would count as Boys Love.
 */
fun matchesAllGenres(tags: List<String>, genres: List<String>): Boolean {
    if (genres.isEmpty()) return true
    val lowered = tags.map { it.lowercase() }
    return genres.all { genre ->
        discoverGenreAliases(genre).any { alias ->
            val needle = alias.lowercase()
            lowered.any { it == needle || (needle.length > 3 && needle in it) }
        }
    }
}

/**
 * Cards per row for a Discover width, with the library grid math (`AutofitRecyclerView`):
 * [gridSize] 1 is the default (3 on a phone), each step makes cards 1.5x larger.
 */
fun discoverGridColumns(widthDp: Float, gridSize: Float): Int {
    val size = 1.5f.pow(gridSize)
    val columnWidth = 25f * (size * 100f / 25f).roundToInt() / 100f
    val width = (widthDp / 100f).roundToInt()
    return max(1, (width / columnWidth).roundToInt())
}
