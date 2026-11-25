package epigraph.sync.v4

import android.content.Context

/**
 * Durable store for the V4 "local edits pending" flag so offline edits survive process death
 * without requiring a SQLDelight schema migration.
 *
 * Uses a monotonic generation counter:
 * - `0L` means no local edits are pending.
 * - `> 0L` means local edits are pending at that generation.
 * - [clearIfUnchanged] only clears the flag if no newer [markPending] arrived since [snapshotGeneration].
 */
interface V4LocalEditPendingStore {
    fun markPending(): Long
    fun snapshotGeneration(): Long
    fun clearIfUnchanged(expectedGeneration: Long)
}

internal class SharedPreferencesV4LocalEditPendingStore(context: Context) : V4LocalEditPendingStore {
    private val preferences = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val lock = Any()

    override fun markPending(): Long = synchronized(lock) {
        val next = (preferences.getLong(KEY_GENERATION, 0L) + 1L).coerceAtLeast(1L)
        preferences.edit().putLong(KEY_GENERATION, next).commit()
        next
    }

    override fun snapshotGeneration(): Long = synchronized(lock) {
        preferences.getLong(KEY_GENERATION, 0L)
    }

    override fun clearIfUnchanged(expectedGeneration: Long) {
        if (expectedGeneration == 0L) return
        synchronized(lock) {
            if (preferences.getLong(KEY_GENERATION, 0L) == expectedGeneration) {
                preferences.edit().putLong(KEY_GENERATION, 0L).commit()
            }
        }
    }

    companion object {
        private const val PREFS_NAME = "epigraph_v4_local_edits_v1"
        private const val KEY_GENERATION = "pending_generation"
    }
}

internal class MemoryV4LocalEditPendingStore : V4LocalEditPendingStore {
    private val lock = Any()
    private var generation = 0L

    override fun markPending(): Long = synchronized(lock) {
        generation = (generation + 1L).coerceAtLeast(1L)
        generation
    }

    override fun snapshotGeneration(): Long = synchronized(lock) {
        generation
    }

    override fun clearIfUnchanged(expectedGeneration: Long) {
        if (expectedGeneration == 0L) return
        synchronized(lock) {
            if (generation == expectedGeneration) {
                generation = 0L
            }
        }
    }
}
