package eu.kanade.tachiyomi.ui.library

import eu.kanade.tachiyomi.util.lang.removeArticles

/** The values a library row is sorted by. */
interface LibrarySortKey {
    val sortTitle: String
    val sortLatestUpdate: Long
    val sortUnread: Int
    val sortLastRead: Long
    val sortTotalChapters: Int
    val sortLastFetch: Long
    val sortNextUpdate: Long
    val sortDateAdded: Long
}

/**
 * Library sort shared by Comics and Books & novels, so a sort mode orders both tabs the same way.
 */
object LibrarySortComparator {

    fun compareTitles(title1: String, title2: String, removeArticles: Boolean): Int =
        if (removeArticles) {
            title1.removeArticles().compareTo(title2.removeArticles(), true)
        } else {
            title1.compareTo(title2, true)
        }

    /**
     * Compares two rows by [mode]. A tie returns 0 and is broken by the caller. Random is ordered
     * by the caller, and DragAndDrop falls back to the title, as in a non-dynamic category.
     */
    fun compare(
        mode: LibrarySort,
        ascending: Boolean,
        i1: LibrarySortKey,
        i2: LibrarySortKey,
        removeArticles: Boolean,
    ): Int {
        val sort = when (mode) {
            LibrarySort.Title, LibrarySort.DragAndDrop -> compareTitles(i1.sortTitle, i2.sortTitle, removeArticles)
            LibrarySort.LatestChapter -> i2.sortLatestUpdate.compareTo(i1.sortLatestUpdate)
            LibrarySort.Unread -> when {
                i1.sortUnread == i2.sortUnread -> 0
                i1.sortUnread == 0 -> if (ascending) 1 else -1
                i2.sortUnread == 0 -> if (ascending) -1 else 1
                else -> i1.sortUnread.compareTo(i2.sortUnread)
            }
            LibrarySort.LastRead -> i2.sortLastRead.compareTo(i1.sortLastRead)
            LibrarySort.TotalChapters -> i2.sortTotalChapters.compareTo(i1.sortTotalChapters)
            LibrarySort.DateFetched -> i2.sortLastFetch.compareTo(i1.sortLastFetch)
            LibrarySort.NextExpectedUpdate -> {
                val next1 = i1.sortNextUpdate.takeIf { it > 0L } ?: Long.MAX_VALUE
                val next2 = i2.sortNextUpdate.takeIf { it > 0L } ?: Long.MAX_VALUE
                next1.compareTo(next2)
            }
            LibrarySort.DateAdded -> i2.sortDateAdded.compareTo(i1.sortDateAdded)
            LibrarySort.Random -> 0
        }
        return if (ascending) sort else -sort
    }
}
