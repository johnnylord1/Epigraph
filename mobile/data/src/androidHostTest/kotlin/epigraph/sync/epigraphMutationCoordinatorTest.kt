package epigraph.sync

import epigraph.contract.ChapterStatePatch
import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.ReaderLocator
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
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
    fun `ack arriving after the replica already applied its version settles immediately`() = runTest {
        val deviceId = DeviceId("phone-a")
        val scope = SyncScopeId("books:global")
        // The live event for v7 was projected before the POST response was stored.
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = scope.value,
            entityType = "book.progress",
            entityId = "book:raced",
            serverVersion = 7,
            lamport = 3,
            recordJson = "{}",
            payloadSha256 = "a".repeat(64),
        )
        suspend fun ack(mutationId: String, entityId: String, requiredServerVersion: Long) {
            coordinator.mutateLocal(envelope(deviceId, ClientMutationId(mutationId)), 100) { Unit }
            coordinator.acknowledge(
                EpigraphMutationAcknowledgement(
                    deviceId = deviceId,
                    clientMutationId = ClientMutationId(mutationId),
                    scopeId = scope,
                    entityType = "book.progress",
                    entityId = EpigraphEntityId(entityId),
                    canonicalEntityId = null,
                    resultStatus = "APPLIED",
                    requiredServerVersion = requiredServerVersion,
                    appliedLamport = 3,
                    eventClockJson = null,
                    canonicalRecordSha256 = null,
                    receivedAtEpochMillis = 200,
                ),
            )
        }

        ack("raced", "book:raced", requiredServerVersion = 7)
        assertEquals(0, database.aethon_syncQueries.replicaWaitCount().executeAsOne())

        // A version the replica has not reached yet (or another entity) still waits.
        ack("ahead", "book:raced", requiredServerVersion = 8)
        ack("other", "book:other", requiredServerVersion = 7)
        assertEquals(2, database.aethon_syncQueries.replicaWaitCount().executeAsOne())
        assertEquals(2, coordinator.unsettledCount())
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
    fun `manual sync releases transient backoff but keeps blocked rows parked`() = runTest {
        val deviceId = DeviceId("phone-a")
        val transient = ClientMutationId("transient")
        val blocked = ClientMutationId("blocked")
        coordinator.mutateLocal(envelope(deviceId, transient), 100) { Unit }
        coordinator.mutateLocal(envelope(deviceId, blocked), 100) { Unit }
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)
        coordinator.markFailed(deviceId, transient, "outbox_retry", nextAttemptAtEpochMillis = 60_000)
        coordinator.markFailed(deviceId, blocked, "blocked:unsupported_entity", Long.MAX_VALUE)

        assertEquals(1, coordinator.blockedCount())
        assertEquals(1, coordinator.blockedCount(setOf("comics:profile:main")))
        assertEquals(0, coordinator.blockedCount(setOf("books:profile:other")))
        assertEquals(0, coordinator.blockedCount(emptySet()))
        assertEquals(0, coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).size)

        coordinator.releaseRetryBackoff(200)

        val ready = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10)
        assertEquals(listOf(transient.value), ready.map { it.client_mutation_id })
        assertEquals(1, coordinator.blockedCount())
        assertEquals(2, coordinator.pendingCount())
    }

    @Test
    fun `retry sends a parked row under the new ID in both the row and its envelope`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("refused")), 100) { Unit }
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)
        coordinator.markFailed(deviceId, ClientMutationId("refused"), "blocked:unsupported_entity", Long.MAX_VALUE)

        coordinator.retryBlocked(coordinator.blockedMutations().single().sequence, ClientMutationId("again"), 200)

        val row = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).single()
        assertEquals("again", row.client_mutation_id)
        assertTrue(row.payload_json.contains("\"clientMutationId\":\"again\""), row.payload_json)
        assertEquals(0, coordinator.blockedCount())
    }

    @Test
    fun `parked page counts one short of a read chapter are repaired and sent again once`() = runTest {
        val deviceId = DeviceId("phone-a")
        suspend fun park(id: String, pageIndex: Int, pageCount: Int, error: String) {
            coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId(id), pageIndex, pageCount), 100) { Unit }
            coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)
            coordinator.markFailed(deviceId, ClientMutationId(id), error, Long.MAX_VALUE)
        }
        park("read-chapter", pageIndex = 11, pageCount = 11, error = "blocked:INVALID_PAGE_COUNT")
        park("other-count", pageIndex = 3, pageCount = 10, error = "blocked:INVALID_PAGE_COUNT")
        park("other-reason", pageIndex = 11, pageCount = 11, error = "blocked:unsupported_entity")
        var ids = 0

        assertEquals(1, coordinator.retryRepairablePageCounts(200) { ClientMutationId("repaired-${ids++}") })

        val row = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).single()
        assertEquals("repaired-0", row.client_mutation_id)
        assertTrue(row.payload_json.contains("\"pageCount\":12"), row.payload_json)
        assertTrue(row.payload_json.contains("\"clientMutationId\":\"repaired-0\""), row.payload_json)
        assertEquals(2, coordinator.blockedCount())

        // Refused again after the repair, the row stays parked for the user instead of looping.
        coordinator.markFailed(deviceId, ClientMutationId("repaired-0"), "blocked:INVALID_PAGE_COUNT", Long.MAX_VALUE)
        assertEquals(0, coordinator.retryRepairablePageCounts(300) { ClientMutationId("repaired-${ids++}") })
        assertEquals(3, coordinator.blockedCount())
    }

    @Test
    fun `parked progress naming a Core-served manga by its portable id moves to the scoped id once`() = runTest {
        val deviceId = DeviceId("phone-a")
        val server = "01a10680-deda-7932-97d6-ac4f17079418"
        val portableId = "comic:184ffbd5daa2ecad3cd0319d57564e2d6adeea14c0161dbc50f4492c1b07bf42"
        val scopedId = "suwayomi:server:$server:profile:main:manga:21"
        val chapterId = "suwayomi:server:$server:profile:main:chapter:2045"
        database.aethon_syncQueries.upsertIdentity(portableId, "MANGA", insertManga("aethon-core://suwayomi/$server/main/manga/21").toString(), 1, 1)
        database.aethon_syncQueries.upsertIdentity("comic:unknown", "MANGA", insertManga("/comic/1").toString(), 1, 1)
        suspend fun park(id: String, entityType: String, command: SyncCommand, error: String) {
            coordinator.mutateLocal(
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = ClientMutationId(id),
                    scopeId = SyncScopeId("comics:profile:main"),
                    entityType = SyncEntityType(entityType),
                    command = command,
                ),
                100,
            ) { Unit }
            coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)
            coordinator.markFailed(deviceId, ClientMutationId(id), error, Long.MAX_VALUE)
        }
        fun history(comicId: String, chapter: String = chapterId) = SyncCommand.SetProgress(
            entityId = EpigraphEntityId(comicId),
            locator = ReaderLocator.Manga(EpigraphEntityId(comicId), chapter, pageIndex = 3, pageCount = 15, progression = 0.25),
        )
        fun chapterState(comicId: String) = SyncCommand.SetChapterState(
            entityId = EpigraphEntityId("comic.chapter_state::$comicId::$chapterId"),
            state = ChapterStatePatch(chapterId = chapterId, lastPageRead = 3, lastReadAtEpochMillis = 100),
        )
        park("history", "comic.history", history(portableId), "blocked:INVALID_COMIC_ID")
        park("state", "comic.chapter_state", chapterState(portableId), "blocked:INVALID_SUWAYOMI_ENTITY_ID")
        park("not-core-served", "comic.history", history("comic:unknown"), "blocked:INVALID_COMIC_ID")
        park("other-scope", "comic.history", history(portableId, "suwayomi:server:other:profile:main:chapter:2045"), "blocked:INVALID_COMIC_ID")
        park("other-reason", "comic.history", history(portableId), "blocked:INVALID_PAGE_COUNT")
        var ids = 0

        assertEquals(2, coordinator.retryCoreServedComicIds(200) { ClientMutationId("rekeyed-${ids++}") })

        val rows = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).associateBy { it.entity_type }
        assertEquals(setOf("comic.history", "comic.chapter_state"), rows.keys)
        assertEquals(scopedId, rows.getValue("comic.history").entity_id)
        assertEquals("comic.chapter_state::$scopedId::$chapterId", rows.getValue("comic.chapter_state").entity_id)
        rows.values.forEach { row ->
            assertFalse(row.payload_json.contains(portableId), row.payload_json)
            assertTrue(row.payload_json.contains("\"clientMutationId\":\"${row.client_mutation_id}\""), row.payload_json)
            assertEquals(100, row.created_at)
        }
        assertEquals(3, coordinator.blockedCount())

        // Refused again under the scoped id, the row stays parked for the user instead of looping.
        coordinator.markFailed(deviceId, ClientMutationId(rows.getValue("comic.history").client_mutation_id), "blocked:INVALID_COMIC_ID", Long.MAX_VALUE)
        assertEquals(0, coordinator.retryCoreServedComicIds(300) { ClientMutationId("rekeyed-${ids++}") })
        assertEquals(4, coordinator.blockedCount())
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

    private fun progressEnvelope(deviceId: DeviceId, mutationId: ClientMutationId, pageIndex: Int, pageCount: Int) =
        SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = deviceId,
            clientMutationId = mutationId,
            scopeId = SyncScopeId("comics:profile:main"),
            entityType = SyncEntityType("comic.history"),
            command = SyncCommand.SetProgress(
                entityId = EpigraphEntityId("manga:example:42"),
                locator = ReaderLocator.Manga(
                    entityId = EpigraphEntityId("manga:example:42"),
                    chapterId = "chapter-1",
                    pageIndex = pageIndex,
                    pageCount = pageCount,
                    progression = 1.0,
                ),
            ),
        )

    private fun insertManga(url: String): Long {
        database.mangasQueries.insert(
            source = 1,
            url = url,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Example",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = null,
            initialized = false,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        return database.mangasQueries.selectLastInsertedRowId().executeAsOne()
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
