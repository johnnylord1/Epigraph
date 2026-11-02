package epigraph.sync.core.suwayomi

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.replica.CoreConfirmedRecord
import epigraph.sync.core.replica.CoreReplicaKey
import epigraph.sync.core.replica.EpigraphCoreDomainProjection
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

class DisplacedComicRowRepairTest {
    private val driver = JdbcSqliteDriver(
        JdbcSqliteDriver.IN_MEMORY,
        java.util.Properties().apply { put("foreign_keys", "true") },
    ).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val queries = database.aethon_syncQueries

    private val ref = PortableWorkRef.Comic(DecimalSourceId(NATIVE_SOURCE.toString()), ProviderOwnedKey(PROVIDER_KEY))
    private val workId = PortableIdentityV3.workId(ref)
    private val bridgeUrl = SuwayomiCoreContentReference.forManga(SERVER_ID, PROFILE_ID, CORE_MANGA_ID)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `reading state, categories and trackers move to the row that stays`() {
        val displaced = displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        val bookmarked = insertChapter(displaced, "core/1", 1.0, bookmark = true, lastPageRead = 7)
        val read = insertChapter(displaced, "core/2", 2.0, read = true)
        insertChapter(displaced, "core/3", 3.0)
        val keptFirst = insertChapter(twin, "/ch/1", 1.0)
        val keptSecond = insertChapter(twin, "/ch/2", 2.0)
        database.historyQueries.upsert(read, 500, 40)
        val category = insertCategory()
        queries.insertMangaCategoryAssignment(displaced, category)
        insertTracker(displaced, syncId = 1)

        assertEquals(1, repair())

        val first = chapter(keptFirst)
        assertTrue(first.bookmark)
        assertEquals(7, first.last_page_read)
        assertTrue(chapter(keptSecond).read)
        val history = database.historyQueries.getByMangaId(twin).executeAsOne()
        assertEquals(keptSecond, history.history_chapter_id)
        assertEquals(500, history.history_last_read)
        assertEquals(40, history.history_time_read)
        assertNull(database.chaptersQueries.getChaptersById(bookmarked).executeAsOneOrNull())
        assertEquals(listOf(category), database.categoriesQueries.findAllByMangaId(twin).executeAsList().map { it._id })
        assertEquals(listOf(1L), database.manga_syncQueries.getAllByMangaId(twin).executeAsList().map { it.sync_id })
        assertTrue(database.manga_syncQueries.getAllByMangaId(displaced).executeAsList().isEmpty())
        assertEquals(listOf(twin), database.mangasQueries.findFavorites().executeAsList().map { it._id })
    }

    @Test
    fun `repair keeps the title's identities and the progress hanging from them`() {
        displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        queries.insertBinding("binding", CATALOG_ID, "SUWAYOMI", "repo", "pkg", "42", PROVIDER_KEY, true, 1)
        queries.upsertLocalReaderProgress(workId, null, "{}", 3.0, 0.5, 2)

        repair()

        assertEquals(1, queries.selectBindingsByEntityId(CATALOG_ID).executeAsList().size)
        assertEquals(twin.toString(), queries.selectIdentityByEntityId(CATALOG_ID).executeAsOne().local_reference)
        assertEquals(workId, queries.selectIdentityByEntityId(workId).executeAsOne().local_reference)
        assertEquals(CATALOG_ID, queries.selectCanonicalEntityId(workId).executeAsOne())
        assertEquals(0.5, queries.selectReaderProgress(workId).executeAsOne().progression)
    }

    @Test
    fun `chapters with reading state wait on the twin for the source's list`() {
        val displaced = displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        val read = insertChapter(displaced, "core/1", 1.0, read = true)
        val unread = insertChapter(displaced, "core/2", 2.0)
        bindPortableChapter("chapter:read", read)
        bindPortableChapter("chapter:unread", unread)

        repair()

        assertEquals(twin, chapter(read).manga_id)
        assertEquals(displaced, chapter(unread).manga_id)
        listOf("chapter:read", "chapter:unread").forEach { id ->
            val binding = portableChapter(id)
            assertEquals(PortableResolutionState.PENDING_PROVIDER.name, binding.resolution_state)
            assertEquals(PortableResolutionReason.CHAPTER_NOT_FOUND.name, binding.resolution_reason)
        }
    }

    @Test
    fun `a portable chapter follows the chapter that stands for its own`() {
        val displaced = displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        val source = insertChapter(displaced, "core/1", 1.0)
        val kept = insertChapter(twin, "/ch/1", 1.0)
        bindPortableChapter("chapter:one", source)

        repair()

        val binding = portableChapter("chapter:one")
        assertEquals(PortableResolutionState.BOUND.name, binding.resolution_state)
        assertEquals(kept.toString(), binding.local_reference)
    }

    @Test
    fun `a work bound to the displaced row moves so hydration cannot bring it back`() {
        val displaced = displacedRow()
        val twin = insertManga(NATIVE_SOURCE, PROVIDER_KEY)
        bindWork(displaced)

        assertEquals(1, repair())

        assertEquals(twin.toString(), queries.selectPortableWorkBinding(workId).executeAsOne().local_reference)
        assertEquals(twin.toString(), queries.selectIdentityByEntityId(workId).executeAsOne().local_reference)
        assertFalse(database.mangasQueries.findById(displaced).executeAsOne().favorite)
    }

    @Test
    fun `the library keeps the title when only the displaced row was in it`() {
        val displaced = displacedRow()
        val twin = catalogTwin(favorite = false)
        bindWork(twin)

        repair()

        assertEquals(listOf(twin), database.mangasQueries.findFavorites().executeAsList().map { it._id })
        assertFalse(database.mangasQueries.findById(displaced).executeAsOne().favorite)
    }

    @Test
    fun `a row with no twin goes back to the catalog`() {
        val displaced = displacedRow()

        assertEquals(1, repair())

        val row = database.mangasQueries.findById(displaced).executeAsOne()
        assertEquals(EpigraphCoreSource.ID, row.source)
        assertEquals(bridgeUrl, row.url)
        assertTrue(row.favorite)
        assertEquals(displaced.toString(), queries.selectIdentityByEntityId(CATALOG_ID).executeAsOne().local_reference)
        assertEquals(CATALOG_ID, queries.selectCanonicalEntityId(workId).executeAsOne())
    }

    @Test
    fun `a row whose url became the work id gets its source back`() {
        val row = insertManga(MADE_UP_SOURCE, workId)
        identity(workId, row)
        bindWork(row)

        assertEquals(1, repair())

        val restored = database.mangasQueries.findById(row).executeAsOne()
        assertEquals(NATIVE_SOURCE, restored.source)
        assertEquals(PROVIDER_KEY, restored.url)
        assertTrue(restored.favorite)
    }

    @Test
    fun `healthy rows are left alone`() {
        val native = insertManga(NATIVE_SOURCE, PROVIDER_KEY)
        identity(workId, native)
        bindWork(native)
        val bridge = insertManga(EpigraphCoreSource.ID, bridgeUrl)
        identity("comic:other", bridge)

        assertEquals(0, repair())

        assertEquals(setOf(native, bridge), database.mangasQueries.findFavorites().executeAsList().map { it._id }.toSet())
    }

    @Test
    fun `a second pass finds nothing left`() {
        val displaced = displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        insertChapter(displaced, "core/1", 1.0, read = true)

        assertEquals(1, repair())
        assertEquals(0, repair())

        assertEquals(1, database.chaptersQueries.getChaptersByMangaId(twin, 0).executeAsList().size)
    }

    @Test
    fun `the work's entry reaches the row that stayed after the repair`() = runTest {
        val displaced = displacedRow()
        val twin = catalogTwin()
        bindWork(twin)
        repair()

        repeat(2) { EpigraphCoreDomainProjection().upsert(database, portableEntry()) }

        assertEquals(listOf(twin), database.mangasQueries.findFavorites().executeAsList().map { it._id })
        val row = database.mangasQueries.findById(twin).executeAsOne()
        assertEquals(NATIVE_SOURCE, row.source)
        assertEquals(PROVIDER_KEY, row.url)
        assertFalse(database.mangasQueries.findById(displaced).executeAsOne().favorite)
        assertEquals(0, repair())
    }

    private fun repair(): Int {
        val rows = queries.selectDisplacedComicRows(EpigraphCoreSource.ID).executeAsList()
        return repairDisplacedComicRows(database, rows, rows.mapTo(HashSet()) { it.manga_id }, 1_000)
    }

    /** The row as the old projection left it: on a made-up source, and held by the work's identity. */
    private fun displacedRow(): Long = insertManga(MADE_UP_SOURCE, bridgeUrl).also { identity(workId, it) }

    private fun catalogTwin(favorite: Boolean = true): Long =
        insertManga(NATIVE_SOURCE, PROVIDER_KEY, favorite).also { identity(CATALOG_ID, it) }

    private fun identity(entityId: String, mangaId: Long) {
        queries.upsertIdentity(entityId, "MANGA", mangaId.toString(), 1, 1)
    }

    private fun bindWork(mangaId: Long) {
        queries.upsertPortableWorkBinding(
            portableId = workId,
            ecosystem = "SUWAYOMI",
            sourceId = NATIVE_SOURCE.toString(),
            pluginId = null,
            providerKey = PROVIDER_KEY,
            dependencyKey = null,
            localReference = mangaId.toString(),
            resolutionState = PortableResolutionState.BOUND.name,
            resolutionReason = null,
            titleHint = null,
            providerLabelHint = null,
            attemptCount = 0,
            updatedAt = 1,
        )
    }

    private fun bindPortableChapter(portableChapterId: String, chapterId: Long) {
        queries.upsertPortableChapterBinding(
            portableChapterId = portableChapterId,
            portableWorkId = workId,
            providerKey = portableChapterId,
            localReference = chapterId.toString(),
            resolutionState = PortableResolutionState.BOUND.name,
            resolutionReason = null,
            attemptCount = 0,
            updatedAt = 1,
        )
    }

    private fun portableChapter(portableChapterId: String) =
        queries.selectPortableChaptersForWork(workId).executeAsList()
            .single { it.portable_chapter_id == portableChapterId }

    private fun chapter(chapterId: Long) = database.chaptersQueries.getChaptersById(chapterId).executeAsOne()

    private fun portableEntry(): CoreConfirmedRecord = CoreConfirmedRecord(
        key = CoreReplicaKey("comics:profile:main", "comic.entry", workId),
        serverVersion = 2,
        lamport = 2,
        record = buildJsonObject {
            put("comicId", workId)
            put("portableWorkRef", Json.encodeToJsonElement(ref))
            put("inLibrary", true)
        },
    )

    private fun insertManga(source: Long, url: String, favorite: Boolean = true): Long {
        database.mangasQueries.insert(
            source = source,
            url = url,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Title",
            status = 0,
            thumbnailUrl = null,
            favorite = favorite,
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

    private fun insertChapter(
        mangaId: Long,
        url: String,
        number: Double,
        read: Boolean = false,
        bookmark: Boolean = false,
        lastPageRead: Long = 0,
    ): Long {
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = url,
            name = url,
            scanlator = null,
            read = read,
            bookmark = bookmark,
            lastPageRead = lastPageRead,
            pagesLeft = 0,
            chapterNumber = number,
            sourceOrder = 0,
            dateFetch = 0,
            dateUpload = 0,
            memo = JsonObject(emptyMap()),
        )
        return database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun insertCategory(): Long {
        database.categoriesQueries.insert("Category", 0, 0, "")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun insertTracker(mangaId: Long, syncId: Long) {
        database.manga_syncQueries.insert(mangaId, syncId, 1, null, "Title", 0.0, 0, 0, 0.0, "url", 0, 0)
    }

    private companion object {
        const val SERVER_ID = "server-a"
        const val PROFILE_ID = "main"
        const val CORE_MANGA_ID = 7L
        const val NATIVE_SOURCE = 42L
        const val MADE_UP_SOURCE = 999L
        const val PROVIDER_KEY = "/title/1"
        const val CATALOG_ID = "suwayomi:server:$SERVER_ID:profile:$PROFILE_ID:manga:$CORE_MANGA_ID"
    }
}
