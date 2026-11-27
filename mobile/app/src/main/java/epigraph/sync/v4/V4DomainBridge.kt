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

    /**
     * Reads the local library for a local-edit pass. The read itself must not stamp, enqueue or write
     * anything, because the engine runs it outside its sync lock and may discard it. [V4LocalRead.digests]
     * describe the state that [V4LocalRead.commit] later exports under the lock.
     *
     * The default reads digests and defers the export to commit time.
     */
    suspend fun readLocal(serverId: String, profileId: String): V4LocalRead = V4LocalRead(
        digests = digestSnapshot(serverId, profileId),
        commit = { clock -> exportAndDigest(serverId, profileId, clock) },
    )

    /**
     * Reads only the works in [scope] for a scoped local-edit pass. A null scope is a full read.
     * The default covers nothing: a bridge that cannot scope its reads contributes no digests and no
     * outgoing items to a scoped pass, and its state is left for the next full pass.
     */
    suspend fun readLocalScoped(serverId: String, profileId: String, scope: V4LocalScope?): V4LocalRead =
        if (scope == null) {
            readLocal(serverId, profileId)
        } else {
            V4LocalRead(
                digests = emptyList(),
                commit = { V4ExportPass(emptyList(), emptyList(), stored = emptyMap()) },
            )
        }
}

/** Works touched by a scoped local-edit pass, keyed by canonical work key. */
internal data class V4LocalScope(val workKeys: Set<String>)

/**
 * What one local-edit pass covers. [generation] is the pending-store generation read before the scope was
 * taken. [scope] is null for a full pass.
 */
internal data class V4LocalPlan(val generation: Long, val scope: V4LocalScope?)

/** One entity's local digest, as computed by [V4LocalDigest.of]. */
internal data class V4DigestedItem(val key: V4DigestKey, val digest: String, val deleted: Boolean)

/**
 * Result of [V4DomainBridge.exportAndDigest]: outgoing items plus the digests of the same local state.
 * [stored] is the baseline digest rows a scoped commit covers (live and tombstoned, read in the same
 * transaction as the export). Null means the engine loads the whole profile baseline itself.
 */
internal data class V4ExportPass(
    val outgoing: List<V4OutgoingItem>,
    val digests: List<V4DigestedItem>,
    val stored: Map<V4DigestKey, V4StoredDigest>? = null,
)

/**
 * Result of [V4DomainBridge.readLocal]. [digests] describe the read state. [commit] stamps that state with
 * the given clock, applies its retractions, and returns the outgoing items together with the digests of the
 * exact state it exported. It must run under the engine's sync lock.
 */
internal class V4LocalRead(
    val digests: List<V4DigestedItem>,
    val commit: suspend (V4HlcClock) -> V4ExportPass,
)

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

    override suspend fun readLocal(serverId: String, profileId: String): V4LocalRead =
        readLocalScoped(serverId, profileId, scope = null)

    /**
     * A scoped read is the comic scope and nothing else: every other bridge returns an empty read, so
     * a scoped commit never writes their full-state digests.
     */
    override suspend fun readLocalScoped(serverId: String, profileId: String, scope: V4LocalScope?): V4LocalRead {
        val reads = bridges.map { it.readLocalScoped(serverId, profileId, scope) }
        return V4LocalRead(
            digests = reads.flatMap { it.digests },
            commit = { clock ->
                val outgoing = ArrayList<V4OutgoingItem>()
                val digests = ArrayList<V4DigestedItem>()
                // A scoped pass reports stored digests only when a bridge covered them; null keeps the full load.
                var stored: HashMap<V4DigestKey, V4StoredDigest>? = null
                for (read in reads) {
                    val pass = read.commit(clock)
                    outgoing += pass.outgoing
                    digests += pass.digests
                    pass.stored?.let { stored = (stored ?: HashMap()).apply { putAll(it) } }
                }
                V4ExportPass(outgoing, digests, stored)
            },
        )
    }
}
