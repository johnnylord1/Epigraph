package epigraph.sync.core.work

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.CoreCapabilities

/** Explicit hand-off point for snapshot/replay integration owned by the replica layer. */
fun interface CoreReplicaSyncPort {
    suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome

    /**
     * Whether the confirmed Core snapshot/replay stage succeeded in the last [synchronize] call,
     * even if an independent catalog stage asked for a retry. Null when not split by stage.
     */
    fun coreReplicaApplied(): Boolean? = null
}

enum class CoreReplicaSyncOutcome {
    APPLIED,
    DEFERRED,
    RETRY,
    NEEDS_USER_ACTION,
}

object DeferredCoreReplicaSync : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome = CoreReplicaSyncOutcome.DEFERRED
}
