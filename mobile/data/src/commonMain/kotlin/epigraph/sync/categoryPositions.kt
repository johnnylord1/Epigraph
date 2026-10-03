package epigraph.sync

import tachiyomi.data.Categories

/**
 * Core category positions must be non-negative, but local `sort` values may be negative (the
 * category editor numbers from -1). The wire position is therefore the rank in local order.
 */
internal fun List<Categories>.syncPositions(): Map<Long, Long> = this
    .filter { it._id > 0 }
    .sortedWith(compareBy<Categories>({ it.sort }, { it._id }))
    .withIndex()
    .associate { (index, category) -> category._id to index.toLong() }
