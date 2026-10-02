package epigraph.content

/**
 * Pure helpers for the personal blocked-tag filter.
 *
 * Matching rule (parity with the desktop Nocturne client): a work is blocked when ANY of its
 * genre tags, lowercased and trimmed, CONTAINS any blocked entry as a substring. An entry of
 * "erotic" therefore blocks both "Erotica" and "erotic content".
 */

/**
 * Normalizes a user-entered blocked tag: trims surrounding whitespace and lowercases.
 * Returns `null` when the input is blank after trimming.
 */
fun normalizeBlockedTag(input: String): String? {
    val normalized = input.trim().lowercase()
    return normalized.ifEmpty { null }
}

/**
 * Returns `true` when any genre contains any blocked entry as a substring (case-insensitive).
 * Returns `false` for null/empty genres or an empty blocked set.
 */
fun matchesBlockedTags(genres: List<String>?, blocked: Collection<String>): Boolean {
    if (genres.isNullOrEmpty() || blocked.isEmpty()) return false
    val blockedLower = blocked.map { it.lowercase() }
    return genres.any { genre ->
        val lower = genre.lowercase()
        blockedLower.any { lower.contains(it) }
    }
}

/**
 * Splits a Tachiyomi-style comma-separated `genre` field into trimmed, non-empty tags.
 * Returns an empty list for null/blank input.
 */
fun splitGenreString(genre: String?): List<String> {
    if (genre.isNullOrBlank()) return emptyList()
    return genre.split(',').map { it.trim() }.filter { it.isNotEmpty() }
}
