package epigraph.sync.core.suwayomi

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
import epigraph.sync.ClientMutationIdFactory
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import eu.kanade.tachiyomi.source.SourceManager
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class LocalComicLibraryOutboxRepairTest {
    private val driver = JdbcSqliteDriver(
        JdbcSqliteDriver.IN_MEMORY,
        java.util.Properties().apply { put("foreign_keys", "true") },
    ).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val queries = database.aethon_syncQueries
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val coordinator = EpigraphMutationCoordinator(handler)
    private val sources = mockk<SourceManager>().also {
        coEvery { it.awaitExtensionSource(any(), any()) } returns null
    }
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }

    private val work = PortableWorkRef.Comic(DecimalSourceId(NATIVE_SOURCE.toString()), ProviderOwnedKey(PROVIDER_KEY))
    private val workId = PortableIdentityV3.workId(work)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `a title held only through a previous Core reaches the new one`() = runTest {
        val mangaId = insertBridgeRow(PREVIOUS_SERVER)
        replayedSnapshot()

        val emitted = repair().repair()

        assertEquals(1, emitted)
        val command = commands().single() as SyncCommand.SetLibraryMembership
        assertEquals(workId, command.entityId.value)
        assertEquals(work, command.portableWorkRef)
        assertEquals("Stranded", command.titleHint)
        // The row stays on the bridge, so its extension can still claim it when it arrives.
        assertEquals(EpigraphCoreSource.ID, database.mangasQueries.findById(mangaId).executeAsOne().source)
        assertNull(queries.selectPortableWorkBinding(workId).executeAsOneOrNull())
    }

    @Test
    fun `a title already on its way is not sent twice`() = runTest {
        insertBridgeRow(PREVIOUS_SERVER)
        replayedSnapshot()

        repair().repair()

        assertEquals(0, repair().repair())
    }

    @Test
    fun `a bridge row of the paired Core is not brought back`() = runTest {
        insertBridgeRow(CURRENT_SERVER)
        replayedSnapshot()

        assertEquals(0, repair().repair())
    }

    @Test
    fun `a work the new Core removed stays removed`() = runTest {
        insertBridgeRow(PREVIOUS_SERVER)
        replayedSnapshot()
        queries.upsertCoreReplicaTombstone(
            scopeId = COMIC_SCOPE,
            entityType = EpigraphCoreEntityType.COMIC_ENTRY,
            entityId = workId,
            serverVersion = 1,
            lamport = 1,
            deletedAt = 1,
            reasonCode = null,
            payloadSha256 = "a".repeat(64),
        )

        assertEquals(0, repair().repair())
    }

    @Test
    fun `nothing is sent before the new Core's snapshot is replayed`() = runTest {
        insertBridgeRow(PREVIOUS_SERVER)

        assertEquals(0, repair().repair())
    }

    @Test
    fun `a title with no source on record stays local`() = runTest {
        insertBridgeRow(PREVIOUS_SERVER, withSourceBinding = false)
        replayedSnapshot()

        assertEquals(0, repair().repair())
    }

    @Test
    fun `a bound favorite is republished without waiting for its extension`() = runTest {
        val mangaId = insertRow(NATIVE_SOURCE, PROVIDER_KEY)
        queries.upsertIdentity(workId, "MANGA", mangaId.toString(), 1, 1)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        replayedSnapshot()

        assertEquals(1, repair().repair())

        assertEquals(work, (commands().single() as SyncCommand.SetLibraryMembership).portableWorkRef)
        coVerify(exactly = 0) { sources.awaitExtensionSource(any(), any()) }
    }

    private fun repair(): LocalComicLibraryOutboxRepair {
        val scopes = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(SyncScopeId("novels:profile:main"), SyncScopeId(COMIC_SCOPE), CURRENT_SERVER)
        }
        var sequence = 0
        val router = EpigraphLibraryMutationRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone-a"),
            scopeId = SyncScopeId(COMIC_SCOPE),
            mutationIds = ClientMutationIdFactory { ClientMutationId("mutation-${System.nanoTime()}-${++sequence}") },
            scopeProvider = scopes,
        )
        return LocalComicLibraryOutboxRepair(handler, sources, router, scopes)
    }

    private suspend fun commands(): List<SyncCommand> =
        coordinator.claimReady(System.currentTimeMillis(), 1_000, 10)
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command }

    private fun replayedSnapshot() {
        queries.upsertCoreReplicaCheckpoint("comics", "FILTERED", COMIC_SCOPE, 1, 1)
    }

    private fun insertBridgeRow(serverId: String, withSourceBinding: Boolean = true): Long {
        val mangaId = insertRow(EpigraphCoreSource.ID, "aethon-core://suwayomi/$serverId/main/manga/7")
        val entityId = "suwayomi:server:$serverId:profile:main:manga:7"
        queries.upsertIdentity(entityId, "MANGA", mangaId.toString(), 1, 1)
        if (withSourceBinding) {
            queries.insertBinding(
                "binding",
                entityId,
                "SUWAYOMI",
                "aethon-core:$serverId",
                "pkg",
                NATIVE_SOURCE.toString(),
                PROVIDER_KEY,
                true,
                1,
            )
        }
        return mangaId
    }

    private fun insertRow(source: Long, url: String): Long {
        database.mangasQueries.insert(
            source = source,
            url = url,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Stranded",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = 0,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = 0,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        return database.mangasQueries.selectLastInsertedRowId().executeAsOne()
    }

    private companion object {
        const val COMIC_SCOPE = "comics:profile:main"
        const val CURRENT_SERVER = "new-server"
        const val PREVIOUS_SERVER = "old-server"
        const val NATIVE_SOURCE = 42L
        const val PROVIDER_KEY = "/manga/stranded"
    }
}
