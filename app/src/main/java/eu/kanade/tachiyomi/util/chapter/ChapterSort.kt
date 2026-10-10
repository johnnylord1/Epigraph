package eu.kanade.tachiyomi.util.chapter

import yokai.util.koin.get
import eu.kanade.tachiyomi.data.database.models.Chapter
import eu.kanade.tachiyomi.data.database.models.chapterOrder
import eu.kanade.tachiyomi.data.database.models.sortDescending
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.util.lang.compareToCaseInsensitiveNaturalOrder

class ChapterSort(val manga: Manga, val chapterFilter: ChapterFilter = get(), val preferences: PreferencesHelper = get()) {

    fun <T : Chapter> getChaptersSorted(
        rawChapters: List<T>,
        andFiltered: Boolean = true,
        filterForReader: Boolean = false,
        currentChapter: T? = null,
    ): List<T> {
        val chapters = when {
            filterForReader -> chapterFilter.filterChaptersForReader(
                rawChapters,
                manga,
                currentChapter,
            )
            andFiltered -> chapterFilter.filterChapters(rawChapters, manga)
            else -> rawChapters
        }

        return chapters.sortedWith(sortComparator())
    }

    fun <T : Chapter> getNextChapter(rawChapters: List<T>, andFiltered: Boolean = true): T? {
        val chapters = when {
            andFiltered -> chapterFilter.filterChapters(rawChapters, manga)
            else -> rawChapters
        }
        return chapters.sortedWith(sortComparator(true)).firstOrNull()
    }

    fun <T : Chapter> getNextUnreadChapter(rawChapters: List<T>, andFiltered: Boolean = true): T? {
        val chapters = when {
            andFiltered -> chapterFilter.filterChapters(rawChapters, manga)
            else -> rawChapters
        }

        return chapters.sortedWith(sortComparator(true)).find { !it.read }
    }

    fun <T : Chapter> sortComparator(ignoreAsc: Boolean = false): Comparator<T> {
        val sortDescending = !ignoreAsc && manga.sortDescending(preferences)
        // Chapters restored from a backup or the Core share source order 0 until the source list
        // is fetched; their number keeps them in reading order meanwhile.
        val newestFirst: (T, T) -> Int = { c1, c2 ->
            c1.source_order.compareTo(c2.source_order).takeIf { it != 0 }
                ?: c2.chapter_number.compareTo(c1.chapter_number)
        }
        val sortFunction: (T, T) -> Int =
            when (manga.chapterOrder(preferences)) {
                Manga.CHAPTER_SORTING_SOURCE -> when (sortDescending) {
                    true -> newestFirst
                    false -> { c1, c2 -> newestFirst(c2, c1) }
                }
                Manga.CHAPTER_SORTING_NUMBER -> when (sortDescending) {
                    true -> { c1, c2 -> c2.chapter_number.toString().compareToCaseInsensitiveNaturalOrder(c1.chapter_number.toString()) }
                    false -> { c1, c2 -> c1.chapter_number.toString().compareToCaseInsensitiveNaturalOrder(c2.chapter_number.toString()) }
                }
                Manga.CHAPTER_SORTING_UPLOAD_DATE -> when (sortDescending) {
                    true -> { c1, c2 -> c2.date_upload.compareTo(c1.date_upload) }
                    false -> { c1, c2 -> c1.date_upload.compareTo(c2.date_upload) }
                }
                else -> newestFirst
            }
        return Comparator(sortFunction)
    }
}
