package epigraph.sync.core.replica

import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreChangeEnvelope
import epigraph.sync.core.protocol.CoreChangesResponse
import epigraph.sync.core.protocol.CoreCompatibility
import epigraph.sync.core.protocol.CoreSnapshot
import epigraph.sync.core.replay.CoreReplayCheckpoint
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreSseEvent

/** Applies authoritative Core v1 state without coupling the wire layer to SQLDelight bindings. */
class CoreReplicaApplier(
    private val store: CoreReplicaStore,
) {
    suspend fun applySnapshot(
        snapshot: CoreSnapshot,
        capabilities: CoreCapabilities,
        originServerId: String? = null,
    ): CoreReplicaApplyResult.SnapshotApplied {
        validateCompatibility(capabilities)
        validateSnapshot(snapshot, capabilities)

        val records = snapshot.entities.map { entity ->
            CoreConfirmedRecord(
                key = CoreReplicaKey(snapshot.scopeId, entity.entityType, entity.entityId),
                serverVersion = entity.serverVersion,
                lamport = entity.lamport,
                record = entity.record,
                originServerId = originServerId,
            )
        }
        val tombstones = snapshot.tombstones.map { tombstone ->
            CoreConfirmedTombstone(
                key = CoreReplicaKey(snapshot.scopeId, tombstone.entityType, tombstone.entityId),
                serverVersion = tombstone.serverVersion,
                lamport = tombstone.lamport,
                deletedAtMs = tombstone.deletedAtMs,
                reasonCode = tombstone.reasonCode,
            )
        }
        val checkpoint = CoreReplayCheckpoint(
            coverage = CoreReplayCoverage.Filtered(snapshot.scopeId),
            lastGlobalEventId = snapshot.snapshotVersion,
        )

        return store.transaction {
            // WorkManager and the process-lifetime SSE supervisor can both bootstrap after a
            // cold start. Never let a slower HTTP response replace a replica that has already
            // advanced beyond its snapshot version.
            latestCheckpoint(CoreReplayCoverage.Filtered(snapshot.scopeId))?.let { current ->
                if (current.lastGlobalEventId > snapshot.snapshotVersion) {
                    return@transaction CoreReplicaApplyResult.SnapshotApplied(snapshot.scopeId, current)
                }
            }
            replaceConfirmedScope(snapshot.scopeId, records, tombstones)
            projectScope(snapshot.scopeId, records, tombstones)
            saveCheckpoint(checkpoint)
            CoreReplicaApplyResult.SnapshotApplied(snapshot.scopeId, checkpoint)
        }
    }

    suspend fun applyChange(
        event: CoreSseEvent.Change,
        coverage: CoreReplayCoverage,
        capabilities: CoreCapabilities,
        originServerId: String? = null,
    ): CoreReplicaApplyResult = applyChange(
        change = event.envelope,
        nextCheckpoint = CoreReplayCheckpoint(event.globalEventId, coverage),
        capabilities = capabilities,
        originServerId = originServerId,
    )

    /** Direct adapter target for [epigraph.sync.core.events.CoreDurableChangeSink]. */
    suspend fun applyChange(
        change: CoreChangeEnvelope,
        nextCheckpoint: CoreReplayCheckpoint,
        capabilities: CoreCapabilities,
        originServerId: String? = null,
    ): CoreReplicaApplyResult {
        validateCompatibility(capabilities)
        val event = CoreSseEvent.Change(nextCheckpoint.lastGlobalEventId, change)
        validateChange(event, nextCheckpoint.coverage, capabilities)

        return store.transaction {
            if (hasAppliedInboxEvent(event.globalEventId)) {
                saveCheckpoint(nextCheckpoint)
                return@transaction CoreReplicaApplyResult.ChangeAlreadyApplied(nextCheckpoint)
            }
            applyNewChange(change, event.globalEventId, originServerId)
            saveCheckpoint(nextCheckpoint)
            CoreReplicaApplyResult.ChangeApplied(nextCheckpoint)
        }
    }

    /** Applies the complete, unpaginated response from `GET /v1/changes` atomically. */
    suspend fun applyChanges(
        response: CoreChangesResponse,
        coverage: CoreReplayCoverage,
        capabilities: CoreCapabilities,
        originServerId: String? = null,
    ): CoreReplicaApplyResult.ChangesApplied {
        validateCompatibility(capabilities)
        validateChanges(response, coverage, capabilities)
        val checkpoint = CoreReplayCheckpoint(response.currentServerVersion, coverage)

        return store.transaction {
            var applied = 0
            var alreadyApplied = 0
            response.changes.forEach { change ->
                if (hasAppliedInboxEvent(change.serverVersion)) {
                    alreadyApplied++
                } else {
                    applyNewChange(change, change.serverVersion, originServerId)
                    applied++
                }
            }
            saveCheckpoint(checkpoint)
            pruneAppliedInbox()
            CoreReplicaApplyResult.ChangesApplied(applied, alreadyApplied, checkpoint)
        }
    }

    private suspend fun CoreReplicaTransaction.applyNewChange(
        change: CoreChangeEnvelope,
        globalEventId: Long,
        originServerId: String?,
    ) {
        val key = CoreReplicaKey(change.scopeId, change.entityType, change.entityId)
        when (change.op) {
            MERGE_OPERATION -> {
                val record = CoreConfirmedRecord(
                    key = key,
                    serverVersion = change.serverVersion,
                    lamport = change.lamport,
                    record = requireNotNull(change.patch),
                    originServerId = originServerId,
                )
                upsertConfirmed(record)
                projectConfirmed(record)
            }

            DELETE_OPERATION -> {
                val tombstone = CoreConfirmedTombstone(
                    key = key,
                    serverVersion = change.serverVersion,
                    lamport = change.lamport,
                    deletedAtMs = change.appliedAtMs,
                    reasonCode = null,
                )
                deleteConfirmed(tombstone)
                projectDeleted(tombstone)
            }
        }
        recordAppliedInboxEvent(
            CoreReplicaInboxEvent(
                globalEventId = globalEventId,
                scopeId = change.scopeId,
                entityType = change.entityType,
                entityId = change.entityId,
                operation = change.op,
            ),
        )
    }

    private fun validateSnapshot(snapshot: CoreSnapshot, capabilities: CoreCapabilities) {
        if (snapshot.schemaVersion !in
            EpigraphCoreWireProtocol.MIN_SNAPSHOT_SCHEMA_VERSION..EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION
        ) {
            throw CoreReplicaProtocolException(
                "Unsupported snapshot schema ${snapshot.schemaVersion}",
            )
        }
        if (capabilities.snapshotSchemaVersion != snapshot.schemaVersion) {
            throw CoreReplicaProtocolException("Snapshot schema does not match advertised capabilities")
        }
        if (snapshot.scopeId.isBlank()) {
            throw CoreReplicaProtocolException("Snapshot scope must not be blank")
        }
        if (
            snapshot.snapshotVersion < 0 ||
            snapshot.minReplayableServerVersion < 0 ||
            snapshot.minReplayableServerVersion > snapshot.snapshotVersion
        ) {
            throw CoreReplicaProtocolException("Invalid snapshot replay window")
        }
        if (snapshot.schemaVersion >= 3) {
            if (snapshot.complete != true) {
                throw CoreReplicaProtocolException("Core snapshot is not declared complete")
            }
            if (snapshot.snapshotId.isNullOrBlank() || snapshot.snapshotId.length > 128) {
                throw CoreReplicaProtocolException("Core snapshot identity is invalid")
            }
            if (
                snapshot.entityCount != snapshot.entities.size ||
                snapshot.tombstoneCount != snapshot.tombstones.size
            ) {
                throw CoreReplicaProtocolException("Core snapshot counts do not match its payload")
            }
        }

        val keys = HashSet<Pair<String, String>>()
        snapshot.entities.forEach { entity ->
            validateEntityIdentity(entity.entityType, entity.entityId, capabilities)
            validateVersion(entity.serverVersion, entity.lamport, snapshot.snapshotVersion)
            if (!keys.add(entity.entityType to entity.entityId)) {
                throw CoreReplicaProtocolException("Duplicate snapshot entity identity")
            }
        }
        snapshot.tombstones.forEach { tombstone ->
            validateEntityIdentity(tombstone.entityType, tombstone.entityId, capabilities)
            validateVersion(tombstone.serverVersion, tombstone.lamport, snapshot.snapshotVersion)
            if (!keys.add(tombstone.entityType to tombstone.entityId)) {
                throw CoreReplicaProtocolException("Snapshot entity and tombstone identities overlap")
            }
        }
    }

    private fun validateChange(
        event: CoreSseEvent.Change,
        coverage: CoreReplayCoverage,
        capabilities: CoreCapabilities,
    ) {
        val change = event.envelope
        if (event.globalEventId < 0 || change.serverVersion != event.globalEventId) {
            throw CoreReplicaProtocolException("SSE id must equal the change server version")
        }
        val filteredScope = (coverage as? CoreReplayCoverage.Filtered)?.scopeId
        if (filteredScope != null && filteredScope != change.scopeId) {
            throw CoreReplicaProtocolException("Change is outside the filtered replica scope")
        }
        if (change.scopeId.isBlank()) {
            throw CoreReplicaProtocolException("Change scope must not be blank")
        }
        validateEntityIdentity(change.entityType, change.entityId, capabilities)
        if (change.lamport < 0) {
            throw CoreReplicaProtocolException("Change lamport must not be negative")
        }
        when (change.op) {
            MERGE_OPERATION -> if (change.patch == null) {
                throw CoreReplicaProtocolException("Merge change must carry a patch")
            }

            DELETE_OPERATION -> if (change.patch != null) {
                throw CoreReplicaProtocolException("Delete change must not carry a patch")
            }

            else -> throw CoreReplicaProtocolException("Unsupported change operation ${change.op}")
        }
    }

    private fun validateChanges(
        response: CoreChangesResponse,
        coverage: CoreReplayCoverage,
        capabilities: CoreCapabilities,
    ) {
        if (
            response.currentServerVersion < 0 ||
            response.minReplayableServerVersion < 0 ||
            response.minReplayableServerVersion > response.currentServerVersion
        ) {
            throw CoreReplicaProtocolException("Invalid Core changes replay window")
        }
        var previousVersion = -1L
        response.changes.forEach { change ->
            if (change.serverVersion <= previousVersion || change.serverVersion > response.currentServerVersion) {
                throw CoreReplicaProtocolException("Core changes must have increasing server versions")
            }
            validateChange(CoreSseEvent.Change(change.serverVersion, change), coverage, capabilities)
            previousVersion = change.serverVersion
        }
    }

    private fun validateEntityIdentity(
        entityType: String,
        entityId: String,
        capabilities: CoreCapabilities,
    ) {
        if (entityType.isBlank() || entityId.isBlank()) {
            throw CoreReplicaProtocolException("Entity type and id must not be blank")
        }
        if (!EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, entityType)) {
            throw CoreReplicaProtocolException("Core did not advertise entity type $entityType")
        }
    }

    private fun validateCompatibility(capabilities: CoreCapabilities) {
        val compatibility = EpigraphCoreCompatibilityEvaluator.evaluate(capabilities)
        if (compatibility !is CoreCompatibility.Compatible) {
            throw CoreReplicaProtocolException("Incompatible Epigraph Core capabilities: $compatibility")
        }
    }

    private fun validateVersion(serverVersion: Long, lamport: Long, snapshotVersion: Long) {
        if (serverVersion < 0 || serverVersion > snapshotVersion || lamport < 0) {
            throw CoreReplicaProtocolException("Invalid entity version in snapshot")
        }
    }

    private companion object {
        const val MERGE_OPERATION = "merge"
        const val DELETE_OPERATION = "delete"
    }
}
