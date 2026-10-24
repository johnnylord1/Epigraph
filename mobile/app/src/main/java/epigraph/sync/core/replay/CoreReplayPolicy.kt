package epigraph.sync.core.replay

import epigraph.sync.core.protocol.CoreChangeEnvelope
import epigraph.sync.core.protocol.CoreErrorDetail

/** Scope coverage of one snapshot + SSE subscription pair. */
sealed interface CoreReplayCoverage {
    /** The stream was opened without `scopeId`, covering every scope granted to the token. */
    data object AllGrantedScopes : CoreReplayCoverage

    /** The snapshot and stream cover only [scopeId]. */
    data class Filtered(val scopeId: String) : CoreReplayCoverage {
        init {
            require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        }
    }
}

data class CoreReplayCheckpoint(
    val lastGlobalEventId: Long,
    val coverage: CoreReplayCoverage,
) {
    init {
        require(lastGlobalEventId >= 0) { "lastGlobalEventId must not be negative" }
    }

    /** Exact value to send as the next `Last-Event-ID` header. */
    val lastEventIdHeader: String
        get() = lastGlobalEventId.toString()

    /**
     * A filtered snapshot/feed is never evidence about entities outside its scope. Consumers may
     * delete data only in response to an explicit delete envelope or an authoritative snapshot of
     * that same scope. Missing global versions are not tombstones.
     */
    val mayInferGlobalDeletes: Boolean
        get() = false
}

sealed interface CoreReplayDecision {
    data class ApplyChange(
        val change: CoreChangeEnvelope,
        val checkpoint: CoreReplayCheckpoint,
    ) : CoreReplayDecision

    data class IgnoreAlreadySeen(val checkpoint: CoreReplayCheckpoint) : CoreReplayDecision

    data class Heartbeat(val checkpoint: CoreReplayCheckpoint) : CoreReplayDecision

    data class ReconnectAndReplay(val checkpoint: CoreReplayCheckpoint) : CoreReplayDecision

    data class FullBootstrap(val reasonCode: String?) : CoreReplayDecision
}

class CoreReplaySession private constructor(
    initialCheckpoint: CoreReplayCheckpoint,
) {
    var checkpoint: CoreReplayCheckpoint = initialCheckpoint
        private set
    private var pendingGlobalEventId: Long? = null

    fun onEvent(event: CoreSseEvent): CoreReplayDecision = when (event) {
        is CoreSseEvent.Ping -> CoreReplayDecision.Heartbeat(checkpoint)
        is CoreSseEvent.ReplayRequired -> decideReplayRequired(event.payload)
        is CoreSseEvent.Change -> acceptChange(event)
        is CoreSseEvent.CatalogRevision -> CoreReplayDecision.Heartbeat(checkpoint)
    }

    private fun acceptChange(event: CoreSseEvent.Change): CoreReplayDecision {
        val expectedScope = (checkpoint.coverage as? CoreReplayCoverage.Filtered)?.scopeId
        if (expectedScope != null && event.envelope.scopeId != expectedScope) {
            throw CoreSseProtocolException(
                "Filtered SSE stream for $expectedScope received ${event.envelope.scopeId}",
            )
        }
        if (event.globalEventId <= checkpoint.lastGlobalEventId) {
            return CoreReplayDecision.IgnoreAlreadySeen(checkpoint)
        }

        check(pendingGlobalEventId == null) {
            "Previous Core change must be durably applied or abandoned before accepting another"
        }

        // Global ids need only increase. A scope filter legitimately creates arbitrary gaps.
        pendingGlobalEventId = event.globalEventId
        return CoreReplayDecision.ApplyChange(
            event.envelope,
            checkpoint.copy(lastGlobalEventId = event.globalEventId),
        )
    }

    /**
     * Advances the reconnect cursor only after the change and this checkpoint have been committed
     * durably. A failed apply must call [abandonPendingChange] and reconnect from the old cursor.
     */
    fun confirmDurablyApplied(globalEventId: Long): CoreReplayCheckpoint {
        check(pendingGlobalEventId == globalEventId) {
            "No pending Core change with global event id $globalEventId"
        }
        checkpoint = checkpoint.copy(lastGlobalEventId = globalEventId)
        pendingGlobalEventId = null
        return checkpoint
    }

    fun abandonPendingChange(): CoreReplayDecision.ReconnectAndReplay {
        pendingGlobalEventId = null
        return CoreReplayDecision.ReconnectAndReplay(checkpoint)
    }

    private fun decideReplayRequired(payload: CoreReplayRequiredPayload): CoreReplayDecision {
        if (payload.requiredAction != RECONNECT_AND_REPLAY) {
            return CoreReplayDecision.FullBootstrap(payload.reasonCode)
        }
        val minimum = payload.minReplayableServerVersion
        return if (minimum == null || checkpoint.lastGlobalEventId >= minimum) {
            CoreReplayDecision.ReconnectAndReplay(checkpoint)
        } else {
            CoreReplayDecision.FullBootstrap(payload.reasonCode)
        }
    }

    companion object {
        private const val RECONNECT_AND_REPLAY = "reconnect_and_replay"

        /**
         * Starts replay at the exact version materialized by the snapshot. Omitting this header
         * would let syncd start at a newer version and lose changes committed between requests.
         */
        fun afterSnapshot(
            snapshotVersion: Long,
            coverage: CoreReplayCoverage,
        ): CoreReplaySession = CoreReplaySession(
            CoreReplayCheckpoint(snapshotVersion, coverage),
        )
    }
}

object CoreReplayFailurePolicy {
    /** HTTP 409 `REPLAY_WINDOW_EXPIRED` always requires a new authoritative snapshot. */
    fun onHttpFailure(statusCode: Int, error: CoreErrorDetail?): CoreReplayDecision? =
        if (statusCode == 409 && error?.code == "REPLAY_WINDOW_EXPIRED") {
            CoreReplayDecision.FullBootstrap(error.code)
        } else {
            null
        }
}
