package epigraph.recommendations

import eu.kanade.tachiyomi.data.track.hardcover.HardcoverBookResult
import eu.kanade.tachiyomi.data.track.hardcover.HardcoverLibraryBook

internal const val HARDCOVER_SCORE_ENRICHMENT_LIMIT = 6
internal const val HARDCOVER_SCORE_ENRICHMENT_CONCURRENCY = 1
internal const val HARDCOVER_SCORE_ENRICHMENT_TIMEOUT_MS = 750L
internal const val HARDCOVER_DISCOVERY_QUERY_LIMIT = 2
internal const val HARDCOVER_DISCOVERY_RESULTS_PER_QUERY = 7
internal const val HARDCOVER_DISCOVERY_TIMEOUT_MS = 950L
internal const val HARDCOVER_DISCOVERY_MIN_RATING = 3.25
internal const val HARDCOVER_RECORD_REFRESH_COOLDOWN_MS = 5 * 60 * 1000L
internal const val HARDCOVER_BACKGROUND_ENRICHMENT_ENABLED = true
internal const val HARDCOVER_BACKGROUND_ENRICHMENT_DELAY_MS = 4500L
internal const val HARDCOVER_BACKGROUND_ENRICHMENT_MIN_GAP_MS = 15 * 60 * 1000L
internal const val HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS = 10 * 60 * 1000L

private val HARDCOVER_DISCOVERY_TAG_BLACKLIST = setOf(
    "book", "books", "novel", "novels", "webnovel", "web novel", "light novel", "epub", "pdf",
    "hardcover", "syncd", "audit", "unknown", "source", "sources", "reading", "ongoing", "completed",
)

/** Desktop `formatTasteTag`: split on spaces, `_` and `-`, capitalize each part. */
internal fun formatHardcoverTasteTag(tag: String): String =
    tag.split(Regex("[\\s_-]+")).filter { it.isNotEmpty() }.joinToString(" ") { it.replaceFirstChar(Char::uppercaseChar) }

internal fun isUsefulHardcoverDiscoveryTag(tag: String): Boolean {
    val normalized = tag.trim().lowercase()
    if (normalized.length < 4) return false
    if (normalized.none { it in 'a'..'z' }) return false
    if (normalized.all { it.isDigit() }) return false
    return normalized !in HARDCOVER_DISCOVERY_TAG_BLACKLIST
}

internal fun hardcoverDiscoveryQueries(topTags: List<String>): List<String> =
    topTags
        .map { formatHardcoverTasteTag(it).trim() }
        .filter { isUsefulHardcoverDiscoveryTag(it) }
        .take(HARDCOVER_DISCOVERY_QUERY_LIMIT)
        .map { "$it novel" }

internal fun hardcoverScoreTitles(
    poolTitles: List<String>,
    userBookTitles: List<String>,
): List<String> {
    val userKeys = userBookTitles.map { recommendationTitleKey(it, RecommendationContentType.NOVEL) }.toSet()
    val seen = HashSet<String>()
    return poolTitles
        .map { it.trim() }
        .filter { it.isNotEmpty() }
        .filter { title ->
            val key = recommendationTitleKey(title, RecommendationContentType.NOVEL)
            if (key in userKeys) return@filter false
            if (!seen.add(key)) return@filter false
            true
        }
        .take(HARDCOVER_SCORE_ENRICHMENT_LIMIT)
}

internal fun <T> filterHardcoverDiscovery(
    results: List<T>,
    rating: (T) -> Double?,
): List<T> = results
    .filter { rating(it) ?: 0.0 >= HARDCOVER_DISCOVERY_MIN_RATING }
    .take(HARDCOVER_DISCOVERY_RESULTS_PER_QUERY)

internal fun useRemoteHardcoverBooks(
    logged: Boolean,
    lastFailureAtMs: Long?,
    nowMs: Long,
): Boolean {
    if (!logged) return false
    if (lastFailureAtMs != null && nowMs - lastFailureAtMs < HARDCOVER_RECORD_REFRESH_COOLDOWN_MS) return false
    return true
}

/**
 * Fills empty [HardcoverLibraryBook.tags] from the linked local work's genres.
 * The desktop keeps the genres saved when the book was linked; the phone takes
 * them from the linked local work instead.
 */
internal fun mergeHardcoverBookTags(
    books: List<HardcoverLibraryBook>,
    genresByBookId: Map<Long, List<String>>,
): List<HardcoverLibraryBook> = books.map { book ->
    if (book.tags.isEmpty()) book.copy(tags = genresByBookId[book.bookId].orEmpty()) else book
}

/**
 * Rate-limits background enrichment calls. The desktop's 4.5 s debounce is not
 * needed on the phone because there is no UI effect loop.
 */
internal class HardcoverEnrichmentGate<R>(
    private val now: () -> Long = System::currentTimeMillis,
) {
    private var lastFailureAt: Long? = null
    private var cachedKey: String? = null
    private var cachedResult: R? = null
    private var cachedAt: Long = 0L

    fun blocked(): Boolean =
        lastFailureAt?.let { now() - it < HARDCOVER_BACKGROUND_ENRICHMENT_ERROR_COOLDOWN_MS } ?: false

    fun markFailure() {
        lastFailureAt = now()
    }

    fun cached(key: String): R? {
        if (key != cachedKey) return null
        if (now() - cachedAt >= HARDCOVER_BACKGROUND_ENRICHMENT_MIN_GAP_MS) return null
        return cachedResult
    }

    fun store(key: String, result: R) {
        cachedKey = key
        cachedResult = result
        cachedAt = now()
    }
}

/** Desktop `tokenizeTitle` (hardcover.ts 1463): lowercase, strip apostrophes, split on non-alphanumeric, keep tokens > 1 char. */
internal fun tokenizeHardcoverTitle(title: String): List<String> =
    title.lowercase()
        .replace(Regex("['\u2019]"), "")
        .split(Regex("[^a-z0-9]+"))
        .filter { it.length > 1 }

/** Desktop `titleSimilarity` (hardcover.ts 1471): weighted coverage + containment. */
internal fun hardcoverTitleSimilarity(left: List<String>, right: List<String>): Double {
    if (left.isEmpty() || right.isEmpty()) return 0.0
    val rightSet = right.toSet()
    val shared = left.count { it in rightSet }
    val coverage = shared.toDouble() / maxOf(left.size, right.size)
    val containment = shared.toDouble() / minOf(left.size, right.size)
    return coverage * 0.65 + containment * 0.35
}

/** Desktop `matchHardcoverBook` (hardcover.ts 564): first strictly-better score wins, threshold >= 0.72. */
internal fun matchHardcoverBook(title: String, results: List<HardcoverBookResult>): HardcoverBookResult? {
    val target = tokenizeHardcoverTitle(title)
    if (target.isEmpty()) return null
    var best: HardcoverBookResult? = null
    var bestScore = 0.0
    for (book in results) {
        val score = hardcoverTitleSimilarity(target, tokenizeHardcoverTitle(book.title))
        if (best == null || score > bestScore) {
            best = book
            bestScore = score
        }
    }
    return if (bestScore >= 0.72) best else null
}
