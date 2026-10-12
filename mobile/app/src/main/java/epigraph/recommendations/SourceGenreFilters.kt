package epigraph.recommendations

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.Filter
import eu.kanade.tachiyomi.source.model.FilterList

// Lists that leave a genre out, not the ones that pick it.
private val EXCLUDING_FILTER = Regex("exclu|without|sem |sin |except", RegexOption.IGNORE_CASE)
private val GENRE_FILTER = Regex("genre|g[eê]nero|tag|categor|theme|tema", RegexOption.IGNORE_CASE)
private val GENRE_NAMED_FILTER = Regex("genre|g[eê]nero", RegexOption.IGNORE_CASE)
// Toonily and others count the works in each option: "Action (171)".
private val OPTION_COUNT = Regex("\\s*\\(\\d+\\)\\s*$")

internal fun sameGenreTokens(option: String, genre: Set<String>): Boolean {
    val tokens = recommendationTagTokens(option.replace(OPTION_COUNT, ""))
    return tokens.size == genre.size && tokens.all { it in genre }
}

/**
 * Desktop `sourceGenreFilterChange` / `novelSourceGenreFilters`: sets the filter that makes a
 * source's own search list one genre, read from the filters the source declares. Names are matched
 * as recommendation tags, so a source's "Sci-fi", "Science Fiction" or "Ficção científica" all
 * answer the reader's "Sci-Fi". A list that leaves genres out is never used, and a list named for
 * genres comes before any other list that happens to hold the same word.
 *
 * [strict] is the novel rule: only lists named for genres, tags or categories are used (genres
 * first), so a listing or a status that shares a word is never taken for a genre.
 *
 * Returns false, leaving [filters] untouched, when the source cannot search by the genre.
 */
internal fun applySourceGenreFilter(filters: List<Filter<*>>, genre: String, strict: Boolean = false): Boolean {
    val tokens = recommendationTagTokens(genre).toSet()
    if (tokens.isEmpty()) return false
    val preferred = if (strict) GENRE_NAMED_FILTER else GENRE_FILTER
    val candidates = filters
        .filter { (it is Filter.Group<*> || it is Filter.Select<*>) && !EXCLUDING_FILTER.containsMatchIn(it.name) }
        .filter { !strict || GENRE_FILTER.containsMatchIn(it.name) }
        .sortedByDescending { preferred.containsMatchIn(it.name) }
    for (filter in candidates) {
        when (filter) {
            is Filter.Group<*> -> {
                val child = filter.state.firstOrNull { child ->
                    (child is Filter.CheckBox || child is Filter.TriState) && sameGenreTokens((child as Filter<*>).name, tokens)
                }
                when (child) {
                    is Filter.CheckBox -> {
                        child.state = true
                        return true
                    }
                    is Filter.TriState -> {
                        child.state = Filter.TriState.STATE_INCLUDE
                        return true
                    }
                }
            }
            is Filter.Select<*> -> {
                val index = filter.values.indexOfFirst { sameGenreTokens(it.toString(), tokens) }
                if (index >= 0) {
                    filter.state = index
                    return true
                }
            }
            else -> Unit
        }
    }
    return false
}

/** A fresh copy of [source]'s filters set to [genre], or null when the source cannot list by it. */
internal fun sourceGenreFilterList(source: CatalogueSource, genre: String, strict: Boolean = false): FilterList? {
    val filters = runCatching { source.getFilterList() }.getOrNull() ?: return null
    return filters.takeIf { applySourceGenreFilter(it, genre, strict) }
}
