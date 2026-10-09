package epigraph.sync

import tachiyomi.data.Categories
import yokai.data.Database

/**
 * Core category positions must be non-negative, but local `sort` values may be negative (the
 * category editor numbers from -1). The wire position is therefore the rank in local order.
 */
internal fun List<Categories>.syncPositions(): Map<Long, Long> = this
    .filter { it._id > 0 }
    .sortedWith(compareBy<Categories>({ it.sort }, { it._id }))
    .withIndex()
    .associate { (index, category) -> category._id to index.toLong() }

/**
 * Books & novels folders are listed apart from comic folders, so they rank among themselves only;
 * counting comic folders in would raise their position on every round trip through the desktop.
 * [joining] are folders about to be filed under Books & novels in the same transaction.
 */
internal fun Database.booksAndNovelsPositions(joining: Collection<Long> = emptyList()): Map<Long, Long> {
    val folders = categoriesQueries.findAllBooks().executeAsList().mapTo(HashSet()) { it._id } + joining
    return categoriesQueries.findAll().executeAsList().filter { it._id in folders }.syncPositions()
}
