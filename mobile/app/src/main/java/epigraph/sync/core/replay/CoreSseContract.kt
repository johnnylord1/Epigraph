package epigraph.sync.core.replay

import epigraph.sync.core.protocol.CoreChangeEnvelope
import kotlinx.serialization.Serializable

/** Events emitted by `GET /v1/events` in the legacy-compatible Syncd wire protocol v1. */
sealed interface CoreSseEvent {
    /** [globalEventId] is the Core-wide server version, not a per-scope sequence. */
    data class Change(
        val globalEventId: Long,
        val envelope: CoreChangeEnvelope,
    ) : CoreSseEvent

    data object Ping : CoreSseEvent

    data class ReplayRequired(val payload: CoreReplayRequiredPayload) : CoreSseEvent

    /**
     * `/v1/sync/status` announces new catalog revisions for the scope. Sent only to streams that
     * asked for it; it has no id and does not move the replay cursor.
     */
    data class CatalogRevision(val payload: CoreCatalogRevisionPayload) : CoreSseEvent
}

@Serializable
data class CoreCatalogRevisionPayload(val scopeId: String)

@Serializable
data class CoreReplayRequiredPayload(
    val reasonCode: String,
    val requiredAction: String,
    val currentServerVersion: Long? = null,
    val minReplayableServerVersion: Long? = null,
    val lastSentVersion: Long? = null,
)

class CoreSseProtocolException(message: String, cause: Throwable? = null) :
    IllegalArgumentException(message, cause)
