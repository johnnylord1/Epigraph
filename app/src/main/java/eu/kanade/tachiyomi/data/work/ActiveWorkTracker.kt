package eu.kanade.tachiyomi.data.work

import java.util.UUID
import java.util.concurrent.atomic.AtomicReference

/**
 * Process-local ownership for a WorkManager request, used by UI hot paths that must not
 * synchronously query WorkManager's database. UUID ownership prevents a cancelled old worker
 * from clearing the state of a newer replacement.
 *
 * Ids are compared by value: a worker receives its id parsed back from WorkManager's database,
 * so it is never the same instance the request was built with.
 */
internal class ActiveWorkTracker {
    private val activeId = AtomicReference<UUID?>(null)

    val isActive: Boolean
        get() = activeId.get() != null

    fun tryTrack(id: UUID): Boolean = activeId.compareAndSet(null, id)

    fun replace(id: UUID) {
        activeId.set(id)
    }

    fun finish(id: UUID): Boolean {
        while (true) {
            val current = activeId.get()
            if (current != id) return false
            if (activeId.compareAndSet(current, null)) return true
        }
    }

    fun clear() {
        activeId.set(null)
    }
}
