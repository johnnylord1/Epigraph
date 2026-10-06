package epigraph.sync.core.events

import epigraph.sync.core.replay.CoreReplaySession
import kotlinx.coroutines.CancellationException

/** Port implemented later by Android connectivity callbacks; it must be cancellation-aware. */
fun interface CoreNetworkGate {
    suspend fun awaitAvailable()
}

/** Port implemented later by delay/backoff policy or a scheduler such as WorkManager. */
fun interface CoreReconnectGate {
    suspend fun awaitRetry(attempt: Int, reason: CoreReconnectReason)
}

/** A successful bootstrap returns a session only after snapshot and cursor are durable. */
fun interface CoreFullBootstrap {
    suspend fun run(reasonCode: String?): CoreReplaySession
}

fun interface CoreEventConnection {
    suspend fun connect(session: CoreReplaySession): CoreEventStreamOutcome
}

enum class CoreBackgroundSyncReason {
    APP_START,
    CONNECTIVITY_RESTORED,
    PERIODIC_RECONCILIATION,
    OUTBOX_PENDING,

    /** "Sync now" in Settings: replaces any queued wake and runs as soon as network allows. */
    MANUAL,
}

/**
 * Android wiring should implement this as unique WorkManager work requiring network access.
 * Keeping the port here avoids adding WorkManager and application DI to the protocol layer.
 */
fun interface CoreBackgroundSyncScheduler {
    fun enqueue(reason: CoreBackgroundSyncReason)
}

sealed interface CoreEventLoopResult {
    data class NeedsUserAction(
        val statusCode: Int,
        val session: CoreReplaySession,
    ) : CoreEventLoopResult
}

/**
 * Network/scheduler-agnostic event loop. Android DI must supply connectivity, token acquisition,
 * pinned transport and background scheduling; this layer intentionally has no WorkManager API.
 */
class CoreEventOrchestrator(
    private val network: CoreNetworkGate,
    private val reconnect: CoreReconnectGate,
    private val bootstrap: CoreFullBootstrap,
    private val connection: CoreEventConnection,
) {
    suspend fun run(initialSession: CoreReplaySession): CoreEventLoopResult {
        var session = initialSession
        var attempt = 0
        while (true) {
            network.awaitAvailable()
            val cursorBefore = session.checkpoint.lastGlobalEventId
            val outcome = try {
                connection.connect(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
            }
            when (outcome) {
                is CoreEventStreamOutcome.FullBootstrap -> {
                    session = bootstrap.run(outcome.reasonCode)
                    attempt = 0
                }
                is CoreEventStreamOutcome.Reconnect -> {
                    // A connection that delivered changes was healthy; its drop starts a new
                    // backoff series instead of inheriting the delay of earlier failures.
                    if (outcome.checkpoint.lastGlobalEventId > cursorBefore) attempt = 0
                    attempt += 1
                    reconnect.awaitRetry(attempt, outcome.reason)
                }
                is CoreEventStreamOutcome.HttpFailure -> {
                    if (!outcome.retryable) {
                        return CoreEventLoopResult.NeedsUserAction(outcome.statusCode, session)
                    }
                    attempt += 1
                    reconnect.awaitRetry(attempt, CoreReconnectReason.IO_FAILURE)
                }
            }
        }
    }
}
