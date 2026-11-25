package epigraph.sync.core.events

import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

/** Why the background sync worker should run. */
enum class CoreBackgroundSyncReason {
    APP_START,
    OUTBOX_ENQUEUED,
    OUTBOX_PENDING,
    MANUAL,
    PERIODIC_RECONCILIATION,
    CONNECTIVITY_RESTORED,
    EXTENSION_CHANGED,
    CATALOG_REVISIONS,
    CORE_SESSION_CHANGED,
    CORE_EVENT_GAP,
    CORE_SNAPSHOT_NEEDED,
}

/** Schedules durable background sync work from live-event and UI triggers. */
fun interface CoreBackgroundSyncScheduler {
    fun enqueue(reason: CoreBackgroundSyncReason)
}

/** Observes whether Android currently has a network path that can reach Core. */
interface CoreNetworkGate {
    suspend fun awaitAvailable()
}

/** Backoff gate between live-event stream reconnect attempts. */
interface CoreReconnectGate {
    suspend fun awaitReconnect(attempt: Int)
}

/** Result of running a live-event loop. */
sealed interface CoreEventLoopResult {
    data class NeedsUserAction(val statusCode: Int) : CoreEventLoopResult
}

/** Live-event stream contract used by [CoreLiveEventSupervisor]. */
object NoopCoreNetworkGate : CoreNetworkGate {
    override suspend fun awaitAvailable() = Unit
}

/** Empty flow helper for tests. */
fun emptyCoreEvents(): Flow<Unit> = emptyFlow()
