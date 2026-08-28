package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphMutationCoordinatorTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val coordinator = EpigraphMutationCoordinator(
        AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
    )

    @AfterEach
    fun closeDriver() {
        driver.close()
    }

    @Test
    fun `domain mutation and outbox insertion commit together`() = runTest {
        val envelope = envelope(DeviceId("phone-a"), ClientMutationId("same-id"))

        coordinator.mutateLocal(envelope, createdAtEpochMillis = 100) {
            aethon_syncQueries.upsertIdentity(
                entityId = envelope.command.entityId.value,
                contentType = "MANGA",
                localReference = "42",
                createdAt = 100,
                updatedAt = 100,
            )
        }

        assertEquals(1, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(
            envelope.command.entityId.value,
            database.aethon_syncQueries.selectIdentityByLocalReference("MANGA", "42").executeAsOne().entity_id,
        )
    }

    @Test
    fun `duplicate outbox key rolls domain mutation back`() = runTest {
        val envelope = envelope(DeviceId("phone-a"), ClientMutationId("duplicate"))
        coordinator.mutateLocal(envelope, 100) { Unit }

        val failure = runCatching {
            coordinator.mutateLocal(envelope, 101) {
                aethon_syncQueries.upsertIdentity(
                    entityId = "manga:rolled-back",
                    contentType = "MANGA",
                    localReference = "rolled-back",
                    createdAt = 101,
                    updatedAt = 101,
                )
            }
        }.exceptionOrNull()

        assertNotNull(failure)
        assertEquals(
            null,
            database.aethon_syncQueries
                .selectIdentityByEntityId("manga:rolled-back")
                .executeAsOneOrNull(),
        )
    }

    @Test
    fun `same mutation id from two devices coexists and sequence is stable`() = runTest {
        coordinator.mutateLocal(envelope(DeviceId("phone-a"), ClientMutationId("shared")), 100) { Unit }
        coordinator.mutateLocal(envelope(DeviceId("phone-b"), ClientMutationId("shared")), 100) { Unit }

        val claimed = coordinator.claimReady(nowEpochMillis = 100, leaseDurationMillis = 1_000, limit = 10)

        assertEquals(listOf("phone-a", "phone-b"), claimed.map { it.device_id })
        assertTrue(claimed.zipWithNext().all { (first, second) -> first.sequence < second.sequence })
    }

    @Test
    fun `batch computes multiple commands inside the transaction and preserves their order`() = runTest {
        val first = envelope(DeviceId("phone-a"), ClientMutationId("batch-1"))
        val second = envelope(DeviceId("phone-a"), ClientMutationId("batch-2"))

        val value = coordinator.mutateLocalBatch(createdAtEpochMillis = 100) {
            LocalMutationResult("committed", listOf(first, second))
        }

        assertEquals("committed", value)
        val claimed = coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)
        assertEquals(listOf("batch-1", "batch-2"), claimed.map { it.client_mutation_id })
    }

    @Test
    fun `notifies the background scheduler only after a durable outbox insert`() = runTest {
        var notifications = 0
        val notifyingCoordinator = EpigraphMutationCoordinator(
            AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            onLocalMutationEnqueued = { notifications++ },
        )

        notifyingCoordinator.mutateLocalBatch(100) {
            LocalMutationResult("no-op", emptyList())
        }
        assertEquals(0, notifications)

        notifyingCoordinator.mutateLocal(envelope(DeviceId("phone-a"), ClientMutationId("wake")), 101) { Unit }
        assertEquals(1, notifications)
    }

    @Test
    fun `expired in flight mutation is claimable after process death`() = runTest {
        coordinator.mutateLocal(envelope(DeviceId("phone-a"), ClientMutationId("leased")), 100) { Unit }
        assertEquals(1, coordinator.claimReady(100, leaseDurationMillis = 50, limit = 10).size)
        assertEquals(0, coordinator.claimReady(120, leaseDurationMillis = 50, limit = 10).size)
        assertEquals(1, coordinator.claimReady(151, leaseDurationMillis = 50, limit = 10).size)
    }

    @Test
    fun `remote replay is idempotent and never creates outbox work`() = runTest {
        var applications = 0
        val apply: suspend Database.() -> Unit = { applications++ }
        val hash = "a".repeat(64)

        assertTrue(coordinator.applyRemoteEvent(SyncScopeId("books:global"), "event-1", 1, hash, "1", 2, 100, apply))
        assertFalse(coordinator.applyRemoteEvent(SyncScopeId("books:global"), "event-1", 1, hash, "1", 2, 101, apply))
        assertEquals(1, applications)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `ack writes receipt and removes outbox atomically`() = runTest {
        val deviceId = DeviceId("phone-a")
        val mutationId = ClientMutationId("ack-me")
        coordinator.mutateLocal(envelope(deviceId, mutationId), 100) { Unit }

        coordinator.acknowledge(
            EpigraphMutationAcknowledgement(
                deviceId = deviceId,
                clientMutationId = mutationId,
                scopeId = SyncScopeId("comics:profile:main"),
                entityType = "comic.entry",
                entityId = EpigraphEntityId("manga:example:42"),
                canonicalEntityId = EpigraphEntityId("manga:canonical"),
                resultStatus = "APPLIED",
                requiredServerVersion = 7,
                appliedLamport = 3,
                eventClockJson = null,
                canonicalRecordSha256 = null,
                receivedAtEpochMillis = 200,
            ),
        )

        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(1, database.aethon_syncQueries.replicaWaitCount().executeAsOne())
        assertEquals(1, coordinator.unsettledCount())
        assertEquals(
            "manga:canonical",
            database.aethon_syncQueries.selectReceipt(deviceId.value, mutationId.value).executeAsOne().canonical_entity_id,
        )
        assertEquals(
            7,
            database.aethon_syncQueries.selectReplicaWait(deviceId.value, mutationId.value)
                .executeAsOne().required_server_version,
        )
    }

    @Test
    fun `capability failure keeps mutation pending and records a non-secret code`() = runTest {
        val deviceId = DeviceId("phone-a")
        val mutationId = ClientMutationId("blocked")
        coordinator.mutateLocal(envelope(deviceId, mutationId), 100) { Unit }
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)

        coordinator.markFailed(
            deviceId = deviceId,
            clientMutationId = mutationId,
            errorCode = "CORE_CAPABILITY_MISSING:comic.entry",
            nextAttemptAtEpochMillis = 5_000,
        )

        assertEquals(1, coordinator.pendingCount())
        assertEquals(0, coordinator.claimReady(4_999, leaseDurationMillis = 1_000, limit = 10).size)
        val retried = coordinator.claimReady(5_000, leaseDurationMillis = 1_000, limit = 10).single()
        assertEquals("CORE_CAPABILITY_MISSING:comic.entry", retried.last_error)
    }

    @Test
    fun `permanently blocked mutation still prevents a synchronized state`() = runTest {
        val deviceId = DeviceId("phone-a")
        val mutationId = ClientMutationId("blocked-until-user-action")
        coordinator.mutateLocal(envelope(deviceId, mutationId), 100) { Unit }
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)

        coordinator.markFailed(
            deviceId = deviceId,
            clientMutationId = mutationId,
            errorCode = "blocked:unsupported_entity",
            nextAttemptAtEpochMillis = Long.MAX_VALUE,
        )

        assertEquals(1, coordinator.pendingCount())
        assertEquals(0, coordinator.claimReady(Long.MAX_VALUE - 1, 1, 10).size)
    }

    @Test
    fun `local progress remains writable after a newer remote revision`() = runTest {
        database.aethon_syncQueries.upsertIdentity(
            entityId = "manga:progress",
            contentType = "MANGA",
            localReference = "progress",
            createdAt = 100,
            updatedAt = 100,
        )
        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = "manga:progress",
            chapterEntityId = null,
            locatorJson = "remote",
            chapterOrdinal = 2.0,
            progression = 0.5,
            serverRevision = 12,
            updatedAt = 110,
        )

        database.aethon_syncQueries.upsertLocalReaderProgress(
            entityId = "manga:progress",
            chapterEntityId = null,
            locatorJson = "local",
            chapterOrdinal = 3.0,
            progression = 0.75,
            updatedAt = 120,
        )

        val progress = database.aethon_syncQueries
            .selectReaderProgress("manga:progress")
            .executeAsOne()
        assertEquals("local", progress.locator_json)
        assertEquals(0.75, progress.progression)
        assertEquals(12, progress.server_revision)

        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = "manga:progress",
            chapterEntityId = null,
            locatorJson = "stale",
            chapterOrdinal = 1.0,
            progression = 0.25,
            serverRevision = 11,
            updatedAt = 130,
        )
        assertEquals(
            "local",
            database.aethon_syncQueries.selectReaderProgress("manga:progress").executeAsOne().locator_json,
        )
    }

    private fun envelope(deviceId: DeviceId, mutationId: ClientMutationId) = SyncCommandEnvelope(
        protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
        deviceId = deviceId,
        clientMutationId = mutationId,
        scopeId = SyncScopeId("comics:profile:main"),
        entityType = SyncEntityType("comic.entry"),
        command = SyncCommand.SetLibraryMembership(EpigraphEntityId("manga:example:42"), true),
    )
}
