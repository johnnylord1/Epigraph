package eu.kanade.tachiyomi.smartsearch

import java.text.Normalizer
import java.util.Locale
import kotlin.math.max
import yokai.util.normalizedLevenshteinSimilarity

/**
 * Compares series titles as they are written by different sources: case, punctuation, dashes,
 * quotes and accents are ignored, and a title that only drops or adds a subtitle still matches,
 * though less strongly than the full title.
 */
object TitleMatcher {

    /** Lowest score a search result needs to be taken as the same series. */
    const val MIN_MATCH_SCORE = 0.5

    private val diacritics = Regex("\\p{Mn}+")
    private val separators = Regex("[^\\p{L}\\p{N}]+")
    private val brackets = Regex("[(\\[{<][^)\\]}>]*[)\\]}>]")

    // Where a subtitle usually starts: a dash, a colon, or "~".
    private val subtitleSplit = Regex("\\s+[-\u2013\u2014~]\\s+|\\s*[:\uFF1A]\\s+|\\s*[\u2013\u2014~]\\s*")

    fun normalize(title: String): String =
        Normalizer.normalize(title, Normalizer.Form.NFKD)
            .replace(diacritics, "")
            .lowercase(Locale.ROOT)
            .replace(separators, " ")
            .trim()

    /** Similarity of two titles, from 0 (unrelated) to 1 (the same title). */
    fun score(lhs: String, rhs: String): Double {
        val a = normalize(lhs)
        val b = normalize(rhs)
        if (a.isEmpty() || b.isEmpty()) return 0.0
        if (a == b) return 1.0

        val edits = normalizedLevenshteinSimilarity(a, b)

        val wordsA = a.split(' ').toSet()
        val wordsB = b.split(' ').toSet()
        val shared = wordsA.intersect(wordsB).size
        val words = 2.0 * shared / (wordsA.size + wordsB.size)

        // "Apotheosis" and "Apotheosis - Ascension to Godhood": one is the start of the other.
        val (short, long) = if (a.length <= b.length) a to b else b to a
        val prefix = if (long.startsWith("$short ")) {
            0.5 + 0.4 * short.length / long.length
        } else {
            0.0
        }

        return max(edits, max(words, prefix)).coerceAtMost(0.99)
    }

    /** The main title without bracketed notes or a subtitle, when it differs from [title]. */
    fun mainTitle(title: String): String? {
        val withoutBrackets = title.replace(brackets, " ").trim()
        val main = withoutBrackets.split(subtitleSplit).firstOrNull()?.trim().orEmpty()
        return main.takeIf { normalize(it).isNotEmpty() && normalize(it) != normalize(title) }
    }

    /**
     * Queries to try, in order, when searching another source for [title]: the title itself, then
     * plain-text forms that sources with strict keyword search can still find.
     */
    fun searchQueries(title: String): List<String> {
        val plain = normalize(title)
        val main = mainTitle(title)?.let(::normalize)
        val firstWords = plain.split(' ').let { words ->
            if (words.size > 4) words.take(4).joinToString(" ") else null
        }
        return listOfNotNull(title.trim(), plain, main, firstWords)
            .filter { it.isNotBlank() }
            .distinctBy { it.lowercase(Locale.ROOT) }
    }

    /** Best score of [candidate] against [title] or its main title. */
    fun bestScore(title: String, candidate: String): Double {
        val full = score(title, candidate)
        val main = mainTitle(title)?.let { score(it, candidate) * 0.95 } ?: 0.0
        return max(full, main)
    }
}
