package epigraph.sync.v4

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import tachiyomi.data.V4_outbox
import tachiyomi.data.V4_pending_extension_prefs
import tachiyomi.data.V4_sync_state
import yokai.data.Database
import java.util.UUID

data class V4SyncCursorState(
    val serverId: String,
    val profileId: String,
    val serverSeq: Long = 0L,
    val minReplayableSeq: Long = 0L,
    val lastSnapshotEtag: String? = null,
    val hlcLastTsMs: Long = 0L,
    val hlcLastCounter: Long = 0L,
    val clockOffsetMs: Long = 0L,
    val initialSyncCompleted: Boolean = false,
)

/**
 * Single durable SQLDelight store for Sync V4 state, identity mappings, transactional outbox,
 * and deferred extension preferences. Replaces the legacy 3 outboxes and 10 identity tables.
 */
class SqlDelightV4SyncStore(
    private val database: Database,
    private val json: Json = V4CoreHttpClient.DEFAULT_JSON,
    private val wallClockMs: () -> Long = System::currentTimeMillis,
) {
    private val queries get() = database.v4_syncQueries

    fun loadState(serverId: String, profileId: String): V4SyncCursorState {
        val row: V4_sync_state = queries.selectV4SyncState(serverId, profileId).executeAsOneOrNull()
            ?: return V4SyncCursorState(serverId = serverId, profileId = profileId)
        return V4SyncCursorState(
            serverId = row.server_id,
            profileId = row.profile_id,
            serverSeq = row.server_seq,
            minReplayableSeq = row.min_replayable_seq,
            lastSnapshotEtag = row.last_snapshot_etag,
            hlcLastTsMs = row.hlc_last_ts_ms,
            hlcLastCounter = row.hlc_last_counter,
            clockOffsetMs = row.clock_offset_ms,
            initialSyncCompleted = row.initial_sync_completed != 0L,
        )
    }

    fun saveState(state: V4SyncCursorState) {
        queries.upsertV4SyncState(
            serverId = state.serverId,
            profileId = state.profileId,
            serverSeq = state.serverSeq,
            minReplayableSeq = state.minReplayableSeq,
            lastSnapshotEtag = state.lastSnapshotEtag,
            hlcLastTsMs = state.hlcLastTsMs,
            hlcLastCounter = state.hlcLastCounter,
            clockOffsetMs = state.clockOffsetMs,
            initialSyncCompleted = if (state.initialSyncCompleted) 1L else 0L,
            updatedAtMs = wallClockMs(),
        )
    }

    /**
     * Enqueues a V4 mutation inside the caller's existing database transaction (or its own).
     * Coalesces an older edit when all its fields survive in the newer state.
     */
    fun enqueueOutbox(
        serverId: String,
        profileId: String,
        domain: String,
        entityType: String,
        entityKey: String,
        deleted: Boolean,
        hlc: V4Hlc,
        payload: JsonElement,
        clientMutationId: String = UUID.randomUUID().toString(),
    ): String = database.transactionWithResult {
        val previous = queries.selectLastV4OutboxForEntity(
            serverId = serverId,
            profileId = profileId,
            entityType = entityType,
            entityKey = entityKey,
        ).executeAsOneOrNull()
        if (previous != null && previous.canCoalesce(deleted, hlc, payload)) {
            queries.deleteV4OutboxByMutationIds(listOf(previous.client_mutation_id))
        }
        queries.enqueueV4Outbox(
            clientMutationId = clientMutationId,
            serverId = serverId,
            profileId = profileId,
            domain = domain,
            entityType = entityType,
            entityKey = entityKey,
            deleted = if (deleted) 1L else 0L,
            hlcTsMs = hlc.tsMs,
            hlcCounter = hlc.counter,
            hlcDeviceId = hlc.deviceId,
            payloadJson = json.encodeToString(payload),
            createdAtMs = wallClockMs(),
        )
        clientMutationId
    }

    private fun V4_outbox.canCoalesce(deleted: Boolean, clock: V4Hlc, payload: JsonElement): Boolean {
        if ((this.deleted != 0L) != deleted || clock <= V4Hlc(hlc_ts_ms, hlc_counter, hlc_device_id)) return false
        if (deleted) return true
        val newer = payload as? JsonObject ?: return false
        val older = json.parseToJsonElement(payload_json) as? JsonObject ?: return false
        if (!newer.keys.containsAll(older.keys)) return false
        if ("explicitResetHlc" in older || "explicitResetHlc" in newer) return false
        if (older["isRead"] == JsonPrimitive(true) && newer["isRead"] != JsonPrimitive(true)) return false
        return listOf("lastPageRead", "progressPercent").all { field ->
            val previous = (older[field] as? JsonPrimitive)?.doubleOrNull ?: return@all true
            val next = (newer[field] as? JsonPrimitive)?.doubleOrNull
            next != null && next >= previous
        }
    }

    fun loadDueOutbox(serverId: String, profileId: String, policy: V4SyncDomainPolicy, limit: Long = 250L): List<V4_outbox> =
        if (policy.outboxDomains.isEmpty()) emptyList() else
        queries.selectV4OutboxDue(
            serverId = serverId,
            profileId = profileId,
            domains = policy.outboxDomains,
            syncComics = if (policy.syncComics) 1L else 0L,
            syncNovels = if (policy.syncNovels) 1L else 0L,
            reconcileComicRepositories = if (policy.reconcileComicRepositories) 1L else 0L,
            reconcileComicExtensions = if (policy.reconcileComicExtensions) 1L else 0L,
            reconcileNovelRepositories = if (policy.reconcileNovelRepositories) 1L else 0L,
            reconcileNovelPlugins = if (policy.reconcileNovelPlugins) 1L else 0L,
            nowMs = wallClockMs(),
            limit = limit,
        ).executeAsList()

    fun countPendingOutbox(serverId: String, profileId: String): Long =
        queries.countV4OutboxPending(serverId, profileId).executeAsOne()

    fun countPendingOutbox(serverId: String, profileId: String, policy: V4SyncDomainPolicy): Long =
        if (policy.outboxDomains.isEmpty()) 0L else
        queries.countV4OutboxPendingForDomains(
            serverId = serverId,
            profileId = profileId,
            domains = policy.outboxDomains,
            syncComics = if (policy.syncComics) 1L else 0L,
            syncNovels = if (policy.syncNovels) 1L else 0L,
            reconcileComicRepositories = if (policy.reconcileComicRepositories) 1L else 0L,
            reconcileComicExtensions = if (policy.reconcileComicExtensions) 1L else 0L,
            reconcileNovelRepositories = if (policy.reconcileNovelRepositories) 1L else 0L,
            reconcileNovelPlugins = if (policy.reconcileNovelPlugins) 1L else 0L,
        ).executeAsOne()

    fun acknowledgeMutations(mutationIds: Collection<String>) {
        if (mutationIds.isEmpty()) return
        mutationIds.chunked(500).forEach { chunk ->
            queries.deleteV4OutboxByMutationIds(chunk)
        }
    }

    fun recordFailure(clientMutationId: String, backoffMs: Long, error: String) {
        queries.recordV4OutboxFailure(
            nextRetryAtMs = wallClockMs() + backoffMs.coerceAtLeast(1_000L),
            lastError = error.take(500),
            clientMutationId = clientMutationId,
        )
    }

    fun upsertEntityMap(
        serverId: String,
        profileId: String,
        domain: String,
        entityType: String,
        entityKey: String,
        localId: String?,
        hlc: V4Hlc,
        deleted: Boolean,
    ) {
        queries.upsertV4EntityMap(
            serverId = serverId,
            profileId = profileId,
            domain = domain,
            entityType = entityType,
            entityKey = entityKey,
            localId = localId,
            hlcTsMs = hlc.tsMs,
            hlcCounter = hlc.counter,
            hlcDeviceId = hlc.deviceId,
            deleted = if (deleted) 1L else 0L,
            updatedAtMs = wallClockMs(),
        )
    }

    fun findLocalId(
        serverId: String,
        profileId: String,
        entityType: String,
        entityKey: String,
    ): String? = queries.selectV4EntityMapByKey(serverId, profileId, entityType, entityKey)
        .executeAsOneOrNull()
        ?.local_id

    fun findEntityKey(
        serverId: String,
        profileId: String,
        entityType: String,
        localId: String,
    ): String? = queries.selectV4EntityMapByLocalId(serverId, profileId, entityType, localId)
        .executeAsOneOrNull()
        ?.entity_key

    fun savePendingExtensionPref(
        serverId: String,
        profileId: String,
        kind: String,
        sourceOrPluginId: String,
        prefKey: String,
        payloadJson: String,
        hlc: V4Hlc,
    ) {
        queries.upsertV4PendingExtensionPref(
            kind = extensionPrefsStorageKey(serverId, profileId, kind),
            sourceOrPluginId = sourceOrPluginId,
            prefKey = prefKey,
            payloadJson = payloadJson,
            hlcTsMs = hlc.tsMs,
            hlcCounter = hlc.counter,
            hlcDeviceId = hlc.deviceId,
            updatedAtMs = wallClockMs(),
        )
    }

    fun loadPendingExtensionPrefs(
        serverId: String,
        profileId: String,
        kind: String,
    ): List<V4_pending_extension_prefs> = queries.selectV4PendingExtensionPrefsForKind(
        extensionPrefsStorageKey(serverId, profileId, kind),
    ).executeAsList()

    fun deletePendingExtensionPref(serverId: String, profileId: String, kind: String, sourceOrPluginId: String, prefKey: String) {
        queries.deleteV4PendingExtensionPref(extensionPrefsStorageKey(serverId, profileId, kind), sourceOrPluginId, prefKey)
    }

    private fun extensionPrefsStorageKey(serverId: String, profileId: String, kind: String) =
        extensionPrefsServerPrefix(serverId) + json.encodeToString(profileId) + "/" + kind

    private fun extensionPrefsServerPrefix(serverId: String) = json.encodeToString(serverId) + "/"

    fun clearServerState(serverId: String, domainProgress: V4SyncDomainProgress? = null) {
        database.transaction {
            queries.deleteV4OutboxForServer(serverId)
            queries.deleteV4EntityMapForServer(serverId)
            queries.deleteV4SyncStateForServer(serverId)
            val serverKey = json.encodeToString(serverId)
            queries.clearV4PendingExtensionPrefsForServer("$serverKey/", "$serverKey" + "0")
        }
        domainProgress?.clear(serverId)
    }
}
