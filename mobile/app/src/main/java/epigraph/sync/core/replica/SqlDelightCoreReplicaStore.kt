package epigraph.sync.core.replica

import epigraph.sync.core.outbox.CoreLamportSource
import epigraph.sync.core.replay.CoreReplayCheckpoint
import epigraph.sync.core.replay.CoreReplayCoverage
import java.security.MessageDigest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.Json
import tachiyomi.data.Aethon_syncQueries
import yokai.data.DatabaseHandler

/**
 * Durable mirror of state confirmed by Epigraph Core/syncd.
 *
 * This store intentionally writes only the confirmed mirror and its shared Lamport clock.
 * Projection into manga, novel or book domain tables belongs to entity-specific adapters, and
 * local outbox rows are never touched.
 */
class SqlDelightCoreReplicaStore(
    private val databaseHandler: DatabaseHandler,
    private val projection: CoreReplicaProjection? = null,
    private val clock: () -> Long = System::currentTimeMillis,
) : CoreReplicaStore, CoreReplicaCheckpointReader, CoreReplicaRecordReader,
    CoreReplicaTombstoneReader, CoreReplicaCheckpointResetter {
    override suspend fun <T> transaction(block: suspend CoreReplicaTransaction.() -> T): T =
        databaseHandler.await(inTransaction = true) {
            // The batch only adds a context element, so the block stays on the transaction thread.
            val batch = CoreProjectionBatch()
            withContext(batch) {
                SqlDelightCoreReplicaTransaction(this@await, aethon_syncQueries, projection, clock).block()
                    .also { batch.flush() }
            }
        }

    override suspend fun latestCheckpoint(coverage: CoreReplayCoverage): CoreReplayCheckpoint? =
        databaseHandler.await {
            val key = coverageKey(coverage)
            val row = aethon_syncQueries.selectCoreReplicaCheckpoint(key).executeAsOneOrNull()
                ?: return@await null
            when (coverage) {
                CoreReplayCoverage.AllGrantedScopes -> {
                    require(row.coverage_type == ALL_COVERAGE_TYPE && row.scope_id == null) {
                        "stored Core checkpoint coverage does not match ALL"
                    }
                }
                is CoreReplayCoverage.Filtered -> {
                    require(row.coverage_type == FILTERED_COVERAGE_TYPE && row.scope_id == coverage.scopeId) {
                        "stored Core checkpoint coverage does not match filtered scope"
                    }
                }
            }
            CoreReplayCheckpoint(row.last_global_event_id, coverage)
        }

    override suspend fun reset() {
        databaseHandler.await(inTransaction = true) {
            // A replay cursor is scoped by server history. Pairing a different Core must not
            // reuse a numeric cursor from the previous server; clear inbox deduplication too,
            // otherwise a coincident global event id could be discarded after re-pairing.
            aethon_syncQueries.deleteAllCoreReplicaCheckpoints()
            aethon_syncQueries.deleteAllCoreReplicaInboxEvents()
            // Confirmed rows describe the previous server. A snapshot diffed against them would read
            // every local work the new Core has not received yet as a remote removal and demote it.
            // Local library rows stay untouched; the library repairs publish what the Core lacks.
            aethon_syncQueries.deleteAllCoreReplicaRecords()
            aethon_syncQueries.deleteAllCoreReplicaTombstones()
        }
    }

    override suspend fun confirmedRecords(
        scopeId: String,
        entityTypes: Set<String>,
    ): List<CoreConfirmedRecord> {
        require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        if (entityTypes.isEmpty()) return emptyList()
        return databaseHandler.await {
            aethon_syncQueries.selectCoreReplicaRecordsByScope(scopeId).executeAsList()
                .asSequence()
                .filter { it.entity_type in entityTypes }
                .map { row ->
                    CoreConfirmedRecord(
                        key = CoreReplicaKey(row.scope_id, row.entity_type, row.entity_id),
                        serverVersion = row.server_version,
                        lamport = row.lamport,
                        record = CoreReplicaPayloadHasher.parse(row.record_json),
                    )
                }
                .toList()
        }
    }

    override suspend fun confirmedTombstones(
        scopeId: String,
        entityTypes: Set<String>,
    ): List<CoreConfirmedTombstone> {
        require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        if (entityTypes.isEmpty()) return emptyList()
        return databaseHandler.await {
            aethon_syncQueries.selectCoreReplicaTombstonesByScope(scopeId).executeAsList()
                .filter { it.entity_type in entityTypes }
                .map { row ->
                    CoreConfirmedTombstone(
                        key = CoreReplicaKey(row.scope_id, row.entity_type, row.entity_id),
                        serverVersion = row.server_version,
                        lamport = row.lamport,
                        deletedAtMs = row.deleted_at,
                        reasonCode = row.reason_code,
                    )
                }
        }
    }

    /**
     * Confirms this device's applied writes from the records Core acknowledged them with, all in
     * one transaction, exactly as their echo from the change feed would: the mirror takes the
     * record, the domain tables are projected unless newer local work holds the entity, and the
     * replica wait the acknowledgement created is settled. The echo arriving later is a no-op.
     */
    suspend fun confirmOwnWrites(records: List<CoreConfirmedRecord>) {
        if (records.isEmpty()) return
        records.forEach { record ->
            requireKey(record.key)
            require(record.serverVersion >= 0 && record.lamport >= 0) { "record versions must not be negative" }
        }
        databaseHandler.await(inTransaction = true) {
            val batch = CoreProjectionBatch()
            withContext(batch) {
                val queries = aethon_syncQueries
                val transaction = SqlDelightCoreReplicaTransaction(this@await, queries, projection, clock)
                // Everything a record-by-record confirm would look up, read once per chunk instead.
                val applied = records.map { it.serverVersion }.distinct().chunked(BULK_CHUNK)
                    .flatMapTo(HashSet()) { queries.selectAppliedCoreReplicaInboxEvents(it).executeAsList() }
                val held = HashMap<CoreReplicaKey, Long>()
                val tombstoned = HashSet<CoreReplicaKey>()
                val groups = records.groupBy({ it.key.scopeId to it.key.entityType }, { it.key.entityId })
                groups.forEach { (group, entityIds) ->
                    val (scopeId, entityType) = group
                    entityIds.distinct().chunked(BULK_CHUNK).forEach { chunk ->
                        queries.selectCoreReplicaRecordVersionsByIds(scopeId, entityType, chunk).executeAsList()
                            .forEach { row ->
                                held.merge(CoreReplicaKey(scopeId, entityType, row.entity_id), row.server_version, ::maxOf)
                            }
                        queries.selectCoreReplicaTombstoneVersionsByIds(scopeId, entityType, chunk).executeAsList()
                            .forEach { row ->
                                val key = CoreReplicaKey(scopeId, entityType, row.entity_id)
                                held.merge(key, row.server_version, ::maxOf)
                                tombstoned += key
                            }
                        if (projection != null) {
                            val outbox = queries.selectOutboxEntitiesBlockingReplica(scopeId, entityType, chunk)
                                .executeAsList()
                                .toHashSet()
                            val required = HashMap<String, Long>()
                            queries.selectReplicaWaitVersionsForEntities(scopeId, entityType, chunk, chunk)
                                .executeAsList()
                                .forEach { row ->
                                    required.merge(row.entity_id, row.required_server_version, ::maxOf)
                                    row.canonical_entity_id?.let { id ->
                                        required.merge(id, row.required_server_version, ::maxOf)
                                    }
                                }
                            batch.preloadBlockers(scopeId, entityType, chunk, outbox, required)
                        }
                    }
                }
                projection?.preload(this@await, records)
                var maxLamport = -1L
                records.forEach { record ->
                    // Its echo already arrived and was applied; only the wait may remain.
                    if (!applied.add(record.serverVersion)) return@forEach
                    // A newer version already in the mirror settles this write too.
                    if (record.serverVersion >= (held[record.key] ?: NO_VERSION)) {
                        if (tombstoned.remove(record.key)) {
                            queries.deleteCoreReplicaTombstone(
                                record.key.scopeId,
                                record.key.entityType,
                                record.key.entityId,
                            )
                        }
                        val canonicalRecord = CoreReplicaPayloadHasher.canonicalJson(record.record)
                        queries.upsertCoreReplicaRecord(
                            scopeId = record.key.scopeId,
                            entityType = record.key.entityType,
                            entityId = record.key.entityId,
                            serverVersion = record.serverVersion,
                            lamport = record.lamport,
                            recordJson = canonicalRecord,
                            payloadSha256 = CoreReplicaPayloadHasher.sha256(canonicalRecord),
                        )
                        held[record.key] = record.serverVersion
                        maxLamport = maxOf(maxLamport, record.lamport)
                        projection?.upsert(this@await, record)
                    }
                    // The echo from the live stream or /v1/changes is then skipped as already applied.
                    transaction.recordAppliedInboxEvent(
                        CoreReplicaInboxEvent(
                            globalEventId = record.serverVersion,
                            scopeId = record.key.scopeId,
                            entityType = record.key.entityType,
                            entityId = record.key.entityId,
                            operation = "merge",
                        ),
                    )
                }
                batch.flush()
                if (maxLamport >= 0) queries.advanceCoreLamport(maxLamport)
                // The waits these acknowledgements created, settled against what the mirror now holds.
                groups.forEach { (group, entityIds) ->
                    val (scopeId, entityType) = group
                    entityIds.distinct().chunked(BULK_CHUNK).forEach { chunk ->
                        queries.reconcileReplicaWaitsForEntities(scopeId, entityType, chunk, chunk)
                    }
                }
            }
        }
    }

    /**
     * Projects the confirmed record already held for [key]. A local write the Core superseded never
     * comes back as a change, and the newer record it lost to may have arrived while that write was
     * still pending, when projecting it would have undone the pending edit.
     */
    suspend fun projectHeldRecord(key: CoreReplicaKey) {
        requireKey(key)
        databaseHandler.await(inTransaction = true) {
            val row = aethon_syncQueries
                .selectCoreReplicaRecord(key.scopeId, key.entityType, key.entityId)
                .executeAsOneOrNull()
                ?: return@await
            projection?.upsert(
                this,
                CoreConfirmedRecord(
                    key = key,
                    serverVersion = row.server_version,
                    lamport = row.lamport,
                    record = CoreReplicaPayloadHasher.parse(row.record_json),
                ),
            )
        }
    }

    private fun requireKey(key: CoreReplicaKey) {
        require(key.scopeId.isNotBlank() && key.entityType.isNotBlank() && key.entityId.isNotBlank()) {
            "replica key fields must not be blank"
        }
    }

    private companion object {
        const val NO_VERSION = -1L
        const val BULK_CHUNK = 400
        const val ALL_COVERAGE_TYPE = "ALL"
        const val FILTERED_COVERAGE_TYPE = "FILTERED"
        const val ALL_COVERAGE_KEY = "ALL"
        const val FILTERED_COVERAGE_PREFIX = "FILTERED:"

        fun coverageKey(coverage: CoreReplayCoverage): String = when (coverage) {
            CoreReplayCoverage.AllGrantedScopes -> ALL_COVERAGE_KEY
            is CoreReplayCoverage.Filtered -> "$FILTERED_COVERAGE_PREFIX${coverage.scopeId}"
        }
    }
}

/** Atomic, process-safe Lamport allocator backed by the same SQLDelight database as the outbox. */
/**
 * The desktop stamps its own writes with wall-clock milliseconds, and the Core rejects a write
 * whose Lamport is not above a delete's. Never falling behind the wall clock keeps a phone edit made
 * after a desktop delete it has not pulled yet from losing to that delete.
 */
class SqlDelightCoreLamportSource(
    private val databaseHandler: DatabaseHandler,
    private val wallClock: () -> Long = System::currentTimeMillis,
) : CoreLamportSource {
    override suspend fun nextLamport(): Long = databaseHandler.await(inTransaction = true) {
        val current = aethon_syncQueries.selectCoreLamport().executeAsOneOrNull() ?: 0L
        check(current < Long.MAX_VALUE) { "Core Lamport clock is exhausted" }
        val next = maxOf(current + 1, wallClock())
        aethon_syncQueries.advanceCoreLamport(next)
        next
    }

    override suspend fun nextLamports(count: Int): List<Long> {
        require(count >= 0) { "Lamport count must not be negative" }
        if (count == 0) return emptyList()
        return databaseHandler.await(inTransaction = true) {
            val current = aethon_syncQueries.selectCoreLamport().executeAsOneOrNull() ?: 0L
            check(current <= Long.MAX_VALUE - count) { "Core Lamport clock is exhausted" }
            val first = maxOf(current + 1, wallClock())
            check(first <= Long.MAX_VALUE - (count - 1)) { "Core Lamport clock is exhausted" }
            val last = first + (count - 1)
            aethon_syncQueries.advanceCoreLamport(last)
            List(count) { first + it }
        }
    }
}

private class SqlDelightCoreReplicaTransaction(
    private val database: yokai.data.Database,
    private val queries: Aethon_syncQueries,
    private val projection: CoreReplicaProjection?,
    private val clock: () -> Long,
) : CoreReplicaTransaction {
    override suspend fun latestCheckpoint(coverage: CoreReplayCoverage): CoreReplayCheckpoint? {
        val (coverageKey, expectedType, expectedScopeId) = when (coverage) {
            CoreReplayCoverage.AllGrantedScopes -> Triple(ALL_COVERAGE_KEY, ALL, null)
            is CoreReplayCoverage.Filtered -> Triple(
                "$FILTERED_PREFIX${coverage.scopeId}",
                FILTERED,
                coverage.scopeId,
            )
        }
        val row = queries.selectCoreReplicaCheckpoint(coverageKey).executeAsOneOrNull()
            ?: return null
        require(row.coverage_type == expectedType && row.scope_id == expectedScopeId) {
            "stored Core checkpoint coverage does not match transaction request"
        }
        return CoreReplayCheckpoint(row.last_global_event_id, coverage)
    }

    override suspend fun replaceConfirmedScope(
        scopeId: String,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    ) {
        require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        records.forEach { requireScope(it.key, scopeId) }
        tombstones.forEach { requireScope(it.key, scopeId) }

        // Only an authoritative snapshot calls this method. Incremental pages never infer deletes.
        pendingPreviousRecords = queries.selectCoreReplicaRecordsByScope(scopeId).executeAsList().map { row ->
            CoreConfirmedRecord(
                key = CoreReplicaKey(row.scope_id, row.entity_type, row.entity_id),
                serverVersion = row.server_version,
                lamport = row.lamport,
                record = CoreReplicaPayloadHasher.parse(row.record_json),
            )
        }
        pendingPreviousTombstones = queries.selectCoreReplicaTombstonesByScope(scopeId).executeAsList().map { row ->
            CoreConfirmedTombstone(
                key = CoreReplicaKey(row.scope_id, row.entity_type, row.entity_id),
                serverVersion = row.server_version,
                lamport = row.lamport,
                deletedAtMs = row.deleted_at,
                reasonCode = row.reason_code,
            )
        }
        queries.deleteCoreReplicaRecordsByScope(scopeId)
        queries.deleteCoreReplicaTombstonesByScope(scopeId)
        records.forEach(::writeRecord)
        tombstones.forEach(::writeTombstone)
    }

    override suspend fun projectScope(
        scopeId: String,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    ) {
        projection?.replaceScope(
            database,
            scopeId,
            pendingPreviousRecords,
            pendingPreviousTombstones,
            records,
            tombstones,
        )
        records.forEach(::reconcileReplicaWait)
        tombstones.forEach(::reconcileReplicaWait)
        pendingPreviousRecords = emptyList()
        pendingPreviousTombstones = emptyList()
    }

    override suspend fun hasAppliedInboxEvent(globalEventId: Long): Boolean {
        require(globalEventId >= 0) { "globalEventId must not be negative" }
        return queries.isCoreReplicaInboxEventApplied(globalEventId).executeAsOne()
    }

    override suspend fun upsertConfirmed(record: CoreConfirmedRecord): Boolean {
        requireKey(record.key)
        require(record.serverVersion >= 0 && record.lamport >= 0) {
            "record versions must not be negative"
        }
        if (record.serverVersion < currentVersion(record.key)) return false

        queries.deleteCoreReplicaTombstone(
            record.key.scopeId,
            record.key.entityType,
            record.key.entityId,
        )
        writeRecord(record)
        return true
    }

    override suspend fun projectConfirmed(record: CoreConfirmedRecord) {
        projection?.upsert(database, record)
        reconcileReplicaWait(record)
    }

    override suspend fun deleteConfirmed(tombstone: CoreConfirmedTombstone): Boolean {
        requireKey(tombstone.key)
        require(tombstone.serverVersion >= 0 && tombstone.lamport >= 0 && tombstone.deletedAtMs >= 0) {
            "tombstone versions and deletion time must not be negative"
        }
        if (tombstone.serverVersion < currentVersion(tombstone.key)) return false

        val previousRecord = queries
            .selectCoreReplicaRecord(
                tombstone.key.scopeId,
                tombstone.key.entityType,
                tombstone.key.entityId,
            )
            .executeAsOneOrNull()
            ?.let { row ->
                CoreConfirmedRecord(
                    key = tombstone.key,
                    serverVersion = row.server_version,
                    lamport = row.lamport,
                    record = CoreReplicaPayloadHasher.parse(row.record_json),
                )
            }
        queries.deleteCoreReplicaRecord(
            tombstone.key.scopeId,
            tombstone.key.entityType,
            tombstone.key.entityId,
        )
        writeTombstone(tombstone)
        pendingPreviousRecord = previousRecord
        return true
    }

    private var pendingPreviousRecord: CoreConfirmedRecord? = null
    private var pendingPreviousRecords: List<CoreConfirmedRecord> = emptyList()
    private var pendingPreviousTombstones: List<CoreConfirmedTombstone> = emptyList()

    override suspend fun projectDeleted(
        tombstone: CoreConfirmedTombstone,
        previousRecord: CoreConfirmedRecord?,
    ) {
        projection?.delete(database, tombstone, previousRecord ?: pendingPreviousRecord)
        reconcileReplicaWait(tombstone)
        pendingPreviousRecord = null
    }

    override suspend fun recordAppliedInboxEvent(event: CoreReplicaInboxEvent) {
        require(event.globalEventId >= 0) { "globalEventId must not be negative" }
        require(event.scopeId.isNotBlank() && event.entityType.isNotBlank() && event.entityId.isNotBlank()) {
            "inbox event identity must not be blank"
        }
        require(event.operation == MERGE || event.operation == DELETE) {
            "unsupported inbox operation ${event.operation}"
        }
        queries.insertCoreReplicaInboxEvent(
            globalEventId = event.globalEventId,
            scopeId = event.scopeId,
            entityType = event.entityType,
            entityId = event.entityId,
            operation = event.operation,
            payloadSha256 = CoreReplicaPayloadHasher.inbox(event),
            appliedAt = now(),
        )
    }

    override suspend fun pruneAppliedInbox() {
        queries.pruneCoreReplicaInboxBelowCheckpoints()
    }

    override suspend fun saveCheckpoint(checkpoint: CoreReplayCheckpoint) {
        val (coverageKey, coverageType, scopeId) = when (val coverage = checkpoint.coverage) {
            CoreReplayCoverage.AllGrantedScopes -> Triple(ALL_COVERAGE_KEY, ALL, null)
            is CoreReplayCoverage.Filtered -> Triple(
                "$FILTERED_PREFIX${coverage.scopeId}",
                FILTERED,
                coverage.scopeId,
            )
        }
        val current = queries.selectCoreReplicaCheckpoint(coverageKey).executeAsOneOrNull()
        if (current != null && current.last_global_event_id > checkpoint.lastGlobalEventId) {
            // A concurrent changes/snapshot request may finish out of order. Cursors are
            // monotonic, so retaining the newer one is safe and prevents a redundant replay.
            return
        }
        queries.upsertCoreReplicaCheckpoint(
            coverageKey = coverageKey,
            coverageType = coverageType,
            scopeId = scopeId,
            lastGlobalEventId = checkpoint.lastGlobalEventId,
            updatedAt = now(),
        )
    }

    private fun writeRecord(record: CoreConfirmedRecord) {
        requireKey(record.key)
        val canonicalRecord = CoreReplicaPayloadHasher.canonicalJson(record.record)
        queries.upsertCoreReplicaRecord(
            scopeId = record.key.scopeId,
            entityType = record.key.entityType,
            entityId = record.key.entityId,
            serverVersion = record.serverVersion,
            lamport = record.lamport,
            recordJson = canonicalRecord,
            payloadSha256 = CoreReplicaPayloadHasher.sha256(canonicalRecord),
        )
        queries.advanceCoreLamport(record.lamport)
    }

    private fun writeTombstone(tombstone: CoreConfirmedTombstone) {
        requireKey(tombstone.key)
        queries.upsertCoreReplicaTombstone(
            scopeId = tombstone.key.scopeId,
            entityType = tombstone.key.entityType,
            entityId = tombstone.key.entityId,
            serverVersion = tombstone.serverVersion,
            lamport = tombstone.lamport,
            deletedAt = tombstone.deletedAtMs,
            reasonCode = tombstone.reasonCode,
            payloadSha256 = CoreReplicaPayloadHasher.tombstone(tombstone),
        )
        queries.advanceCoreLamport(tombstone.lamport)
    }

    private fun currentVersion(key: CoreReplicaKey): Long {
        val recordVersion = queries.selectCoreReplicaRecordVersion(
            key.scopeId,
            key.entityType,
            key.entityId,
        ).executeAsOneOrNull() ?: NO_VERSION
        val tombstoneVersion = queries.selectCoreReplicaTombstoneVersion(
            key.scopeId,
            key.entityType,
            key.entityId,
        ).executeAsOneOrNull() ?: NO_VERSION
        return maxOf(recordVersion, tombstoneVersion)
    }

    private fun reconcileReplicaWait(record: CoreConfirmedRecord) {
        reconcileReplicaWait(record.key, record.serverVersion)
    }

    fun settleReplicaWait(record: CoreConfirmedRecord) {
        requireKey(record.key)
        reconcileReplicaWait(record)
    }

    private fun reconcileReplicaWait(tombstone: CoreConfirmedTombstone) {
        reconcileReplicaWait(tombstone.key, tombstone.serverVersion)
    }

    private fun reconcileReplicaWait(key: CoreReplicaKey, observedServerVersion: Long) {
        queries.reconcileReplicaWaitForEntity(
            scopeId = key.scopeId,
            entityType = key.entityType,
            entityId = key.entityId,
            observedServerVersion = observedServerVersion,
        )
    }

    private fun now(): Long = clock().also {
        require(it >= 0) { "clock must not return a negative epoch" }
    }

    private fun requireScope(key: CoreReplicaKey, expectedScopeId: String) {
        requireKey(key)
        require(key.scopeId == expectedScopeId) { "snapshot record is outside its authoritative scope" }
    }

    private fun requireKey(key: CoreReplicaKey) {
        require(key.scopeId.isNotBlank() && key.entityType.isNotBlank() && key.entityId.isNotBlank()) {
            "replica key fields must not be blank"
        }
    }

    private companion object {
        const val NO_VERSION = -1L
        const val MERGE = "merge"
        const val DELETE = "delete"
        const val ALL = "ALL"
        const val FILTERED = "FILTERED"
        const val ALL_COVERAGE_KEY = "ALL"
        const val FILTERED_PREFIX = "FILTERED:"
    }
}

internal object CoreReplicaPayloadHasher {
    fun canonicalJson(element: JsonElement): String = when (element) {
        JsonNull -> "null"
        is JsonObject -> element.entries
            .sortedBy { it.key }
            .joinToString(prefix = "{", postfix = "}") { (key, value) ->
                "${JsonPrimitive(key)}:${canonicalJson(value)}"
            }
        is JsonArray -> element.joinToString(prefix = "[", postfix = "]") { canonicalJson(it) }
        is JsonPrimitive -> element.toString()
    }

    fun parse(payload: String): JsonElement = Json.parseToJsonElement(payload)

    fun sha256(payload: String): String {
        val bytes = MessageDigest.getInstance(SHA_256).digest(payload.toByteArray(Charsets.UTF_8))
        // A per-byte String.format was most of this hash's cost, paid several times per record.
        val out = CharArray(bytes.size * 2)
        bytes.forEachIndexed { index, byte ->
            val value = byte.toInt() and 0xff
            out[index * 2] = HEX_DIGITS[value ushr 4]
            out[index * 2 + 1] = HEX_DIGITS[value and 0x0f]
        }
        return String(out)
    }

    private val HEX_DIGITS = "0123456789abcdef".toCharArray()

    fun inbox(event: CoreReplicaInboxEvent): String = hashFields(
        event.globalEventId.toString(),
        event.scopeId,
        event.entityType,
        event.entityId,
        event.operation,
    )

    fun tombstone(tombstone: CoreConfirmedTombstone): String = hashFields(
        tombstone.key.scopeId,
        tombstone.key.entityType,
        tombstone.key.entityId,
        tombstone.serverVersion.toString(),
        tombstone.lamport.toString(),
        tombstone.deletedAtMs.toString(),
        tombstone.reasonCode,
    )

    private fun hashFields(vararg values: String?): String = buildString {
        values.forEach { value ->
            if (value == null) {
                append("-1:")
            } else {
                append(value.toByteArray(Charsets.UTF_8).size).append(':').append(value)
            }
            append(';')
        }
    }.let(::sha256)

    private const val SHA_256 = "SHA-256"
}
