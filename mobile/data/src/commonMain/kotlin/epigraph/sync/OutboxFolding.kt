package epigraph.sync

import epigraph.contract.SyncCommand

/**
 * Folds repeated unsent commands for one entity into one.
 *
 * Reading writes progress on every page turn, but the Core keeps a single record per progress or
 * chapter-state entity and replaces it whole. Sending each page costs a request, a change-log row
 * and a desktop projection without changing the outcome, so only the folded result needs to leave.
 * History entries, bookmarks and library rows are never folded: each of them is its own record.
 */
internal object OutboxFolding {
    val operations: List<String> = listOf("set_progress", "set_chapter_state", "set_novel_chapter_state")

    fun isFoldable(command: SyncCommand): Boolean = when (command) {
        is SyncCommand.SetProgress,
        is SyncCommand.SetChapterState,
        is SyncCommand.SetNovelChapterState,
        -> true
        else -> false
    }

    /**
     * Folds commands given oldest first. Null when they are not all the same foldable kind of one
     * entity, in which case nothing may be folded.
     */
    fun fold(commands: List<SyncCommand>): SyncCommand? {
        val first = commands.firstOrNull() ?: return null
        if (!isFoldable(first) || commands.any { it::class != first::class || it.entityId != first.entityId }) {
            return null
        }
        return commands.reduce(::merge)
    }

    private fun merge(older: SyncCommand, newer: SyncCommand): SyncCommand = when (newer) {
        // A reset lets the Core accept lower progress; the newer locator applies on top of it.
        is SyncCommand.SetProgress -> newer.copy(
            explicitReset = newer.explicitReset || (older as SyncCommand.SetProgress).explicitReset,
        )
        is SyncCommand.SetChapterState -> {
            val earlier = (older as SyncCommand.SetChapterState).state
            val latest = newer.state
            val portableFromLatest = latest.portableWorkRef != null
            newer.copy(
                state = latest.copy(
                    portableWorkRef = if (portableFromLatest) latest.portableWorkRef else earlier.portableWorkRef,
                    portableChapterRef = if (portableFromLatest) latest.portableChapterRef else earlier.portableChapterRef,
                    read = latest.read ?: earlier.read,
                    bookmarked = latest.bookmarked ?: earlier.bookmarked,
                    lastPageRead = latest.lastPageRead ?: earlier.lastPageRead,
                    lastReadAtEpochMillis = latest.lastReadAtEpochMillis ?: earlier.lastReadAtEpochMillis,
                    explicitProgressReset = latest.explicitProgressReset || earlier.explicitProgressReset,
                ),
            )
        }
        // A complete snapshot: the newest one is the state.
        else -> newer
    }
}
