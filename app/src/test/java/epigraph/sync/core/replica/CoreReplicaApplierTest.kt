package epigraph.sync.core.replica

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreChangeEnvelope
import epigraph.sync.core.protocol.CoreChangesResponse
import epigraph.sync.core.protocol.CoreSnapshot
import epigraph.sync.core.protocol.CoreSnapshotEntity
import epigraph.sync.core.protocol.CoreSnapshotTombstone
import epigraph.sync.core.replay.CoreReplayCheckpoint
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreSseEvent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreReplicaApplierTest {
    @Test
    fun `authoritative snapshot replaces only confirmed scope and preserves outbox`() = runTest {
        val store = FakeReplicaStore().apply {
            confirmed[key("books:global", "old")] = record("books:global", "old", 1)
            confirmed[key("novels:profile:main", "keep")] =
                record("novels:profile:main", "keep", 1, type = "novel.entry")
            outbox += "pending-local-mutation"
        }
        val applier = CoreReplicaApplier(store)

        val result = applier.applySnapshot(snapshot(), capabilities())

        assertEquals(setOf(key("books:global", "new"), key("novels:profile:main", "keep")), store.confirmed.keys)
        assertEquals(setOf(key("books:global", "deleted")), store.tombstones.keys)
        assertEquals(listOf("pending-local-mutation"), store.outbox)
        assertEquals(listOf("replace:books:global", "checkpoint:8", "commit"), store.operations)
        assertEquals(8, result.checkpoint.lastGlobalEventId)
    }

    @Test
    fun `snapshot failure rolls back replica tombstones and checkpoint`() {
        val old = record("books:global", "old", 1)
        val store = FakeReplicaStore().apply {
            confirmed[old.key] = old
            failOnCheckpoint = true
        }

        assertThrows(IllegalStateException::class.java) {
            runTest { CoreReplicaApplier(store).applySnapshot(snapshot(), capabilities()) }
        }

        assertEquals(mapOf(old.key to old), store.confirmed)
        assertEquals(emptyMap<CoreReplicaKey, CoreConfirmedTombstone>(), store.tombstones)
        assertEquals(emptyMap<String, CoreReplayCheckpoint>(), store.checkpoints)
    }

    @Test
    fun `unsupported snapshot entity is rejected before opening transaction`() {
        val store = FakeReplicaStore()
        val unsupported = snapshot().copy(
            entities = listOf(
                CoreSnapshotEntity("comic.entry", "comic-1", 8, 1, JsonPrimitive("record")),
            ),
            tombstones = emptyList(),
            tombstoneCount = 0,
        )

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest { CoreReplicaApplier(store).applySnapshot(unsupported, capabilities()) }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `incompatible Core capabilities are rejected before transaction`() {
        val store = FakeReplicaStore()
        val incompatible = capabilities().copy(supportsSseReplay = false)

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest { CoreReplicaApplier(store).applySnapshot(snapshot(), incompatible) }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `snapshot replay window must be bounded by snapshot version`() {
        val store = FakeReplicaStore()
        val invalid = snapshot().copy(minReplayableServerVersion = 9)

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest { CoreReplicaApplier(store).applySnapshot(invalid, capabilities()) }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `v3 snapshot must declare complete payload before transaction`() {
        val store = FakeReplicaStore()

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest {
                CoreReplicaApplier(store).applySnapshot(
                    snapshot().copy(complete = false),
                    capabilities(),
                )
            }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `v3 snapshot counts must match payload before transaction`() {
        val store = FakeReplicaStore()

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest {
                CoreReplicaApplier(store).applySnapshot(
                    snapshot().copy(entityCount = 2),
                    capabilities(),
                )
            }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `v2 snapshot remains compatible without completeness metadata`() = runTest {
        val store = FakeReplicaStore()
        val legacySnapshot = snapshot().copy(
            schemaVersion = EpigraphCoreWireProtocol.MIN_SNAPSHOT_SCHEMA_VERSION,
            snapshotId = null,
            complete = null,
            entityCount = null,
            tombstoneCount = null,
        )

        CoreReplicaApplier(store).applySnapshot(
            legacySnapshot,
            capabilities().copy(snapshotSchemaVersion = EpigraphCoreWireProtocol.MIN_SNAPSHOT_SCHEMA_VERSION),
        )

        assertEquals(setOf(key("books:global", "new")), store.confirmed.keys)
        assertEquals(1, store.transactionCount)
    }

    @Test
    fun `merge change upserts one entity without deleting absent records`() = runTest {
        val store = FakeReplicaStore().apply {
            confirmed[key("books:global", "untouched")] = record("books:global", "untouched", 2)
        }
        val result = CoreReplicaApplier(store).applyChange(
            change(version = 9, operation = "merge"),
            CoreReplayCoverage.Filtered("books:global"),
            capabilities(),
        )

        assertInstanceOf(CoreReplicaApplyResult.ChangeApplied::class.java, result)
        assertEquals(setOf(key("books:global", "untouched"), key("books:global", "changed")), store.confirmed.keys)
        assertEquals(emptySet<CoreReplicaKey>(), store.tombstones.keys)
        assertEquals(setOf(9L), store.inbox)
        assertEquals(listOf("upsert:changed", "inbox:9", "checkpoint:9", "commit"), store.operations)
    }

    @Test
    fun `only explicit delete creates a tombstone`() = runTest {
        val store = FakeReplicaStore().apply {
            confirmed[key("books:global", "changed")] = record("books:global", "changed", 2)
        }

        CoreReplicaApplier(store).applyChange(
            change(version = 10, operation = "delete"),
            CoreReplayCoverage.Filtered("books:global"),
            capabilities(),
        )

        assertEquals(emptySet<CoreReplicaKey>(), store.confirmed.keys)
        assertEquals(1234, store.tombstones.getValue(key("books:global", "changed")).deletedAtMs)
    }

    @Test
    fun `inbox makes replayed event idempotent`() = runTest {
        val store = FakeReplicaStore()
        val applier = CoreReplicaApplier(store)
        val event = change(version = 11, operation = "merge")

        applier.applyChange(event, CoreReplayCoverage.AllGrantedScopes, capabilities())
        val operationCount = store.operations.size
        val duplicate = applier.applyChange(event, CoreReplayCoverage.AllGrantedScopes, capabilities())

        assertInstanceOf(CoreReplicaApplyResult.ChangeAlreadyApplied::class.java, duplicate)
        assertEquals(operationCount + 2, store.operations.size)
        assertEquals("checkpoint:11", store.operations[store.operations.lastIndex - 1])
        assertEquals("commit", store.operations.last())
        assertEquals(1, store.confirmed.size)
    }

    @Test
    fun `change failure rolls back entity inbox and checkpoint together`() {
        val store = FakeReplicaStore().apply { failOnCheckpoint = true }

        assertThrows(IllegalStateException::class.java) {
            runTest {
                CoreReplicaApplier(store).applyChange(
                    change(version = 12, operation = "merge"),
                    CoreReplayCoverage.Filtered("books:global"),
                    capabilities(),
                )
            }
        }

        assertEquals(emptyMap<CoreReplicaKey, CoreConfirmedRecord>(), store.confirmed)
        assertEquals(emptySet<Long>(), store.inbox)
        assertEquals(emptyMap<String, CoreReplayCheckpoint>(), store.checkpoints)
    }

    @Test
    fun `filtered change from another scope is rejected without transaction`() {
        val store = FakeReplicaStore()

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest {
                CoreReplicaApplier(store).applyChange(
                    change(version = 13, operation = "merge", scope = "novels:profile:main"),
                    CoreReplayCoverage.Filtered("books:global"),
                    capabilities(),
                )
            }
        }

        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `unknown operation and patch-bearing delete are rejected`() {
        val store = FakeReplicaStore()
        val applier = CoreReplicaApplier(store)

        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest {
                applier.applyChange(
                    change(14, "future"),
                    CoreReplayCoverage.AllGrantedScopes,
                    capabilities(),
                )
            }
        }
        assertThrows(CoreReplicaProtocolException::class.java) {
            runTest {
                applier.applyChange(
                    change(15, "delete", forcePatch = true),
                    CoreReplayCoverage.AllGrantedScopes,
                    capabilities(),
                )
            }
        }
        assertEquals(0, store.transactionCount)
    }

    @Test
    fun `empty changes response advances global checkpoint without deleting replica`() = runTest {
        val existing = record("books:global", "existing", 2)
        val store = FakeReplicaStore().apply { confirmed[existing.key] = existing }

        val result = CoreReplicaApplier(store).applyChanges(
            CoreChangesResponse(
                currentServerVersion = 20,
                minReplayableServerVersion = 3,
                changes = emptyList(),
            ),
            CoreReplayCoverage.Filtered("books:global"),
            capabilities(),
        )

        assertEquals(mapOf(existing.key to existing), store.confirmed)
        assertEquals(0, result.appliedCount)
        assertEquals(20, result.checkpoint.lastGlobalEventId)
        assertEquals(listOf("checkpoint:20", "commit"), store.operations)
    }

    @Test
    fun `changes response is one transaction and rolls back entire page on failure`() {
        val store = FakeReplicaStore().apply { failOnCheckpoint = true }
        val response = CoreChangesResponse(
            currentServerVersion = 10,
            minReplayableServerVersion = 1,
            changes = listOf(
                change(8, "merge").envelope,
                change(9, "delete").envelope,
            ),
        )

        assertThrows(IllegalStateException::class.java) {
            runTest {
                CoreReplicaApplier(store).applyChanges(
                    response,
                    CoreReplayCoverage.Filtered("books:global"),
                    capabilities(),
                )
            }
        }

        assertEquals(emptyMap<CoreReplicaKey, CoreConfirmedRecord>(), store.confirmed)
        assertEquals(emptyMap<CoreReplicaKey, CoreConfirmedTombstone>(), store.tombstones)
        assertEquals(emptySet<Long>(), store.inbox)
    }

    private fun snapshot() = CoreSnapshot(
        schemaVersion = EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
        snapshotId = "snapshot-books-8",
        complete = true,
        entityCount = 1,
        tombstoneCount = 1,
        scopeId = "books:global",
        snapshotVersion = 8,
        minReplayableServerVersion = 3,
        entities = listOf(
            CoreSnapshotEntity("book.entry", "new", 8, 2, JsonPrimitive("record")),
        ),
        tombstones = listOf(
            CoreSnapshotTombstone("book.entry", "deleted", 7, 3, 1000, "removed"),
        ),
    )

    private fun change(
        version: Long,
        operation: String,
        scope: String = "books:global",
        forcePatch: Boolean = false,
    ) = CoreSseEvent.Change(
        globalEventId = version,
        envelope = CoreChangeEnvelope(
            serverVersion = version,
            scopeId = scope,
            entityType = "book.entry",
            entityId = "changed",
            op = operation,
            lamport = version,
            patch = if (operation == "delete" && !forcePatch) null else buildJsonObject { put("title", "Book") },
            appliedAtMs = 1234,
        ),
    )

    private fun capabilities() = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("books:global"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = true,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
        snapshotEntityTypes = setOf("book.entry", "novel.entry"),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-sync._tcp.local",
        currentServerVersion = 20,
        minReplayableServerVersion = 1,
    )

    private fun key(scope: String, id: String, type: String = "book.entry") =
        CoreReplicaKey(scope, type, id)

    private fun record(
        scope: String,
        id: String,
        version: Long,
        type: String = "book.entry",
    ) = CoreConfirmedRecord(key(scope, id, type), version, version, JsonPrimitive(id))
}

private class FakeReplicaStore : CoreReplicaStore {
    var confirmed = linkedMapOf<CoreReplicaKey, CoreConfirmedRecord>()
    var tombstones = linkedMapOf<CoreReplicaKey, CoreConfirmedTombstone>()
    var inbox = linkedSetOf<Long>()
    var checkpoints = linkedMapOf<String, CoreReplayCheckpoint>()
    val outbox = mutableListOf<String>()
    val operations = mutableListOf<String>()
    var failOnCheckpoint = false
    var transactionCount = 0

    override suspend fun <T> transaction(block: suspend CoreReplicaTransaction.() -> T): T {
        transactionCount++
        val stagedConfirmed = LinkedHashMap(confirmed)
        val stagedTombstones = LinkedHashMap(tombstones)
        val stagedInbox = LinkedHashSet(inbox)
        val stagedCheckpoints = LinkedHashMap(checkpoints)
        val stagedOperations = mutableListOf<String>()
        val transaction = object : CoreReplicaTransaction {
            override suspend fun replaceConfirmedScope(
                scopeId: String,
                records: List<CoreConfirmedRecord>,
                tombstones: List<CoreConfirmedTombstone>,
            ) {
                stagedConfirmed.keys.removeAll { it.scopeId == scopeId }
                stagedTombstones.keys.removeAll { it.scopeId == scopeId }
                records.forEach { stagedConfirmed[it.key] = it }
                tombstones.forEach { stagedTombstones[it.key] = it }
                stagedOperations += "replace:$scopeId"
            }

            override suspend fun hasAppliedInboxEvent(globalEventId: Long) = globalEventId in stagedInbox

            override suspend fun upsertConfirmed(record: CoreConfirmedRecord) {
                stagedTombstones.remove(record.key)
                stagedConfirmed[record.key] = record
                stagedOperations += "upsert:${record.key.entityId}"
            }

            override suspend fun deleteConfirmed(tombstone: CoreConfirmedTombstone) {
                stagedConfirmed.remove(tombstone.key)
                stagedTombstones[tombstone.key] = tombstone
                stagedOperations += "delete:${tombstone.key.entityId}"
            }

            override suspend fun recordAppliedInboxEvent(event: CoreReplicaInboxEvent) {
                stagedInbox += event.globalEventId
                stagedOperations += "inbox:${event.globalEventId}"
            }

            override suspend fun saveCheckpoint(checkpoint: CoreReplayCheckpoint) {
                if (failOnCheckpoint) error("checkpoint failure")
                stagedCheckpoints[checkpoint.coverage.toString()] = checkpoint
                stagedOperations += "checkpoint:${checkpoint.lastGlobalEventId}"
            }
        }
        val result = transaction.block()
        confirmed = stagedConfirmed
        tombstones = stagedTombstones
        inbox = stagedInbox
        checkpoints = stagedCheckpoints
        operations += stagedOperations
        operations += "commit"
        return result
    }
}
