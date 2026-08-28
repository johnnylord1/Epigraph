package epigraph.sync

import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import kotlinx.serialization.json.JsonObject
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.CategoryScope
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncScopeId
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphLibraryMutationRouterTest {
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

    @AfterEach
    fun closeDriver() {
        driver.close()
    }

    @Test
    fun `favorite and category changes commit atomically in protocol order`() = runTest {
        val mangaId = insertManga(favorite = false)
        val categoryTwo = insertCategory("Two", sort = 2)
        val categoryOne = insertCategory("One", sort = 1)
        bindMangaIdentity(mangaId, "suwayomi:profile:main:manga:7")
        bindCategoryIdentity(categoryOne, "suwayomi:profile:main:category:11", "One", 1)
        bindCategoryIdentity(categoryTwo, "suwayomi:profile:main:category:12", "Two", 2)
        val router = router(sequentialMutationIds())

        val result = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = setOf(categoryTwo, categoryOne),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 100,
        )

        assertTrue(result.changed)
        assertTrue(result.membershipChanged)
        assertEquals(setOf(categoryOne, categoryTwo), result.addedCategoryIds)
        assertEquals(2, result.emittedCommandCount)
        assertTrue(database.mangasQueries.findById(mangaId).executeAsOne().favorite)
        assertEquals(
            setOf(categoryOne, categoryTwo),
            database.categoriesQueries.findAllByMangaId(mangaId).executeAsList().map { it._id }.toSet(),
        )

        val queued = database.aethon_suwayomi_mutation_queueQueries
            .selectReady(100, 10)
            .executeAsList()
        assertEquals(
            listOf(
                "UpdateManga",
                "UpdateMangaCategories",
            ),
            queued.map { it.operation_name },
        )
        assertEquals(0, coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 10).size)
    }

    @Test
    fun `duplicate idempotency key rolls favorite and categories back`() = runTest {
        val mangaId = insertManga(favorite = false)
        val categoryId = insertCategory("Rollback", sort = 0)
        bindMangaIdentity(mangaId, "suwayomi:profile:main:manga:7")
        bindCategoryIdentity(categoryId, "suwayomi:profile:main:category:13", "Rollback", 0)
        val router = router(ClientMutationIdFactory { ClientMutationId("duplicate") })

        val failure = runCatching {
            router.setMembership(
                LibraryMembershipMutation(
                    localMangaId = mangaId,
                    inLibrary = true,
                    categoryIds = setOf(categoryId),
                    origin = EpigraphMutationOrigin.LOCAL_USER,
                ),
                createdAtEpochMillis = 100,
            )
        }.exceptionOrNull()

        assertNotNull(failure)
        assertFalse(database.mangasQueries.findById(mangaId).executeAsOne().favorite)
        assertTrue(database.categoriesQueries.findAllByMangaId(mangaId).executeAsList().isEmpty())
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(0, database.aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne())
    }

    @Test
    fun `no-op mutation does not write outbox`() = runTest {
        val mangaId = insertManga(favorite = false)
        bindMangaIdentity(mangaId)
        val router = router(sequentialMutationIds())

        val result = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = false,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 100,
        )

        assertFalse(result.changed)
        assertEquals(0, result.emittedCommandCount)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `catalog-backed comic mutation uses the paired profile scope`() = runTest {
        val mangaId = insertManga(favorite = false)
        bindMangaIdentity(mangaId, "suwayomi:profile:secondary:manga:7")
        val router = router(sequentialMutationIds(), scope = "comics:profile:main")

        router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 100,
        )

        val row = database.aethon_suwayomi_mutation_queueQueries
            .selectReady(100, 1)
            .executeAsList()
            .single()
        assertEquals("secondary", row.profile_id)
    }

    @Test
    fun `portable comic mutation uses only the causal Core path`() = runTest {
        val mangaId = insertManga(favorite = false)
        bindMangaIdentity(mangaId, "suwayomi:profile:main:manga:7")
        val work = PortableWorkRef.Comic(
            DecimalSourceId("10002"),
            ProviderOwnedKey("/Manga/KeepCase?part=A%2FB"),
        )
        val workId = PortableIdentityV3.workId(work)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Example",
                providerLabelHint = "Fixture",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        val router = router(sequentialMutationIds())

        val result = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 100,
        )

        assertEquals(1, result.emittedCommandCount)
        val queued = coordinator.claimReady(100, 1_000, 10).single()
        val command = json.decodeFromString<SyncCommandEnvelope>(queued.payload_json).command
        assertTrue(command is SyncCommand.SetLibraryMembership)
        command as SyncCommand.SetLibraryMembership
        assertEquals(workId, command.entityId.value)
        assertEquals(work, command.portableWorkRef)
        assertTrue(
            database.aethon_suwayomi_mutation_queueQueries
                .selectReady(100, 10)
                .executeAsList()
                .isEmpty(),
        )
    }

    @Test
    fun `remote replay and source refresh apply without echo`() = runTest {
        val mangaId = insertManga(favorite = false)
        val categoryId = insertCategory("Remote", sort = 0)
        bindMangaIdentity(mangaId)
        val router = router(sequentialMutationIds())

        val remoteResult = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = setOf(categoryId),
                origin = EpigraphMutationOrigin.REMOTE_EPIGRAPH,
            ),
            createdAtEpochMillis = 100,
        )
        val refreshResult = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = false,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.SOURCE_REFRESH,
            ),
            createdAtEpochMillis = 101,
        )

        assertTrue(remoteResult.changed)
        assertEquals(0, remoteResult.emittedCommandCount)
        assertTrue(refreshResult.changed)
        assertEquals(0, refreshResult.emittedCommandCount)
        assertFalse(database.mangasQueries.findById(mangaId).executeAsOne().favorite)
        assertTrue(database.categoriesQueries.findAllByMangaId(mangaId).executeAsList().isEmpty())
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    @Test
    fun `first local novel favorite atomically provisions portable identity and publishes entry`() = runTest {
        // This mirrors the repair pass: Hayai already persisted the favorite, but the previous
        // build never created an Epigraph identity or outbox row.
        val mangaId = insertManga(favorite = true)
        val novel = PortableWorkRef.Novel(
            pluginId = "centralnovel",
            novelKey = ProviderOwnedKey("/novels/86-eighty-six"),
        )
        val router = router(sequentialMutationIds(), scope = "novels:profile:main")

        val result = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.LOCAL_USER,
                portableWorkRef = novel,
            ),
            createdAtEpochMillis = 100,
        )

        val portableId = PortableIdentityV3.workId(novel)
        assertTrue(result.changed)
        assertEquals(1, result.emittedCommandCount)
        assertEquals(
            portableId,
            database.aethon_syncQueries
                .selectIdentityByLocalReference("NOVEL", mangaId.toString())
                .executeAsOne()
                .entity_id,
        )
        val binding = SqlDelightPortableBindingStore(database).work(portableId)
        assertEquals(mangaId.toString(), binding?.localReference)
        assertEquals(PortableResolutionState.BOUND, binding?.resolution?.state)
        assertEquals(novel, binding?.ref)

        val command = coordinator.claimReady(100, 1_000, 10)
            .single()
            .let { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command }
        assertTrue(command is SyncCommand.SetNovelLibraryMembership)
        assertEquals(novel, (command as SyncCommand.SetNovelLibraryMembership).portableWorkRef)
        assertEquals(portableId, command.entityId.value)
    }

    @Test
    fun `novel library mutation publishes entry category and assignment in safe order`() = runTest {
        val mangaId = insertManga(favorite = false)
        val categoryId = insertCategory("Novels", sort = 2)
        bindNovelIdentity(mangaId)
        val router = router(sequentialMutationIds(), scope = "novels:profile:main")

        val added = router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = true,
                categoryIds = setOf(categoryId),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 100,
        )

        assertEquals(3, added.emittedCommandCount)
        val addRows = coordinator.claimReady(100, 1_000, 10)
        val addCommands = addRows
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command }
        assertTrue(addCommands[0] is SyncCommand.UpsertCategory)
        assertEquals(CategoryScope.NOVEL, (addCommands[0] as SyncCommand.UpsertCategory).scope)
        assertTrue(addCommands[1] is SyncCommand.SetNovelLibraryMembership)
        assertNotNull((addCommands[1] as SyncCommand.SetNovelLibraryMembership).entry)
        assertTrue(addCommands[2] is SyncCommand.SetCategoryAssignment)

        // The delete must remove assignments before deleting the Core entry; otherwise the Core
        // correctly rejects the mutation as a dangling-reference violation. Acknowledge the
        // first batch to keep the following claim focused on the removal commands.
        addRows.forEach {
            coordinator.acknowledge(
                EpigraphMutationAcknowledgement(
                    deviceId = DeviceId(it.device_id),
                    clientMutationId = ClientMutationId(it.client_mutation_id),
                    scopeId = SyncScopeId(it.scope_id),
                    entityType = it.entity_type,
                    entityId = epigraph.contract.EpigraphEntityId(it.entity_id),
                    canonicalEntityId = null,
                    resultStatus = "APPLIED",
                    requiredServerVersion = it.sequence,
                    appliedLamport = null,
                    eventClockJson = null,
                    canonicalRecordSha256 = null,
                    receivedAtEpochMillis = 101,
                ),
            )
        }

        router.setMembership(
            LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = false,
                categoryIds = emptySet(),
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = 200,
        )
        val deleteCommands = coordinator.claimReady(200, 1_000, 10)
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command }
        assertTrue(deleteCommands.first() is SyncCommand.SetCategoryAssignment)
        assertFalse((deleteCommands.first() as SyncCommand.SetCategoryAssignment).assigned)
        assertTrue(deleteCommands.last() is SyncCommand.SetNovelLibraryMembership)
        assertFalse((deleteCommands.last() as SyncCommand.SetNovelLibraryMembership).inLibrary)
    }

    private fun router(
        mutationIds: ClientMutationIdFactory,
        scope: String = "comics:profile:main",
    ) = EpigraphLibraryMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        scopeId = SyncScopeId(scope),
        mutationIds = mutationIds,
    )

    private fun sequentialMutationIds(): ClientMutationIdFactory {
        var sequence = 0
        return ClientMutationIdFactory { ClientMutationId("mutation-${++sequence}") }
    }

    private fun insertManga(favorite: Boolean): Long {
        database.mangasQueries.insert(
            source = 1,
            url = "/comic/1",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Example",
            status = 0,
            thumbnailUrl = null,
            favorite = favorite,
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

    private fun insertCategory(name: String, sort: Long): Long {
        database.categoriesQueries.insert(name, sort, flags = 0, mangaOrder = "")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun bindMangaIdentity(
        mangaId: Long,
        entityId: String = "comic:source:1",
    ) {
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
    }

    private fun bindNovelIdentity(mangaId: Long) {
        database.aethon_syncQueries.upsertIdentity(
            entityId = "novel:source:1",
            contentType = "NOVEL",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
    }

    private fun bindCategoryIdentity(
        categoryId: Long,
        entityId: String,
        name: String,
        sort: Long,
    ) {
        database.aethon_syncQueries.upsertCategoryIdentity(
            entityId = entityId,
            localCategoryId = categoryId,
            contentScope = "MANGA",
            name = name,
            sortOrder = sort,
            updatedAt = 1,
        )
    }
}
