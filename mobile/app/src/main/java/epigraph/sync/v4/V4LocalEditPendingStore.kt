package epigraph.sync.v4

import android.content.Context

/** Delay of the debounced full pass after a burst of scoped local-edit passes. */
internal const val V4_LOCAL_EDIT_FULL_PASS_DELAY_MILLIS = 60_000L

/**
 * What a local-edit pass must cover, read in one step.
 *
 * - [generation] is the monotonic mark counter at read time. Every mark at or below it is included.
 * - [fullPass] is true when an unscoped mark (a removal, a category edit, or an unknown scope) is pending.
 * - [workKeys] are the works with scoped marks pending, when no full pass is needed.
 * - [fullPassDueAt] is the epoch millis of the debounced full pass after a burst of scoped passes (0 = none).
 */
data class V4LocalEditSnapshot(
    val generation: Long,
    val fullPass: Boolean,
    val workKeys: Set<String>,
    val fullPassDueAt: Long,
) {
    /**
     * True when a sync must run a local-edit pass. A scheduled full pass counts even before its due time:
     * with no new scoped marks that pass is full, so the safety net never depends on a WorkManager job
     * that fired early (the job is KEEP while a sync runs, so nothing would re-arm it).
     */
    @Suppress("UNUSED_PARAMETER")
    fun hasPending(nowMs: Long): Boolean = fullPass || workKeys.isNotEmpty() || fullPassDueAt != 0L

    fun fullPassDue(nowMs: Long): Boolean = fullPassDueAt in 1L..nowMs
}

/**
 * Durable record of local edits that have not reached Core yet. Survives process death through
 * SharedPreferences, without an SQLDelight migration.
 *
 * - Marks increase [V4LocalEditSnapshot.generation] monotonically and are never reset.
 * - [clearUpTo] clears every mark at or below a generation. A mark recorded after the generation was read
 *   is never cleared, so an edit that races a pass stays pending.
 */
interface V4LocalEditPendingStore {
    /** Records an unscoped edit: the next local pass is a full pass. Returns the new generation. */
    fun markPending(): Long

    /** Records an edit to one work: the next local pass may cover only that work. Returns the new generation. */
    fun markWorkPending(workKey: String): Long

    fun snapshotGeneration(): Long

    fun snapshot(): V4LocalEditSnapshot

    /** Clears every mark at or below [generation]. Marks recorded later stay pending. */
    fun clearUpTo(generation: Long)

    /** Same as [clearUpTo]: [expectedGeneration] is the generation the caller read before its pass. */
    fun clearIfUnchanged(expectedGeneration: Long) = clearUpTo(expectedGeneration)

    /**
     * Sets the persisted debounced full-pass due time to [dueAtMs], overwriting any earlier value.
     * The scheduled WorkManager job is not moved (it is KEEP); see the coordinator's debounce.
     */
    fun scheduleFullPassAt(dueAtMs: Long)

    /** Clears the debounced full pass only if it still has [expectedDueAt]. */
    fun clearFullPassDue(expectedDueAt: Long)
}

/** The persisted fields of the ledger. */
internal data class V4LocalEditState(
    val generation: Long = 0L,
    val cleared: Long = 0L,
    val fullGeneration: Long = 0L,
    val fullPassDueAt: Long = 0L,
    /** Entries `"<generation>\t<workKey>"` for scoped marks above [cleared]. */
    val workMarks: Set<String> = emptySet(),
)

/** Shared ledger logic. Subclasses provide the storage and call [load] and [save] under [lock]. */
internal abstract class BaseV4LocalEditPendingStore : V4LocalEditPendingStore {
    private val lock = Any()

    protected abstract fun load(): V4LocalEditState
    protected abstract fun save(state: V4LocalEditState)

    override fun markPending(): Long = synchronized(lock) {
        val state = load()
        val next = state.generation + 1L
        save(state.copy(generation = next, fullGeneration = next))
        next
    }

    override fun markWorkPending(workKey: String): Long = synchronized(lock) {
        val state = load()
        val next = state.generation + 1L
        save(state.copy(generation = next, workMarks = state.workMarks + entry(next, workKey)))
        next
    }

    override fun snapshotGeneration(): Long = synchronized(lock) { load().generation }

    override fun snapshot(): V4LocalEditSnapshot = synchronized(lock) {
        val state = load()
        V4LocalEditSnapshot(
            generation = state.generation,
            fullPass = state.fullGeneration > state.cleared,
            workKeys = state.workMarks
                .filter { generationOf(it) in (state.cleared + 1)..state.generation }
                .mapTo(HashSet()) { keyOf(it) },
            fullPassDueAt = state.fullPassDueAt,
        )
    }

    override fun clearUpTo(generation: Long) {
        if (generation <= 0L) return
        synchronized(lock) {
            val state = load()
            val target = minOf(generation, state.generation)
            if (target <= state.cleared) return
            save(
                state.copy(
                    cleared = target,
                    workMarks = state.workMarks.filterTo(LinkedHashSet()) { generationOf(it) > target },
                ),
            )
        }
    }

    override fun scheduleFullPassAt(dueAtMs: Long) = synchronized(lock) {
        val state = load()
        save(state.copy(fullPassDueAt = dueAtMs))
    }

    override fun clearFullPassDue(expectedDueAt: Long) {
        if (expectedDueAt == 0L) return
        synchronized(lock) {
            val state = load()
            if (state.fullPassDueAt == expectedDueAt) save(state.copy(fullPassDueAt = 0L))
        }
    }

    private fun entry(generation: Long, workKey: String): String = "$generation\t$workKey"

    private fun generationOf(entry: String): Long = entry.substringBefore('\t').toLong()

    private fun keyOf(entry: String): String = entry.substringAfter('\t')
}

internal class SharedPreferencesV4LocalEditPendingStore(context: Context) : BaseV4LocalEditPendingStore() {
    private val preferences = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): V4LocalEditState {
        val stored = preferences.getLong(KEY_GENERATION, 0L)
        val cleared = preferences.getLong(KEY_CLEARED, 0L)
        // A build older than this ledger treats the generation as a pending flag and resets it to 0 on clear.
        // After such a build ran, a value below the cleared mark means "pending" (non-zero) or "nothing" (0).
        val rewound = stored < cleared
        val generation = if (rewound) cleared + stored else stored
        return V4LocalEditState(
            generation = generation,
            cleared = cleared,
            fullGeneration = when {
                rewound -> if (stored > 0L) generation else preferences.getLong(KEY_FULL_GENERATION, 0L)
                preferences.contains(KEY_FULL_GENERATION) -> preferences.getLong(KEY_FULL_GENERATION, 0L)
                else -> generation
            },
            fullPassDueAt = preferences.getLong(KEY_FULL_PASS_DUE, 0L),
            workMarks = preferences.getStringSet(KEY_WORK_MARKS, emptySet()).orEmpty().toSet(),
        )
    }

    override fun save(state: V4LocalEditState) {
        preferences.edit()
            .putLong(KEY_GENERATION, state.generation)
            .putLong(KEY_CLEARED, state.cleared)
            .putLong(KEY_FULL_GENERATION, state.fullGeneration)
            .putLong(KEY_FULL_PASS_DUE, state.fullPassDueAt)
            .putStringSet(KEY_WORK_MARKS, state.workMarks)
            .commit()
    }

    companion object {
        private const val PREFS_NAME = "epigraph_v4_local_edits_v1"
        private const val KEY_GENERATION = "pending_generation"
        private const val KEY_CLEARED = "cleared_generation"
        private const val KEY_FULL_GENERATION = "full_generation"
        private const val KEY_FULL_PASS_DUE = "full_pass_due_at"
        private const val KEY_WORK_MARKS = "work_marks"
    }
}

internal class MemoryV4LocalEditPendingStore : BaseV4LocalEditPendingStore() {
    private var state = V4LocalEditState()

    override fun load(): V4LocalEditState = state

    override fun save(state: V4LocalEditState) {
        this.state = state
    }
}
