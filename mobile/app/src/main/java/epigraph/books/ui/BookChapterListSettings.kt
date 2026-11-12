package epigraph.books.ui

import eu.kanade.tachiyomi.data.preference.PreferencesHelper

/**
 * Filter, order and title display of one book's chapter list. A book has no Manga row to keep these
 * in, so like a comic's flags they follow the global defaults until set apart from them.
 */
internal class BookChapterListSettings(bookId: String, private val preferences: PreferencesHelper) {

    private val store = preferences.preferenceStore
    private val localRead = store.getInt("book_chapters_${bookId}_read", 0)
    private val localBookmark = store.getInt("book_chapters_${bookId}_bookmark", 0)
    private val localDescending = store.getBoolean("book_chapters_${bookId}_desc", true)
    private val localHideTitles = store.getBoolean("book_chapters_${bookId}_hide_titles", false)

    val readFilter: Int
        get() = if (localRead.isSet()) localRead.get() else preferences.filterChapterByRead().get()

    val bookmarkFilter: Int
        get() = if (localBookmark.isSet()) localBookmark.get() else preferences.filterChapterByBookmarked().get()

    val descending: Boolean
        get() = if (localDescending.isSet()) localDescending.get() else preferences.chaptersDescAsDefault().get()

    val hideTitles: Boolean
        get() = if (localHideTitles.isSet()) localHideTitles.get() else preferences.hideChapterTitlesByDefault().get()

    fun filtersMatchDefault(): Boolean =
        readFilter == preferences.filterChapterByRead().get() &&
            bookmarkFilter == preferences.filterChapterByBookmarked().get() &&
            hideTitles == preferences.hideChapterTitlesByDefault().get()

    fun sortMatchesDefault(): Boolean = descending == preferences.chaptersDescAsDefault().get()

    fun setFilters(read: Int, bookmark: Int) {
        localRead.set(read)
        localBookmark.set(bookmark)
        dropFiltersMatchingDefault()
    }

    fun setHideTitles(hide: Boolean) {
        localHideTitles.set(hide)
        dropFiltersMatchingDefault()
    }

    fun setDescending(descending: Boolean) {
        localDescending.set(descending)
        if (sortMatchesDefault()) localDescending.delete()
    }

    fun setFiltersAsDefault() {
        preferences.filterChapterByRead().set(readFilter)
        preferences.filterChapterByBookmarked().set(bookmarkFilter)
        preferences.hideChapterTitlesByDefault().set(hideTitles)
        resetFilters()
    }

    fun setSortAsDefault() {
        preferences.chaptersDescAsDefault().set(descending)
        localDescending.delete()
    }

    fun resetFilters() {
        localRead.delete()
        localBookmark.delete()
        localHideTitles.delete()
    }

    fun resetSort() {
        localDescending.delete()
    }

    fun clear() {
        resetFilters()
        resetSort()
    }

    private fun dropFiltersMatchingDefault() {
        if (filtersMatchDefault()) resetFilters()
    }
}
