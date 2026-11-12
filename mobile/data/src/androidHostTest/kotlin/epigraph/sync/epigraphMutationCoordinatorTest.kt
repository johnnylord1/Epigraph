package epigraph.sync

import epigraph.contract.BookEntrySnapshot
import epigraph.contract.ChapterStatePatch
import epigraph.contract.ContentType
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
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

private val BOOK_SHA = "a".repeat(64)
private val COVER_SHA = "b".repeat(64)

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
    fun `page turns on one work leave a single row with the newest progress and time`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("page-1"), 1, 20), 100) { Unit }
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("page-2"), 2, 20), 110) { Unit }
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("page-3"), 3, 20), 120) { Unit }

        val row = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).single()
        assertEquals("page-3", row.client_mutation_id)
        assertEquals(120, row.created_at)
        assertTrue(row.payload_json.contains("\"pageIndex\":3"), row.payload_json)
    }

    @Test
    fun `an older backfilled page does not replace newer unsent progress`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("live"), 9, 20), 500) { Unit }
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("backfill"), 2, 20), 100) { Unit }

        val row = coordinator.claimReady(600, leaseDurationMillis = 1_000, limit = 10).single()
        assertEquals(500, row.created_at)
        assertTrue(row.payload_json.contains("\"pageIndex\":9"), row.payload_json)
    }

    @Test
    fun `chapter state folds field by field and keeps an explicit reset`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(chapterStateEnvelope(deviceId, "reset", ChapterStatePatch(
            chapterId = "chapter-1", lastPageRead = 0, lastReadAtEpochMillis = 100, explicitProgressReset = true,
        )), 100) { Unit }
        coordinator.mutateLocal(chapterStateEnvelope(deviceId, "bookmark", ChapterStatePatch(
            chapterId = "chapter-1", bookmarked = true,
        )), 110) { Unit }
        coordinator.mutateLocal(chapterStateEnvelope(deviceId, "read", ChapterStatePatch(
            chapterId = "chapter-1", read = true, lastPageRead = 7, lastReadAtEpochMillis = 120,
        )), 120) { Unit }

        val row = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10).single()
        val state = (decode(row.payload_json).command as SyncCommand.SetChapterState).state
        assertEquals(ChapterStatePatch(
            chapterId = "chapter-1",
            read = true,
            bookmarked = true,
            lastPageRead = 7,
            lastReadAtEpochMillis = 120,
            explicitProgressReset = true,
        ), state)
        assertEquals(120, row.created_at)
    }

    @Test
    fun `a row already handed to the drainer is never folded`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("sent"), 1, 20), 100) { Unit }
        assertEquals(1, coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10).size)

        coordinator.mutateLocal(progressEnvelope(deviceId, ClientMutationId("next"), 2, 20), 110) { Unit }

        assertEquals(2, coordinator.pendingCount())
    }

    @Test
    fun `library and history rows are not folded`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("entry-1")), 100) { Unit }
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("entry-2")), 110) { Unit }

        assertEquals(2, coordinator.pendingCount())
    }

    @Test
    fun `a queue written before folding is folded once into its newest row`() = runTest {
        val deviceId = DeviceId("phone-a")
        listOf(1 to 100L, 2 to 110L, 3 to 120L).forEach { (page, at) ->
            val envelope = progressEnvelope(deviceId, ClientMutationId("legacy-$page"), page, 20)
            database.aethon_syncQueries.enqueueMutation(
                clientMutationId = envelope.clientMutationId.value,
                deviceId = deviceId.value,
                scopeId = envelope.scopeId.value,
                entityType = envelope.entityType.value,
                entityId = envelope.command.entityId.value,
                operation = "set_progress",
                payloadJson = json.encodeToString(envelope),
                createdAt = at,
                nextAttemptAt = at,
            )
        }
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("entry")), 130) { Unit }

        assertEquals(2, coordinator.foldUnsentMutations())

        val rows = coordinator.claimReady(200, leaseDurationMillis = 1_000, limit = 10)
        assertEquals(listOf("legacy-3", "entry"), rows.map { it.client_mutation_id })
        assertTrue(rows.first().payload_json.contains("\"pageIndex\":3"), rows.first().payload_json)
        assertEquals(0, coordinator.foldUnsentMutations())
    }

    @Test
    fun `one response settles all of its rows together`() = runTest {
        val deviceId = DeviceId("phone-a")
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("a")), 100) { Unit }
        coordinator.mutateLocal(envelope(deviceId, ClientMutationId("b")), 100) { Unit }
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10)

        coordinator.acknowledgeAll(listOf("a", "b").map { id ->
            EpigraphMutationAcknowledgement(
                deviceId = deviceId,
                clientMutationId = ClientMutationId(id),
                scopeId = SyncScopeId("comics:profile:main"),
                entityType = "comic.entry",
                entityId = EpigraphEntityId("manga:example:42"),
                canonicalEntityId = null,
                resultStatus = "APPLIED",
                requiredServerVersion = 5,
                appliedLamport = null,
                eventClockJson = null,
                canonicalRecordSha256 = null,
                receivedAtEpochMillis = 120,
            )
        })

        assertEquals(0, coordinator.pendingCount())
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

    private val json = Json {
        classDiscriminator = "operation"
        encodeDefaults = true
    }

    private fun decode(payloadJson: String): SyncCommandEnvelope = json.decodeFromString(payloadJson)

    private fun chapterStateEnvelope(deviceId: DeviceId, mutationId: String, state: ChapterStatePatch) =
        SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = deviceId,
            clientMutationId = ClientMutationId(mutationId),
            scopeId = SyncScopeId("comics:profile:main"),
            entityType = SyncEntityType("comic.chapter_state"),
            command = SyncCommand.SetChapterState(
                entityId = EpigraphEntityId("comic.chapter_state::manga:example:42::chapter-1"),
                state = state,
            ),
        )

    @Test
    fun `a book entry waits for its file and its cover to reach the Core`() = runTest {
        val bookId = bookEntityId(BOOK_SHA)
        queueBookEntry("entry", BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "PENDING_UPLOAD", localUri = "file:///book.pdf")
        linkBookAsset(bookId, COVER_SHA, "COVER", state = "PENDING_UPLOAD", localUri = "file:///cover.jpg")

        assertTrue(coordinator.claimReady(100, 1_000, 10).isEmpty())
        assertTrue(coordinator.claimReadyForScopes(100, 1_000, 10, setOf("books:global")).isEmpty())
        assertEquals(1, coordinator.pendingCount())

        setBookAsset(BOOK_SHA, state = "AVAILABLE", localUri = "file:///book.pdf", remoteAvailable = true)
        assertTrue(coordinator.claimReady(100, 1_000, 10).isEmpty())

        setBookAsset(COVER_SHA, state = "AVAILABLE", localUri = "file:///cover.jpg", remoteAvailable = true)
        assertEquals(listOf("entry"), coordinator.claimReady(100, 1_000, 10).map { it.client_mutation_id })
    }

    @Test
    fun `a book entry whose upload cannot run is not held back`() = runTest {
        val bookId = bookEntityId(BOOK_SHA)
        queueBookEntry("entry", BOOK_SHA)
        insertLocalBook(bookId, BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "ERROR", localUri = null)

        assertEquals(1, coordinator.claimReadyForScopes(100, 1_000, 10, setOf("books:global")).size)
    }

    @Test
    fun `a parked book entry sends its file again and then goes out under a new id`() = runTest {
        val bookId = bookEntityId(BOOK_SHA)
        parkBookEntry("refused", BOOK_SHA, "blocked:BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE")
        insertLocalBook(bookId, BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "ERROR", localUri = "file:///book.pdf")
        linkBookAsset(bookId, COVER_SHA, "COVER", state = "AVAILABLE", localUri = "file:///cover.jpg", remoteAvailable = true)

        assertEquals(1, coordinator.retryBookEntriesMissingAssets(200) { ClientMutationId("repaired") })

        val publication = database.aethon_syncQueries.selectAssetManifest(BOOK_SHA).executeAsOne()
        assertEquals("PENDING_UPLOAD", publication.state)
        assertFalse(publication.remote_available)
        assertEquals("AVAILABLE", database.aethon_syncQueries.selectAssetManifest(COVER_SHA).executeAsOne().state)
        assertEquals(0, coordinator.blockedCount())
        assertTrue(coordinator.claimReady(200, 1_000, 10).isEmpty())

        setBookAsset(BOOK_SHA, state = "AVAILABLE", localUri = "file:///book.pdf", remoteAvailable = true)
        val row = coordinator.claimReady(200, 1_000, 10).single()
        assertEquals("repaired", row.client_mutation_id)
        assertEquals(ClientMutationId("repaired"), decode(row.payload_json).clientMutationId)
    }

    @Test
    fun `a parked book entry only repairs the asset the Core refused`() = runTest {
        val bookId = bookEntityId(BOOK_SHA)
        parkBookEntry("refused", BOOK_SHA, "blocked:BOOK_COVER_ASSET_NOT_AVAILABLE_FOR_SCOPE")
        insertLocalBook(bookId, BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "AVAILABLE", localUri = "file:///book.pdf", remoteAvailable = true)
        linkBookAsset(bookId, COVER_SHA, "COVER", state = "AVAILABLE", localUri = "file:///cover.jpg", remoteAvailable = true)

        assertEquals(1, coordinator.retryBookEntriesMissingAssets(200) { ClientMutationId("repaired") })

        assertEquals("AVAILABLE", database.aethon_syncQueries.selectAssetManifest(BOOK_SHA).executeAsOne().state)
        assertEquals("PENDING_UPLOAD", database.aethon_syncQueries.selectAssetManifest(COVER_SHA).executeAsOne().state)
    }

    @Test
    fun `the automatic book repair stops once the Core keeps refusing`() = runTest {
        val deviceId = DeviceId("phone-a")
        val bookId = bookEntityId(BOOK_SHA)
        queueBookEntry("try-0", BOOK_SHA)
        insertLocalBook(bookId, BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "AVAILABLE", localUri = "file:///book.pdf", remoteAvailable = true)
        var repairs = 0
        var current = "try-0"

        repeat(10) { round ->
            val now = 200L + round
            setBookAsset(BOOK_SHA, state = "AVAILABLE", localUri = "file:///book.pdf", remoteAvailable = true)
            if (coordinator.claimReady(now, 1_000, 10).isEmpty()) return@repeat
            coordinator.markFailed(deviceId, ClientMutationId(current), "blocked:BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE", Long.MAX_VALUE)
            val next = "try-${round + 1}"
            if (coordinator.retryBookEntriesMissingAssets(now) { ClientMutationId(next) } == 1) {
                repairs++
                current = next
            }
        }

        assertEquals(3, repairs)
        assertEquals(1, coordinator.blockedCount())
    }

    @Test
    fun `a parked book entry whose file left the phone stays parked for the user`() = runTest {
        val bookId = bookEntityId(BOOK_SHA)
        parkBookEntry("refused", BOOK_SHA, "blocked:BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE")
        insertLocalBook(bookId, BOOK_SHA)
        linkBookAsset(bookId, BOOK_SHA, "PUBLICATION", state = "ERROR", localUri = null)

        assertEquals(0, coordinator.retryBookEntriesMissingAssets(200) { ClientMutationId("repaired") })

        assertEquals(1, coordinator.blockedCount())
        assertEquals("ERROR", database.aethon_syncQueries.selectAssetManifest(BOOK_SHA).executeAsOne().state)
    }

    @Test
    fun `entries of removed books that could never publish are dropped`() = runTest {
        val parked = bookEntityId(BOOK_SHA)
        parkBookEntry("parked", BOOK_SHA, "blocked:BOOK_ASSET_NOT_AVAILABLE_FOR_SCOPE")
        linkBookAsset(parked, BOOK_SHA, "PUBLICATION", state = "ERROR", localUri = null)
        val queued = bookEntityId(COVER_SHA)
        queueBookEntry("queued", COVER_SHA)
        linkBookAsset(queued, COVER_SHA, "PUBLICATION", state = "PENDING_UPLOAD", localUri = "file:///gone.pdf")

        assertEquals(0, coordinator.retryBookEntriesMissingAssets(200) { ClientMutationId("repaired") })

        assertEquals(0, coordinator.blockedCount())
        assertEquals(0, coordinator.pendingCount())
    }

    @Test
    fun `removed books keep what the Core can still use`() = runTest {
        val published = bookEntityId(BOOK_SHA)
        queueBookEntry("published", BOOK_SHA)
        linkBookAsset(published, BOOK_SHA, "PUBLICATION", state = "AVAILABLE", localUri = null, remoteAvailable = true)
        val removal = bookEntityId(COVER_SHA)
        coordinator.mutateLocal(
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = DeviceId("phone-a"),
                clientMutationId = ClientMutationId("tombstone"),
                scopeId = SyncScopeId("books:global"),
                entityType = SyncEntityType("book.entry"),
                command = SyncCommand.DeleteEntity(EpigraphEntityId(removal)),
            ),
            100,
        ) { Unit }
        linkBookAsset(removal, COVER_SHA, "PUBLICATION", state = "ERROR", localUri = null)

        coordinator.retryBookEntriesMissingAssets(200) { ClientMutationId("repaired") }

        assertEquals(
            setOf("published", "tombstone"),
            coordinator.claimReady(200, 1_000, 10).map { it.client_mutation_id }.toSet(),
        )
    }

    private suspend fun queueBookEntry(mutationId: String, sha256: String) {
        val bookId = EpigraphEntityId(bookEntityId(sha256))
        coordinator.mutateLocal(
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = DeviceId("phone-a"),
                clientMutationId = ClientMutationId(mutationId),
                scopeId = SyncScopeId("books:global"),
                entityType = SyncEntityType("book.entry"),
                command = SyncCommand.UpsertBookEntry(
                    bookId,
                    BookEntrySnapshot(
                        bookId = bookId,
                        contentType = ContentType.PDF,
                        sha256 = sha256,
                        title = "Example",
                        mimeType = "application/pdf",
                        byteSize = 10,
                        createdAtEpochMillis = 100,
                        updatedAtEpochMillis = 100,
                    ),
                ),
            ),
            100,
        ) { Unit }
    }

    private suspend fun parkBookEntry(mutationId: String, sha256: String, error: String) {
        queueBookEntry(mutationId, sha256)
        coordinator.claimReady(100, 1_000, 10)
        coordinator.markFailed(DeviceId("phone-a"), ClientMutationId(mutationId), error, Long.MAX_VALUE)
    }

    private fun linkBookAsset(
        entityId: String,
        sha256: String,
        role: String,
        state: String,
        localUri: String?,
        remoteAvailable: Boolean = false,
    ) {
        database.aethon_syncQueries.upsertIdentity(entityId, "PDF", entityId, 100, 100)
        database.aethon_syncQueries.insertAssetManifest(
            sha256 = sha256,
            contentType = if (role == "COVER") "BOOK_COVER" else "PDF",
            byteSize = 10,
            mimeType = if (role == "COVER") "image/jpeg" else "application/pdf",
            localUri = localUri,
            remoteAvailable = remoteAvailable,
            state = state,
            updatedAt = 100,
        )
        database.aethon_syncQueries.linkEntityAsset(entityId, sha256, role, "", 0)
    }

    private fun setBookAsset(sha256: String, state: String, localUri: String?, remoteAvailable: Boolean) {
        val asset = database.aethon_syncQueries.selectAssetManifest(sha256).executeAsOne()
        database.aethon_syncQueries.updateAssetMaterialization(
            localUri = localUri,
            remoteAvailable = remoteAvailable,
            state = state,
            updatedAt = 100,
            sha256 = sha256,
            contentType = asset.content_type,
            byteSize = asset.byte_size,
            mimeType = asset.mime_type,
        )
    }

    private fun insertLocalBook(bookId: String, sha256: String) {
        database.local_booksQueries.insert(
            bookId = bookId,
            contentType = "PDF",
            sha256 = sha256,
            displayName = "Example",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "book.pdf",
            mimeType = "application/pdf",
            byteSize = 10,
            chapterCount = null,
            pageCount = null,
            importedAt = 100,
            updatedAt = 100,
        )
    }

    private fun bookEntityId(sha256: String) = "pdf:sha256:$sha256"

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
