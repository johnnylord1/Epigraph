package eu.kanade.tachiyomi.smartsearch

import eu.kanade.tachiyomi.data.database.models.create
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.util.lang.toNormalized
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.supervisorScope
import yokai.util.koin.injectLazy
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.util.normalizedLevenshteinSimilarity

class SmartSearchEngine(
    parentContext: CoroutineContext,
    val extraSearchParams: String? = null,
) : CoroutineScope {
    override val coroutineContext: CoroutineContext = parentContext + Job() + Dispatchers.Default

    private val getManga: GetManga by injectLazy()
    private val insertManga: InsertManga by injectLazy()

    suspend fun smartSearch(source: CatalogueSource, title: String): SManga? {
        val cleanedTitle = cleanSmartSearchTitle(title)

        val queries = getSmartSearchQueries(cleanedTitle)

        val eligibleManga = supervisorScope {
            queries.map { query ->
                async(Dispatchers.Default) {
                    val builtQuery = if (extraSearchParams != null) {
                        "$query ${extraSearchParams.trim()}"
                    } else {
                        query
                    }

                    val searchResults = source.getSearchManga(1, builtQuery, source.getFilterList())

                    searchResults.mangas.map {
                        val cleanedMangaTitle = cleanSmartSearchTitle(it.title)
                        val normalizedDistance = normalizedLevenshteinSimilarity(cleanedTitle, cleanedMangaTitle)
                        SearchEntry(it, normalizedDistance)
                    }.filter { (_, normalizedDistance) ->
                        normalizedDistance >= MIN_SMART_ELIGIBLE_THRESHOLD
                    }
                }
            }.flatMap { it.await() }
        }

        return eligibleManga.maxByOrNull { it.dist }?.manga
    }

    /**
     * Finds [title] in [source]. The title is searched as written first; when that finds nothing
     * close enough, plain-text and shorter forms are tried (some sources match keywords strictly, or
     * name the series without its subtitle). A result has to look like the same series: one that is
     * not similar enough is left for the user to pick by hand.
     */
    suspend fun normalSearch(source: CatalogueSource, title: String): SManga? {
        val wanted = title.toNormalized()
        var best: SearchEntry? = null
        var failure: Exception? = null
        var answered = false
        for (query in TitleMatcher.searchQueries(wanted)) {
            val searchQuery = if (extraSearchParams != null) {
                "$query ${extraSearchParams.trim()}"
            } else {
                query
            }
            val results = try {
                source.getSearchManga(1, searchQuery, source.getFilterList()).mangas
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                failure = e
                continue
            }
            answered = true
            val match = results
                .map { SearchEntry(it, TitleMatcher.bestScore(wanted, it.title.toNormalized())) }
                .filter { it.dist >= TitleMatcher.MIN_MATCH_SCORE }
                .maxByOrNull { it.dist }
            if (match != null && match.dist > (best?.dist ?: 0.0)) best = match
            if ((best?.dist ?: 0.0) >= STRONG_MATCH_SCORE) break
        }
        if (!answered) failure?.let { throw it }
        return best?.manga
    }

    private fun cleanSmartSearchTitle(title: String): String {
        val preTitle = title.lowercase(java.util.Locale.getDefault())

        // Remove text in brackets
        var cleanedTitle = removeTextInBrackets(preTitle, true)
        if (cleanedTitle.length <= 5) { // Title is suspiciously short, try parsing it backwards
            cleanedTitle = removeTextInBrackets(preTitle, false)
        }

        // Strip non-special characters
        cleanedTitle = cleanedTitle.replace(titleRegex, " ")

        // Strip splitters and consecutive spaces
        cleanedTitle = cleanedTitle.trim().replace(" - ", " ").replace(consecutiveSpacesRegex, " ").trim()

        return cleanedTitle
    }

    private fun getSmartSearchQueries(cleanedTitle: String): List<String> {
        val splitCleanedTitle = cleanedTitle.split(" ")
        val splitSortedByLargest = splitCleanedTitle.sortedByDescending { it.length }

        if (splitCleanedTitle.isEmpty()) {
            return emptyList()
        }

        // Search cleaned title
        // Search two largest words
        // Search largest word
        // Search first two words
        // Search first word
        val searchQueries = listOf(
            listOf(cleanedTitle),
            splitSortedByLargest.take(2),
            splitSortedByLargest.take(1),
            splitCleanedTitle.take(2),
            splitCleanedTitle.take(1),
        )

        return searchQueries
            .map { it.joinToString(" ").trim() }
            .distinct()
    }

    private fun removeTextInBrackets(text: String, readForward: Boolean): String {
        val bracketPairs = listOf(
            '(' to ')',
            '[' to ']',
            '<' to '>',
            '{' to '}',
        )
        var openingBracketPairs = bracketPairs.mapIndexed { index, (opening, _) ->
            opening to index
        }.toMap()
        var closingBracketPairs = bracketPairs.mapIndexed { index, (_, closing) ->
            closing to index
        }.toMap()

        // Reverse pairs if reading backwards
        if (!readForward) {
            val tmp = openingBracketPairs
            openingBracketPairs = closingBracketPairs
            closingBracketPairs = tmp
        }

        val depthPairs = bracketPairs.map { 0 }.toMutableList()

        val result = StringBuilder()
        for (c in if (readForward) text else text.reversed()) {
            val openingBracketDepthIndex = openingBracketPairs[c]
            if (openingBracketDepthIndex != null) {
                depthPairs[openingBracketDepthIndex]++
            } else {
                val closingBracketDepthIndex = closingBracketPairs[c]
                if (closingBracketDepthIndex != null) {
                    depthPairs[closingBracketDepthIndex]--
                } else {
                    if (depthPairs.all { it <= 0 }) {
                        result.append(c)
                    } else {
                        // In brackets, do not append to result
                    }
                }
            }
        }

        return result.toString()
    }

    /**
     * Returns a manga from the database for the given manga from network. It creates a new entry
     * if the manga is not yet in the database.
     *
     * @param sManga the manga from the source.
     * @return a manga from the database.
     */
    suspend fun networkToLocalManga(sManga: SManga, sourceId: Long): Manga {
        var localManga = getManga.awaitByUrlAndSource(sManga.url, sourceId)
        if (localManga == null) {
            val newManga = Manga.create(sManga.url, sManga.title, sourceId)
            newManga.copyFrom(sManga)
            newManga.id = insertManga.await(newManga)
            localManga = newManga
        }
        return localManga
    }

    companion object {
        const val MIN_SMART_ELIGIBLE_THRESHOLD = 0.4
        const val MIN_NORMAL_ELIGIBLE_THRESHOLD = 0.4

        /** A result this close ends the search; weaker ones let the next query try to do better. */
        private const val STRONG_MATCH_SCORE = 0.9

        private val titleRegex = Regex("[^a-zA-Z0-9- ]")
        private val consecutiveSpacesRegex = Regex(" +")
    }
}

data class SearchEntry(val manga: SManga, val dist: Double)
