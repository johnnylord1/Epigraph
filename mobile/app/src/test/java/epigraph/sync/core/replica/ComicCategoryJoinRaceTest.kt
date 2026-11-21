package epigraph.sync.core.replica

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
import epigraph.sync.EpigraphCategoryMutationRouter
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class ComicCategoryJoinRaceTest {
    private val driver = JdbcSqliteDriver(
        JdbcSqliteDriver.IN_MEMORY,
        java.util.Properties().apply { put("foreign_keys", "true") },
    ).also { Database.Schema.create(it) }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private var wakes = 0
    private val coordinator = EpigraphMutationCoordinator(
        databaseHandler = handler,
        onLocalMutationEnqueued = { wakes++ },
    )
    private var mutationSeq = 0
    private val router = EpigraphCategoryMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        mutationIds = ClientMutationIdFactory { ClientMutationId("cat-mut-${++mutationSeq}") },
        scopeProvider = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(SyncScopeId("novels:profile:main"), SyncScopeId(COMIC_SCOPE), "desk-b")
        },
        clock = { 2_000L },
    )
    private val projection = EpigraphCoreDomainProjection(
        onComicCategoryJoined = { db, localCategoryId, categoryEntityId ->
            router.enqueueJoinedComicCategoryAssignmentsInTransaction(db, localCategoryId, categoryEntityId)
        },
    )
    private val replica = SqlDelightCoreReplicaStore(handler, projection)
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `remote comic category arriving before create hook binds existing folder and queues assignments once`() = runTest {
        val dropado = insertFolder("Dropado")
        val work1 = insertBoundComicInCategory("/manga/bleach", "Bleach", dropado)
        val work2 = insertBoundComicInCategory("/manga/eleceed", "Eleceed", dropado)
        val remoteId = "suwayomi:server:desk-b:profile:main:category:7"

        // Simulate SSE delivering Core B's newly created category before CREATE_CATEGORY HTTP returns.
        replica.transaction {
            val record = comicCategoryRecord(remoteId, "Dropado", order = 3, serverVersion = 10)
            upsertConfirmed(record)
            projectConfirmed(record)
        }

        // Single folder preserved, bound to Core B, both comic assignments queued atomically, wake fired once.
        val folders = database.categoriesQueries.findAll().executeAsList().filter { it.name == "Dropado" }
        assertEquals(listOf(dropado), folders.map { it._id })
        assertEquals(
            dropado,
            database.aethon_syncQueries.selectCategoryIdentityByEntityId(remoteId).executeAsOne().local_category_id,
        )
        assertEquals(1, wakes)
        val queued = queuedAssignments()
        assertEquals(setOf(work1, work2), queued.map { it.entityId.value }.toSet())
        assertTrue(queued.all { it.categoryId.value == remoteId && it.assigned })

        // When SuwayomiCategoryCreateHook's HTTP response arrives next, binding is a clean no-op.
        val hookResult = router.bindCreatedComicCategory(dropado, "Dropado", remoteId, 3)
        assertEquals(0, hookResult.emittedCommandCount)
        assertEquals(2, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `remote comic category replaces previous server binding on same folder and queues assignments`() = runTest {
        val dropado = insertFolder("Dropado")
        val oldId = "suwayomi:server:desk-a:profile:main:category:3"
        database.aethon_syncQueries.upsertCategoryScope(dropado, "MANGA")
        database.aethon_syncQueries.upsertCategoryIdentity(oldId, dropado, "MANGA", "Dropado", 1, 100)
        val work1 = insertBoundComicInCategory("/manga/bleach", "Bleach", dropado)
        val newId = "suwayomi:server:desk-b:profile:main:category:7"

        // Snapshot from Core B arrives before SuwayomiCategoryCreateHook releases Core A's binding.
        replica.transaction {
            val record = comicCategoryRecord(newId, "Dropado", order = 2, serverVersion = 5)
            upsertConfirmed(record)
            projectConfirmed(record)
        }

        val folders = database.categoriesQueries.findAll().executeAsList().filter { it.name == "Dropado" }
        assertEquals(listOf(dropado), folders.map { it._id })
        assertNull(database.aethon_syncQueries.selectCategoryIdentityByEntityId(oldId).executeAsOneOrNull())
        assertEquals(
            dropado,
            database.aethon_syncQueries.selectCategoryIdentityByEntityId(newId).executeAsOne().local_category_id,
        )
        val queued = queuedAssignments()
        assertEquals(listOf(work1), queued.map { it.entityId.value })
        assertEquals(newId, queued.single().categoryId.value)
        assertEquals(1, wakes)
    }

    @Test
    fun `another live category of the same server is not hijacked even with the same name`() = runTest {
        val existing = insertFolder("Dropado")
        val idA = "suwayomi:server:desk-b:profile:main:category:2"
        val idB = "suwayomi:server:desk-b:profile:main:category:7"
        database.aethon_syncQueries.upsertCategoryScope(existing, "MANGA")
        database.aethon_syncQueries.upsertCategoryIdentity(idA, existing, "MANGA", "Dropado", 1, 100)
        insertBoundComicInCategory("/manga/bleach", "Bleach", existing)

        replica.transaction {
            val record = comicCategoryRecord(idB, "Dropado", order = 2, serverVersion = 5)
            upsertConfirmed(record)
            projectConfirmed(record)
        }

        val secondLocal = database.aethon_syncQueries.selectCategoryIdentityByEntityId(idB).executeAsOne().local_category_id
        assertNotEquals(existing, secondLocal)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(0, wakes)
    }

    @Test
    fun `a category from another profile keeps the original folder and assignments isolated`() = runTest {
        val original = insertFolder("Dropado")
        val oldId = "suwayomi:server:desk-a:profile:main:category:3"
        val newId = "suwayomi:server:desk-b:profile:test:category:7"
        database.aethon_syncQueries.upsertCategoryScope(original, "MANGA")
        database.aethon_syncQueries.upsertCategoryIdentity(oldId, original, "MANGA", "Dropado", 1, 100)
        insertBoundComicInCategory("/manga/bleach", "Bleach", original)

        replica.transaction {
            val record = comicCategoryRecord(newId, "Dropado", order = 2, serverVersion = 5, scopeId = "comics:profile:test")
            upsertConfirmed(record)
            projectConfirmed(record)
        }

        val queries = database.aethon_syncQueries
        assertEquals(original, queries.selectCategoryIdentityByEntityId(oldId).executeAsOneOrNull()?.local_category_id)
        assertNotEquals(original, queries.selectCategoryIdentityByEntityId(newId).executeAsOne().local_category_id)
        assertEquals(0, queries.pendingMutationCount().executeAsOne())
        assertEquals(0, wakes)
    }

    @Test
    fun `nested replica projection wakes sync only after the outer transaction commits`() = runTest {
        val dropado = insertFolder("Dropado")
        insertBoundComicInCategory("/manga/bleach", "Bleach", dropado)
        val remoteId = "suwayomi:server:desk-b:profile:main:category:7"
        val record = comicCategoryRecord(remoteId, "Dropado", order = 3, serverVersion = 10)

        handler.await(inTransaction = true) {
            replica.transaction {
                upsertConfirmed(record)
                projectConfirmed(record)
            }
            assertEquals(0, wakes)
        }

        assertEquals(1, wakes)
        assertEquals(1, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `catalog projection wakes sync only after its transaction commits`() = runTest {
        val dropado = insertFolder("Dropado")
        insertBoundComicInCategory("/manga/bleach", "Bleach", dropado)
        val record = comicCategoryRecord("suwayomi:server:desk-b:profile:main:category:7", "Dropado", order = 3, serverVersion = 10)

        handler.await(inTransaction = true) {
            projection.upsert(this, record)
            assertEquals(0, wakes)
        }

        assertEquals(1, wakes)
        assertEquals(1, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `rolling back the replica transaction leaves folder unbound, outbox empty and fires no wake`() = runTest {
        val dropado = insertFolder("Dropado")
        insertBoundComicInCategory("/manga/bleach", "Bleach", dropado)
        val remoteId = "suwayomi:server:desk-b:profile:main:category:7"

        val failure = runCatching {
            replica.transaction {
                val record = comicCategoryRecord(remoteId, "Dropado", order = 3, serverVersion = 10)
                upsertConfirmed(record)
                projectConfirmed(record)
                error("simulated failure after projectConfirmed")
            }
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
        assertNull(database.aethon_syncQueries.selectCategoryIdentityByEntityId(remoteId).executeAsOneOrNull())
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(0, wakes)
    }

    private fun insertFolder(name: String): Long {
        database.categoriesQueries.insert(name = name, sort = 1, flags = 0, mangaOrder = "a")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun insertBoundComicInCategory(url: String, title: String, categoryId: Long): String {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey(url))
        val workId = PortableIdentityV3.workId(work)
        database.mangasQueries.insert(
            source = 42L, url = url, artist = null, author = null, description = null,
            genre = null, title = title, status = 0, thumbnailUrl = null, favorite = true,
            lastUpdate = 0, initialized = true, viewer = 0, hideTitle = false, chapterFlags = 0,
            dateAdded = 0, filteredScanlators = null, updateStrategy = 0, coverLastModified = 0,
            nextUpdate = 0, fetchInterval = 0, memo = JsonObject(emptyMap()),
        )
        val mangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertIdentity(workId, "MANGA", mangaId.toString(), 1, 1)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = title,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        database.aethon_syncQueries.insertMangaCategoryAssignment(mangaId, categoryId)
        return workId
    }

    private fun comicCategoryRecord(
        entityId: String,
        name: String,
        order: Long,
        serverVersion: Long,
        scopeId: String = COMIC_SCOPE,
    ) = CoreConfirmedRecord(
        key = CoreReplicaKey(scopeId, "comic.category", entityId),
        serverVersion = serverVersion,
        lamport = serverVersion,
        record = buildJsonObject {
            put("name", name)
            put("order", order)
        },
    )

    private suspend fun queuedAssignments(): List<SyncCommand.SetCategoryAssignment> =
        coordinator.claimReady(System.currentTimeMillis() + 10_000, 1_000, 50)
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command as SyncCommand.SetCategoryAssignment }

    private companion object {
        const val COMIC_SCOPE = "comics:profile:main"
    }
}
