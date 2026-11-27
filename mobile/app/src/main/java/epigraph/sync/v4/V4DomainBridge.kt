package epigraph.sync.v4

/**
 * Domain adapter contract between [V4SyncEngine] and local Android library storage
 * (Comics, Novels, Books, Extension Repos/Inventory, and Extension Preferences).
 *
 * Implementations run purely against local SQLite / SharedPreferences — NEVER making
 * external internet calls inside sync convergence.
 */
internal interface V4DomainBridge {
    /**
     * Exports the current local library state across all enabled domains in one fast local pass
     * for initial pairing or full-state offline merge via `POST /v4/sync/bulk`.
     */
    suspend fun exportLocalSnapshot(
        serverId: String,
        profileId: String,
        clock: V4HlcClock,
    ): List<V4OutgoingItem>

    /**
     * Applies a batch of canonical V4 records (from `/v4/snapshot`, `/v4/changes`, or `/v4/events`)
     * into local SQLite / SharedPreferences inside a minimal number of atomic transactions.
     */
    suspend fun applyRemoteRecords(
        serverId: String,
        profileId: String,
        records: List<V4WireRecord>,
    )

    /**
     * Digests the current local state without stamping clocks or enqueuing anything. Must be
     * side-effect free: it is used to refresh the baseline after remote applies.
     */
    suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem>

    /**
     * Digests only the entities that [records] can have changed, for the baseline update after a
     * remote apply. Items for in-scope entities that no longer exist locally come back with
     * `deleted = true`, so stored digests for cascade removals are cleared too.
     *
     * The default falls back to a full [digestSnapshot] of this bridge's domain. Bridges that
     * can scope their reads override it.
     */
    suspend fun digestAffected(serverId: String, profileId: String, records: List<V4WireRecord>): List<V4DigestedItem> =
        digestSnapshot(serverId, profileId)

    /**
     * Exports and digests in one pass. The digests describe the same drafts that the export
     * stamps, so a domain can build its local state once. The default runs the two steps in turn.
     */
    suspend fun exportAndDigest(serverId: String, profileId: String, clock: V4HlcClock): V4ExportPass {
        val items = exportLocalSnapshot(serverId, profileId, clock)
        return V4ExportPass(items, digestSnapshot(serverId, profileId))
    }
}

/** One entity's local digest, as computed by [V4LocalDigest.of]. */
internal data class V4DigestedItem(val key: V4DigestKey, val digest: String, val deleted: Boolean)

/** Result of [V4DomainBridge.exportAndDigest]: outgoing items plus the digests of the same local state. */
internal data class V4ExportPass(val outgoing: List<V4OutgoingItem>, val digests: List<V4DigestedItem>)

internal class CompositeV4DomainBridge(private vararg val bridges: V4DomainBridge) : V4DomainBridge {
    override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) =
        bridges.flatMap { it.exportLocalSnapshot(serverId, profileId, clock) }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        for (bridge in bridges) bridge.applyRemoteRecords(serverId, profileId, records)
    }

    override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> =
        bridges.flatMap { it.digestSnapshot(serverId, profileId) }

    override suspend fun digestAffected(
        serverId: String,
        profileId: String,
        records: List<V4WireRecord>,
    ): List<V4DigestedItem> = bridges.flatMap { it.digestAffected(serverId, profileId, records) }

    override suspend fun exportAndDigest(serverId: String, profileId: String, clock: V4HlcClock): V4ExportPass {
        val outgoing = ArrayList<V4OutgoingItem>()
        val digests = ArrayList<V4DigestedItem>()
        for (bridge in bridges) {
            val pass = bridge.exportAndDigest(serverId, profileId, clock)
            outgoing += pass.outgoing
            digests += pass.digests
        }
        return V4ExportPass(outgoing, digests)
    }
}
