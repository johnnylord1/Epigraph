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
}

/** One entity's local digest, as computed by [V4LocalDigest.of]. */
internal data class V4DigestedItem(val key: V4DigestKey, val digest: String, val deleted: Boolean)

internal class CompositeV4DomainBridge(private vararg val bridges: V4DomainBridge) : V4DomainBridge {
    override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) =
        bridges.flatMap { it.exportLocalSnapshot(serverId, profileId, clock) }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        for (bridge in bridges) bridge.applyRemoteRecords(serverId, profileId, records)
    }

    override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> =
        bridges.flatMap { it.digestSnapshot(serverId, profileId) }
}
