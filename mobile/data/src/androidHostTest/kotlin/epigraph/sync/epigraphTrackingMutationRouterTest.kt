package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ClientMutationId
import epigraph.contract.DecimalSourceId
import epigraph.contract.DeviceId
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncScopeId
import epigraph.contract.TrackingField
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphTrackingMutationRouterTest {
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
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }
    private val scopes = EpigraphSyncScopes(
        novels = SyncScopeId("novels:profile:main"),
        comics = SyncScopeId("comics:profile:main"),
    )

    @AfterEach
    fun closeDriver() {
        driver.close()
    }

    @Test
    fun `novel tracker write and patch commit together`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")

        val result = router().upsert(listOf(row(mangaId, syncId = 10)), EpigraphMutationOrigin.LOCAL_USER, 100)

        assertEquals(TrackingMutationResult(changedRows = 1, emittedCommandCount = 1), result)
        assertEquals(1, database.manga_syncQueries.getAllByMangaId(mangaId).executeAsList().size)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals("novel.tracking", queued.entity_type)
        assertEquals("novels:profile:main", queued.scope_id)
        assertEquals("novel.tracking::novel:abc::novelupdates", queued.entity_id)
        val command = json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command
        command as SyncCommand.PatchTracking
        assertEquals("novelupdates", command.trackerId)
        val fields = command.fields.associate { it.field to it.value }
        assertEquals("4242", fields[TrackingField.REMOTE_ID])
        assertEquals("Shadow Slave", fields[TrackingField.TITLE])
        assertEquals("12.5", fields[TrackingField.PROGRESS])
        assertEquals(null, fields[TrackingField.LIBRARY_ID])
        assertTrue(TrackingField.LIBRARY_ID in fields)
    }

    @Test
    fun `unchanged tracker row writes nothing`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")
        val router = router()
        router.upsert(listOf(row(mangaId, syncId = 10)), EpigraphMutationOrigin.LOCAL_USER, 100)

        val second = router.upsert(listOf(row(mangaId, syncId = 10)), EpigraphMutationOrigin.LOCAL_USER, 200)

        assertEquals(TrackingMutationResult(0, 0), second)
        assertEquals(1, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `tracker writes stay local when the core does not advertise tracking`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")

        val result = router(gate = TrackingSyncGate { false })
            .upsert(listOf(row(mangaId, syncId = 10)), EpigraphMutationOrigin.LOCAL_USER, 100)

        assertEquals(TrackingMutationResult(1, 0), result)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `replayed and unpaired writes never reach the outbox`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")

        router().upsert(listOf(row(mangaId, syncId = 10)), EpigraphMutationOrigin.REMOTE_EPIGRAPH, 100)
        val unpaired = router(scopeProvider = EpigraphSyncScopeProvider { error("not paired") })
            .upsert(listOf(row(mangaId, syncId = 11)), EpigraphMutationOrigin.LOCAL_USER, 100)

        assertEquals(TrackingMutationResult(1, 0), unpaired)
        assertEquals(2, database.manga_syncQueries.getAllByMangaId(mangaId).executeAsList().size)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `comic tracking requires a bound portable work`() = runTest {
        val unbound = insertManga("/comic/unbound")
        val bound = insertManga("/Manga/Bound")
        val work = PortableWorkRef.Comic(DecimalSourceId("10002"), ProviderOwnedKey("/Manga/Bound"))
        bindPortable(bound, work)

        val result = router().upsert(
            listOf(row(unbound, syncId = 2), row(bound, syncId = 2)),
            EpigraphMutationOrigin.LOCAL_USER,
            100,
        )

        assertEquals(TrackingMutationResult(2, 1), result)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals("comic.tracking", queued.entity_type)
        assertEquals("comics:profile:main", queued.scope_id)
        assertEquals("comic.tracking::${PortableIdentityV3.workId(work)}::anilist", queued.entity_id)
    }

    @Test
    fun `core-backed comic waiting for its extension still reaches the core`() = runTest {
        val (mangaId, trackingId) = coreBackedComic()

        val withoutCore = router().upsert(listOf(row(mangaId, syncId = 2)), EpigraphMutationOrigin.LOCAL_USER, 50)
        val result = router(coreSourceId = CORE_SOURCE_ID)
            .upsert(listOf(row(mangaId, syncId = 2).copy(lastChapterRead = 38.0)), EpigraphMutationOrigin.LOCAL_USER, 100)

        assertEquals(TrackingMutationResult(1, 0), withoutCore)
        assertEquals(TrackingMutationResult(1, 1), result)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals("comic.tracking", queued.entity_type)
        assertEquals("comics:profile:main", queued.scope_id)
        assertEquals(trackingId, queued.entity_id)
    }

    @Test
    fun `core-backed comic is reconciled in both directions`() = runTest {
        val (published, _) = coreBackedComic("/Manga/Published")
        database.manga_syncQueries.insertRow(row(published, syncId = 2))
        val (applied, appliedId) = coreBackedComic("/Manga/Applied")
        replicaRecord(appliedId, progress = 37.0)

        val result = router(coreSourceId = CORE_SOURCE_ID).reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(publishedRows = 1, appliedRows = 1, removedRows = 0), result)
        assertEquals(37.0, database.manga_syncQueries.getAllByMangaId(applied).executeAsOne().last_chapter_read)
    }

    @Test
    fun `tracker removal emits a tombstone for the same record`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")
        val router = router()
        router.upsert(listOf(row(mangaId, syncId = 12)), EpigraphMutationOrigin.LOCAL_USER, 100)
        coordinator.claimReady(100, 1_000, 10)

        val removed = router.delete(mangaId, 12, EpigraphMutationOrigin.LOCAL_USER, 200)
        val missing = router.delete(mangaId, 12, EpigraphMutationOrigin.LOCAL_USER, 300)

        assertEquals(TrackingMutationResult(1, 1), removed)
        assertEquals(TrackingMutationResult(0, 0), missing)
        assertTrue(database.manga_syncQueries.getAllByMangaId(mangaId).executeAsList().isEmpty())
        val queued = coordinator.claimReady(200, 1_000, 10).single()
        assertEquals("novel.tracking::novel:abc::hardcover", queued.entity_id)
        assertTrue(json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command is SyncCommand.DeleteEntity)
    }

    @Test
    fun `outbox failure rolls the tracker rows back`() = runTest {
        val mangaId = insertManga("/novel/1")
        bindNovelIdentity(mangaId, "novel:abc")

        val failure = runCatching {
            router(mutationIds = ClientMutationIdFactory { ClientMutationId("duplicate") }).upsert(
                listOf(row(mangaId, syncId = 10), row(mangaId, syncId = 11)),
                EpigraphMutationOrigin.LOCAL_USER,
                100,
            )
        }.exceptionOrNull()

        assertNotNull(failure)
        assertTrue(database.manga_syncQueries.getAllByMangaId(mangaId).executeAsList().isEmpty())
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `bindings that never reached the core are published once`() = runTest {
        val (mangaId, trackingId) = boundComic()
        database.manga_syncQueries.insertRow(row(mangaId, syncId = 2))

        val result = router().reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(publishedRows = 1, appliedRows = 0, removedRows = 0), result)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        assertEquals(trackingId, queued.entity_id)
        assertTrue(json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command is SyncCommand.PatchTracking)
        // The queued patch blocks a second publication until the replica confirms it.
        assertEquals(TrackingReconcileResult(0, 0, 0), router().reconcileWithReplica(200))
    }

    @Test
    fun `confirmed core record wins over a different local row without echo`() = runTest {
        val (mangaId, trackingId) = boundComic()
        database.manga_syncQueries.insertRow(row(mangaId, syncId = 2))
        replicaRecord(trackingId, progress = 20.0)

        val result = router().reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(0, 1, 0), result)
        assertEquals(20.0, database.manga_syncQueries.getAllByMangaId(mangaId).executeAsOne().last_chapter_read)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(TrackingReconcileResult(0, 0, 0), router().reconcileWithReplica(200))
    }

    @Test
    fun `pending local tracker change is not overwritten by an older replica`() = runTest {
        val (mangaId, trackingId) = boundComic()
        replicaRecord(trackingId, progress = 20.0)
        router().upsert(listOf(row(mangaId, syncId = 2)), EpigraphMutationOrigin.LOCAL_USER, 50)

        val result = router().reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(0, 0, 0), result)
        assertEquals(12.5, database.manga_syncQueries.getAllByMangaId(mangaId).executeAsOne().last_chapter_read)
    }

    @Test
    fun `core tombstone removes the local binding`() = runTest {
        val (mangaId, trackingId) = boundComic()
        database.manga_syncQueries.insertRow(row(mangaId, syncId = 2))
        database.aethon_syncQueries.upsertCoreReplicaTombstone(
            scopeId = "comics:profile:main",
            entityType = "comic.tracking",
            entityId = trackingId,
            serverVersion = 7,
            lamport = 7,
            deletedAt = 1,
            reasonCode = null,
            payloadSha256 = "0".repeat(64),
        )

        val result = router().reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(0, 0, 1), result)
        assertTrue(database.manga_syncQueries.getAllByMangaId(mangaId).executeAsList().isEmpty())
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `core record is applied once its work binds locally`() = runTest {
        val (mangaId, trackingId) = boundComic()
        replicaRecord(trackingId, progress = 33.0)

        val result = router().reconcileWithReplica(100)

        assertEquals(TrackingReconcileResult(0, 1, 0), result)
        val local = database.manga_syncQueries.getAllByMangaId(mangaId).executeAsOne()
        assertEquals(2, local.sync_id)
        assertEquals(33.0, local.last_chapter_read)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `reconciliation stays local when the core does not advertise tracking`() = runTest {
        val (mangaId, _) = boundComic()
        database.manga_syncQueries.insertRow(row(mangaId, syncId = 2))

        assertEquals(TrackingReconcileResult(0, 0, 0), router(gate = TrackingSyncGate { false }).reconcileWithReplica(100))
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `tracker keys are stable and reversible`() {
        assertEquals(12, TrackerSyncKeys.all.size)
        TrackerSyncKeys.all.forEach { (id, key) -> assertEquals(id, TrackerSyncKeys.syncIdFor(key)) }
        assertEquals("novelupdates", TrackerSyncKeys.keyFor(10))
        assertEquals(null, TrackerSyncKeys.keyFor(99))
    }

    private fun router(
        gate: TrackingSyncGate = TrackingSyncGate { true },
        scopeProvider: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider { scopes },
        mutationIds: ClientMutationIdFactory = sequentialMutationIds(),
        coreSourceId: Long? = null,
    ) = EpigraphTrackingMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        mutationIds = mutationIds,
        scopeProvider = scopeProvider,
        gate = gate,
        coreSourceId = coreSourceId,
    )

    private fun sequentialMutationIds(): ClientMutationIdFactory {
        var sequence = 0
        return ClientMutationIdFactory { ClientMutationId("mutation-${++sequence}") }
    }

    private fun row(mangaId: Long, syncId: Long) = TrackingRow(
        mangaId = mangaId,
        syncId = syncId,
        remoteId = 4242,
        libraryId = null,
        title = "Shadow Slave",
        lastChapterRead = 12.5,
        totalChapters = 100,
        status = 1,
        score = 8.0,
        remoteUrl = "https://tracker.example/4242",
        startDate = 1_700_000_000_000,
        finishDate = 0,
    )

    private fun boundComic(): Pair<Long, String> {
        val mangaId = insertManga("/Manga/Bound")
        val work = PortableWorkRef.Comic(DecimalSourceId("10002"), ProviderOwnedKey("/Manga/Bound"))
        bindPortable(mangaId, work)
        return mangaId to "comic.tracking::${PortableIdentityV3.workId(work)}::anilist"
    }

    /** A comic shown through its Core-backed row while its native extension is missing. */
    private fun coreBackedComic(providerKey: String = "/Manga/Waiting"): Pair<Long, String> {
        val mangaId = insertManga(providerKey, source = CORE_SOURCE_ID)
        val entityId = "manga:core:$mangaId"
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        database.aethon_syncQueries.insertBinding(
            bindingId = "binding:$entityId",
            entityId = entityId,
            ecosystem = "SUWAYOMI",
            repository = "fixture",
            pluginPackage = "unknown",
            sourceId = "10002",
            normalizedUrl = providerKey,
            isPrimary = true,
            createdAt = 1,
        )
        val work = PortableWorkRef.Comic(DecimalSourceId("10002"), ProviderOwnedKey(providerKey))
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(work),
                ref = work,
                localReference = null,
                resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                titleHint = "Example",
                providerLabelHint = "Fixture",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        return mangaId to "comic.tracking::${PortableIdentityV3.workId(work)}::anilist"
    }

    private fun replicaRecord(trackingId: String, progress: Double) {
        val workId = trackingId.removePrefix("comic.tracking::").removeSuffix("::anilist")
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = "comics:profile:main",
            entityType = "comic.tracking",
            entityId = trackingId,
            serverVersion = 5,
            lamport = 5,
            recordJson = """{"trackingId":"$trackingId","comicId":"$workId","trackerKey":"anilist",""" +
                """"remoteId":4242,"libraryId":null,"title":"Shadow Slave","remoteUrl":"https://tracker.example/4242",""" +
                """"status":1,"progress":$progress,"totalChapters":100,"score":8.0,""" +
                """"startedAtMs":1700000000000,"finishedAtMs":0,"updatedAtMs":1}""",
            payloadSha256 = "0".repeat(64),
        )
    }

    private fun tachiyomi.data.Manga_syncQueries.insertRow(row: TrackingRow) = insert(
        mangaId = row.mangaId,
        syncId = row.syncId,
        remoteId = row.remoteId,
        libraryId = row.libraryId,
        title = row.title,
        lastChapterRead = row.lastChapterRead,
        totalChapters = row.totalChapters,
        status = row.status,
        score = row.score,
        remoteUrl = row.remoteUrl,
        startDate = row.startDate,
        finishDate = row.finishDate,
    )

    private fun insertManga(url: String, source: Long = 10002): Long {
        database.mangasQueries.insert(
            source = source,
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

    private fun bindNovelIdentity(mangaId: Long, entityId: String) {
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = "NOVEL",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
    }

    private fun bindPortable(mangaId: Long, work: PortableWorkRef.Comic) {
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(work),
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Example",
                providerLabelHint = "Fixture",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
    }

    private companion object {
        const val CORE_SOURCE_ID = 3_238_364_976_084_580_419L
    }
}
