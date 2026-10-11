package eu.kanade.tachiyomi.ui.migration.manga.design

/**
 * The `migrate_sources` preference holds one "/"-separated list for comic and novel
 * migrations alike. Each kind reads and rewrites only the ids of its own sources, so picking
 * novel sources never drops the comic selection, or the other way round.
 */
object MigrationSourceSelection {

    fun parse(saved: String): List<Long> = saved.split("/").mapNotNull { it.toLongOrNull() }

    /** The saved ids that belong to [kindIds], in their saved order. */
    fun ofKind(saved: String, kindIds: Set<Long>): List<Long> = parse(saved).filter { it in kindIds }

    /** [selected] for this kind, followed by the saved ids of the other kind. */
    fun merge(saved: String, kindIds: Set<Long>, selected: List<Long>): String =
        (selected + parse(saved).filterNot { it in kindIds }).distinct().joinToString("/")
}
