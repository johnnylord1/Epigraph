package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.CategoryScope
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
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphCategoryMutationRouterTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
        // Production enables FK cascades (AppModule); category deletes rely on them.
        it.execute(null, "PRAGMA foreign_keys = ON", 0)
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
    fun `novel rename is published with the local write and only for touched categories`() = runTest {
        val renamed = insertCategory("Old", sort = 3)
        val untouched = insertCategory("Other", sort = 4)
        bindCategory(renamed, "novel-category-local-$renamed", "NOVEL", "Old", 0)
        bindCategory(untouched, "novel-category-local-$untouched", "NOVEL", "Stale", 9)

        val result = router().updateCategories(setOf(renamed)) {
            categoriesQueries.update(id = renamed, name = "New", mangaOrder = null, sort = null, flags = null)
        }

        assertEquals(1, result.emittedCommandCount)
        val envelope = queued().single()
        assertEquals("novels:profile:main", envelope.scopeId.value)
        assertEquals("novel.category", envelope.entityType.value)
        val command = envelope.command as SyncCommand.UpsertCategory
        assertEquals("novel-category-local-$renamed", command.entityId.value)
        assertEquals("New", command.name)
        assertEquals(CategoryScope.NOVEL, command.scope)
        // The wire position is the rank in local order, never the raw (possibly negative) sort.
        assertEquals(0, command.position)
        assertEquals("New", identity(renamed).name)

        // Unchanged name/order (e.g. a flags-only save) does not publish anything.
        val again = router().updateCategories(setOf(renamed)) {
            categoriesQueries.update(id = renamed, name = null, mangaOrder = null, sort = null, flags = 7)
        }
        assertEquals(0, again.emittedCommandCount)
    }

    @Test
    fun `comic reorder publishes one-based ranks per Suwayomi profile`() = runTest {
        val a = insertCategory("A", sort = 0)
        val b = insertCategory("B", sort = 1)
        val local = insertCategory("Local", sort = 2)
        val c = insertCategory("C", sort = 3)
        val other = insertCategory("Other profile", sort = 4)
        bindCategory(a, "suwayomi:profile:main:category:11", "MANGA", "A", 1)
        bindCategory(b, "suwayomi:profile:main:category:12", "MANGA", "B", 2)
        bindCategory(local, "comic-category-local", "MANGA", "Local", 2)
        bindCategory(c, "suwayomi:profile:main:category:13", "MANGA", "C", 3)
        bindCategory(other, "suwayomi:profile:secondary:category:21", "MANGA", "Other profile", 1)
        val all = setOf(a, b, local, c, other)

        // Move C to the top: C, A, B, Local, Other.
        router().updateCategories(all) {
            categoriesQueries.update(id = c, name = null, mangaOrder = null, sort = 0, flags = null)
            categoriesQueries.update(id = a, name = null, mangaOrder = null, sort = 1, flags = null)
            categoriesQueries.update(id = b, name = null, mangaOrder = null, sort = 2, flags = null)
            categoriesQueries.update(id = local, name = null, mangaOrder = null, sort = 3, flags = null)
        }

        val published = queued().associate { envelope ->
            val command = envelope.command as SyncCommand.UpsertCategory
            assertEquals(CategoryScope.MANGA, command.scope)
            assertEquals("comic.category", envelope.entityType.value)
            assertEquals("comics:profile:main", envelope.scopeId.value)
            command.entityId.value to command.position
        }
        // Suwayomi rejects position 0; "Other profile" keeps rank 1 in its own profile.
        assertEquals(
            mapOf(
                "suwayomi:profile:main:category:13" to 1L,
                "suwayomi:profile:main:category:11" to 2L,
                "suwayomi:profile:main:category:12" to 3L,
            ),
            published,
        )
        assertEquals(1, identity(c).sort_order)
    }

    @Test
    fun `comic names over the Suwayomi byte limit stay local`() = runTest {
        val category = insertCategory("A", sort = 0)
        bindCategory(category, "suwayomi:profile:main:category:11", "MANGA", "A", 1)
        val tooLong = "é".repeat(129) // 258 UTF-8 bytes, 129 characters

        val result = router().updateCategories(setOf(category)) {
            categoriesQueries.update(id = category, name = tooLong, mangaOrder = null, sort = null, flags = null)
        }

        assertEquals(0, result.emittedCommandCount)
        assertEquals(tooLong, database.categoriesQueries.findAll().executeAsList().single().name)
        assertEquals("A", identity(category).name)
    }

    @Test
    fun `novel delete tombstones assignments before deleting the category`() = runTest {
        val category = insertCategory("Novels", sort = 0)
        bindCategory(category, "novel-category-local-$category", "NOVEL", "Novels", 0)
        val novel = insertManga()
        bindWork(novel, "novel:source:1", "NOVEL")
        database.aethon_syncQueries.insertMangaCategoryAssignment(novel, category)

        val result = router().deleteCategory(category) { categoriesQueries.delete(category) }

        assertEquals(2, result.emittedCommandCount)
        val envelopes = queued()
        val tombstone = envelopes[0].command as SyncCommand.SetCategoryAssignment
        assertEquals("novel.category_assignment", envelopes[0].entityType.value)
        assertEquals("novel:source:1", tombstone.entityId.value)
        assertEquals("novel-category-local-$category", tombstone.categoryId.value)
        assertFalse(tombstone.assigned)
        assertEquals("novel.category", envelopes[1].entityType.value)
        assertTrue(envelopes[1].command is SyncCommand.DeleteEntity)
        assertTrue(database.categoriesQueries.findAll().executeAsList().isEmpty())
        assertNull(database.aethon_syncQueries.selectCategoryIdentityByLocalId(category).executeAsOneOrNull())
    }

    @Test
    fun `comic delete tombstones only portable assignments and uses the category profile scope`() = runTest {
        val category = insertCategory("Comics", sort = 0)
        bindCategory(category, "suwayomi:profile:secondary:category:21", "MANGA", "Comics", 1)
        val legacy = insertManga()
        bindWork(legacy, "suwayomi:profile:secondary:manga:7", "MANGA")
        val portable = insertManga()
        bindWork(portable, "suwayomi:profile:secondary:manga:8", "MANGA")
        val work = PortableWorkRef.Comic(DecimalSourceId("10002"), ProviderOwnedKey("/manga/8"))
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(work),
                ref = work,
                localReference = portable.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Example",
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        database.aethon_syncQueries.insertMangaCategoryAssignment(legacy, category)
        database.aethon_syncQueries.insertMangaCategoryAssignment(portable, category)

        router().deleteCategory(category) { categoriesQueries.delete(category) }

        val envelopes = queued()
        assertEquals(2, envelopes.size)
        assertTrue(envelopes.all { it.scopeId.value == "comics:profile:secondary" })
        val tombstone = envelopes[0].command as SyncCommand.SetCategoryAssignment
        assertEquals("comic.category_assignment", envelopes[0].entityType.value)
        assertEquals(PortableIdentityV3.workId(work), tombstone.entityId.value)
        assertEquals(work, tombstone.portableWorkRef)
        assertFalse(tombstone.assigned)
        assertEquals("comic.category", envelopes[1].entityType.value)
        assertEquals(
            "suwayomi:profile:secondary:category:21",
            (envelopes[1].command as SyncCommand.DeleteEntity).entityId.value,
        )
    }

    @Test
    fun `book delete republishes remaining assignment sets first`() = runTest {
        val deleted = insertCategory("Read later", sort = 0)
        val kept = insertCategory("Favorites", sort = 1)
        bindCategory(deleted, "book-category-local-$deleted", "BOOK", "Read later", 0)
        bindCategory(kept, "book-category-local-$kept", "BOOK", "Favorites", 1)
        insertBook("book-1")
        database.local_booksQueries.insertCategory("book-1", deleted)
        database.local_booksQueries.insertCategory("book-1", kept)

        router().deleteCategory(deleted) { categoriesQueries.delete(deleted) }

        val envelopes = queued()
        assertEquals(listOf("book.category_assignment", "book.category"), envelopes.map { it.entityType.value })
        assertTrue(envelopes.all { it.scopeId.value == "books:global" })
        val assignments = envelopes[0].command as SyncCommand.SetBookCategoryAssignments
        assertEquals(listOf("book-category-local-$kept"), assignments.categoryIds.map { it.value })
        assertEquals("book-category-local-$deleted", envelopes[1].command.entityId.value)
    }

    @Test
    fun `unsynchronized categories and unpaired devices stay local`() = runTest {
        val plain = insertCategory("Plain", sort = 0)
        val novel = insertCategory("Novel", sort = 1)
        bindCategory(novel, "novel-category-local-$novel", "NOVEL", "Novel", 1)

        router().updateCategories(setOf(plain)) {
            categoriesQueries.update(id = plain, name = "Renamed", mangaOrder = null, sort = null, flags = null)
        }
        val unpaired = router(EpigraphSyncScopeProvider { error("not paired") })
        unpaired.updateCategories(setOf(novel)) {
            categoriesQueries.update(id = novel, name = "Offline", mangaOrder = null, sort = null, flags = null)
        }
        unpaired.deleteCategory(plain) { categoriesQueries.delete(plain) }

        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
        assertEquals(listOf("Offline"), database.categoriesQueries.findAll().executeAsList().map { it.name })
    }

    @Test
    fun `duplicate idempotency key rolls the local rename back`() = runTest {
        val a = insertCategory("A", sort = 0)
        val b = insertCategory("B", sort = 1)
        bindCategory(a, "novel-category-local-$a", "NOVEL", "A", 0)
        bindCategory(b, "novel-category-local-$b", "NOVEL", "B", 1)
        val duplicate = router(mutationIds = ClientMutationIdFactory { ClientMutationId("duplicate") })

        val failure = runCatching {
            duplicate.updateCategories(setOf(a, b)) {
                categoriesQueries.update(id = a, name = "A2", mangaOrder = null, sort = null, flags = null)
                categoriesQueries.update(id = b, name = "B2", mangaOrder = null, sort = null, flags = null)
            }
        }.exceptionOrNull()

        assertNotNull(failure)
        assertEquals(listOf("A", "B"), database.categoriesQueries.findAll().executeAsList().map { it.name })
        assertEquals("A", identity(a).name)
        assertEquals(0, database.aethon_syncQueries.pendingMutationCount().executeAsOne())
    }

    private fun router(
        scopes: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(SyncScopeId("novels:profile:main"), SyncScopeId("comics:profile:main"))
        },
        mutationIds: ClientMutationIdFactory = sequentialMutationIds(),
    ) = EpigraphCategoryMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        mutationIds = mutationIds,
        scopeProvider = scopes,
        clock = { 100 },
    )

    private var sequence = 0

    private fun sequentialMutationIds() = ClientMutationIdFactory { ClientMutationId("mutation-${++sequence}") }

    private suspend fun queued(): List<SyncCommandEnvelope> =
        coordinator.claimReady(100, leaseDurationMillis = 1_000, limit = 50)
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json) }

    private fun identity(categoryId: Long) =
        database.aethon_syncQueries.selectCategoryIdentityByLocalId(categoryId).executeAsOne()

    private fun insertCategory(name: String, sort: Long): Long {
        database.categoriesQueries.insert(name, sort, flags = 0, mangaOrder = "")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun bindCategory(categoryId: Long, entityId: String, scope: String, name: String, sort: Long) {
        database.aethon_syncQueries.upsertCategoryScope(categoryId, scope)
        database.aethon_syncQueries.upsertCategoryIdentity(
            entityId = entityId,
            localCategoryId = categoryId,
            contentScope = scope,
            name = name,
            sortOrder = sort,
            updatedAt = 1,
        )
    }

    private fun bindWork(mangaId: Long, entityId: String, contentType: String) {
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = contentType,
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
    }

    private var mangaCount = 0

    private fun insertManga(): Long {
        mangaCount++
        database.mangasQueries.insert(
            source = 1,
            url = "/work/$mangaCount",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Example $mangaCount",
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

    private fun insertBook(bookId: String) {
        database.local_booksQueries.insert(
            bookId = bookId,
            contentType = "EPUB",
            sha256 = "b".repeat(64),
            displayName = "Book",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "/books/$bookId.epub",
            mimeType = "application/epub+zip",
            byteSize = 1,
            chapterCount = null,
            pageCount = null,
            importedAt = 1,
            updatedAt = 1,
        )
    }
}
