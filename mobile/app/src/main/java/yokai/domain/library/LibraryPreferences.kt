package yokai.domain.library

import eu.kanade.tachiyomi.core.preference.PreferenceStore

class LibraryPreferences(private val preferenceStore: PreferenceStore) {
    fun randomSortSeed() = preferenceStore.getInt("library_random_sort_seed", 0)

    /** [randomSortSeed] of the Books & novels tab, so reshuffling one tab leaves the other alone. */
    fun booksRandomSortSeed() = preferenceStore.getInt("epigraph_books_random_sort_seed", 0)

    /**
     * Filter states of the Books & novels tab, each a filter key followed by its state ("d1"),
     * kept apart from the Comics filters like the seed above.
     */
    fun booksFilterStates() = preferenceStore.getStringSet("epigraph_books_filter_states", emptySet())

    /** Books type filter: NOVELS, EPUB or PDF; empty means every type. */
    fun booksTypeFilter() = preferenceStore.getString("epigraph_books_type_filter", "")

    /** Tracker picked under Tracked in the Books tab; empty means any tracker. */
    fun booksTrackerFilter() = preferenceStore.getString("epigraph_books_tracker_filter", "")

    fun markDuplicateReadChapterAsRead() = preferenceStore.getStringSet("mark_duplicate_read_chapter_read", emptySet())

    // NOVEL: When true, restore scroll position for novels even if the chapter is marked read.
    fun novelReadProgress100() = preferenceStore.getBoolean("pref_novel_read_progress_100", true)

    companion object {
        const val MARK_DUPLICATE_READ_CHAPTER_READ_NEW = "new"
        const val MARK_DUPLICATE_READ_CHAPTER_READ_EXISTING = "existing"

        fun decodeBooksFilterStates(saved: Set<String>): Map<Char, Int> =
            saved.mapNotNull { entry ->
                val state = entry.drop(1).toIntOrNull() ?: return@mapNotNull null
                entry.firstOrNull()?.takeIf { state != 0 }?.let { it to state }
            }.toMap()

        fun encodeBooksFilterStates(states: Map<Char, Int>): Set<String> =
            states.filterValues { it != 0 }.map { (key, state) -> "$key$state" }.toSet()
    }
}
