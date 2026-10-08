package epigraph.sync.core.portable

import eu.kanade.tachiyomi.data.database.models.Chapter

/** Empty, or only chapters projected from the desktop: a source fetch numbers them 0..n-1. */
fun List<Chapter>.needSourceFetch(): Boolean = isEmpty() || all { it.source_order == 0 }
