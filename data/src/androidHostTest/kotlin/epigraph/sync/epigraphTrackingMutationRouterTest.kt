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
    ) = EpigraphTrackingMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        mutationIds = mutationIds,
        scopeProvider = scopeProvider,
        gate = gate,
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

    private fun insertManga(url: String): Long {
        database.mangasQueries.insert(
            source = 10002,
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
}
