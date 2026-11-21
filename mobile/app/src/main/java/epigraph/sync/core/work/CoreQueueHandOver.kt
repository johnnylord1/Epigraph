package epigraph.sync.core.work

import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.replica.clearCoreReplicaHistory
import epigraph.sync.core.replica.discardCoreReplicaWaits
import yokai.data.DatabaseHandler

/**
 * Hands the local outbox to the Core this phone now syncs with.
 *
 * Pairing another Core (or a reinstalled desktop) keeps the outbox: every row there is a change the
 * new Core has not seen either. Two kinds of rows only made sense for the previous Core, though,
 * and both kept the library repair from sending a work again, so the new Core never received it:
 * - rows the previous Core refused (`blocked:`) were never retried, and the new Core may accept them;
 * - acknowledgements the previous Core gave wait for a server version only it would confirm.
 *
 * The first run against a server this phone has not handed its queue to retries the refused rows
 * and drops those waits, once. A phone that already switched Cores before this existed gets the
 * same once on its next sync. A row the new Core refuses again stays refused.
 */
class CoreQueueHandOver(
    private val database: DatabaseHandler,
    private val owner: Owner,
) {
    /** The server the outbox was last handed to; kept apart from the replica so re-pairing does not reset it. */
    interface Owner {
        fun get(): String?
        fun set(serverId: String)
    }

    data class Released(val requeued: Long, val waits: Long)

    /** Returns what was released, or null when [serverId] already owns the queue. */
    suspend fun handTo(serverId: String): Released? {
        if (serverId.isBlank() || serverId == LEGACY_UNBOUND_SERVER_ID) return null
        val previousServerId = owner.get()
        if (previousServerId == serverId) return null
        val released = database.await(inTransaction = true) {
            val requeued = aethon_syncQueries.blockedMutationCount().executeAsOne()
            val waits = aethon_syncQueries.replicaWaitCount().executeAsOne()
            // The previous Core's worker may have written replay state while pairing was in progress.
            if (previousServerId != null) clearCoreReplicaHistory()
            aethon_syncQueries.requeueAllBlockedMutations()
            discardCoreReplicaWaits()
            Released(requeued, waits)
        }
        // Written after the commit: a crash in between only repeats the same release.
        owner.set(serverId)
        return released
    }
}
