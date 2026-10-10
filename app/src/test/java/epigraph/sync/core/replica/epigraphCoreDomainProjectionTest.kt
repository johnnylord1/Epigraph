package epigraph.sync.core.replica
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import epigraph.novel.source.NovelSource
import kotlinx.serialization.json.JsonObject
import epigraph.contract.ReaderLocator
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.PortableChapterBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import yokai.data.Database
import yokai.data.AndroidDatabaseHandler

class EpigraphCoreDomainProjectionTest {
    @TempDir
    lateinit var tempDirectory: File

    // The app opens its database with foreign keys enforced; projection tests must too.
    private val driver = JdbcSqliteDriver(
        JdbcSqliteDriver.IN_MEMORY,
        java.util.Properties().apply { put("foreign_keys", "true") },
    ).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val projection = EpigraphCoreDomainProjection()

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `snapshot projection stores novel progress under canonical novel id`() = runTest {
        projection.replaceScope(
            database = database,
            scopeId = SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = listOf(progressRecord()),
            tombstones = emptyList(),
        )

        val canonical = database.aethon_syncQueries
            .selectReaderProgress(CANONICAL_NOVEL_ID)
            .executeAsOneOrNull()
        val technical = database.aethon_syncQueries
            .selectReaderProgress(TECHNICAL_PROGRESS_ID)
            .executeAsOneOrNull()

        assertNotNull(canonical)
        assertEquals(0.5, canonical!!.progression)
        assertNull(technical)
    }

    @Test
    fun `novel progress tombstone removes canonical local progress`() = runTest {
        projection.upsert(database, progressRecord())
        projection.replaceScope(
            database = database,
            scopeId = SCOPE_ID,
            previousRecords = listOf(progressRecord()),
            previousTombstones = emptyList(),
            records = emptyList(),
            tombstones = listOf(progressTombstone()),
        )

        assertNull(
            database.aethon_syncQueries
                .selectReaderProgress(CANONICAL_NOVEL_ID)
                .executeAsOneOrNull(),
        )
    }

    @Test
    fun `novel chapter and bookmark are authoritative while progress never infers read`() = runTest {
        val entry = novelEntryRecord()
        val unreadChapter = novelChapterRecord(unread = true)
        val nearlyCompleteProgress = progressRecord(progression = 0.99, locator = "block:8:44")
        projection.replaceScope(
            database = database,
            scopeId = SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = listOf(entry, unreadChapter, nearlyCompleteProgress),
            tombstones = emptyList(),
        )

        val binding = database.aethon_syncQueries.selectChapterBindingByEntityId("chapter-1").executeAsOne()
        assertFalse(database.chaptersQueries.getChaptersById(binding.local_chapter_id).executeAsOne().read)
        val stored = database.aethon_syncQueries.selectReaderProgress(CANONICAL_NOVEL_ID).executeAsOne()
        val locator = Json.decodeFromString<ReaderLocator>(stored.locator_json) as ReaderLocator.Novel
        assertEquals(8, locator.blockIndex)
        assertEquals(44, locator.textOffset)

        projection.upsert(database, novelChapterRecord(unread = false, serverVersion = 4))
        assertTrue(database.chaptersQueries.getChaptersById(binding.local_chapter_id).executeAsOne().read)

        val bookmark = novelBookmarkRecord()
        projection.upsert(database, bookmark)
        assertTrue(database.chaptersQueries.getChaptersById(binding.local_chapter_id).executeAsOne().bookmark)
        projection.delete(
            database,
            CoreConfirmedTombstone(
                key = bookmark.key,
                serverVersion = 6,
                lamport = 6,
                deletedAtMs = 600,
                reasonCode = "unbookmarked",
            ),
            bookmark,
        )
        assertFalse(database.chaptersQueries.getChaptersById(binding.local_chapter_id).executeAsOne().bookmark)
    }

    @Test
    fun `comic snapshot projects library category chapter and reader progress`() = runTest {
        val records = listOf(
            comicEntryRecord(),
            comicCategoryRecord(),
            comicChapterStateRecord(),
            comicAssignmentRecord(),
            comicHistoryRecord(),
        )

        projection.replaceScope(
            database = database,
            scopeId = COMIC_SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = records,
            tombstones = emptyList(),
        )

        val manga = database.mangasQueries.findFavorites().executeAsList().single()
        assertEquals(COMIC_TITLE, manga.title)
        assertEquals(42L, manga.source)

        val category = database.categoriesQueries.findAllByMangaId(manga._id).executeAsList().single()
        assertEquals(CATEGORY_NAME, category.name)

        val binding = database.aethon_syncQueries
            .selectChapterBindingByEntityId(CHAPTER_ID)
            .executeAsOneOrNull()
        assertNotNull(binding)
        val chapter = database.chaptersQueries
            .getChaptersById(binding!!.local_chapter_id)
            .executeAsOne()
        assertEquals(4L, chapter.last_page_read)
        assertEquals(6L, chapter.pages_left)
        assertFalse(chapter.read)

        val progress = database.aethon_syncQueries
            .selectReaderProgress(COMIC_ID)
            .executeAsOneOrNull()
        assertNotNull(progress)
        assertEquals(0.5, progress!!.progression)
        assertEquals(CHAPTER_ID, progress.chapter_entity_id)

        // Reapplying the same authoritative snapshot is the normal recovery path after a retry.
        projection.replaceScope(
            database = database,
            scopeId = COMIC_SCOPE_ID,
            previousRecords = records,
            previousTombstones = emptyList(),
            records = records,
            tombstones = emptyList(),
        )
        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
        assertEquals(1, database.chaptersQueries.getChaptersByMangaId(manga._id, 0L).executeAsList().size)
    }

    @Test
    fun `state-only server chapter record never creates a synthetic catalog chapter`() = runTest {
        projection.upsert(database, comicEntryRecord())
        val serverChapterId = "suwayomi:server:desktop:profile:main:chapter:508"

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(
                    COMIC_SCOPE_ID,
                    "comic.chapter_state",
                    "comic.chapter_state::$COMIC_ID::$serverChapterId",
                ),
                serverVersion = 4,
                lamport = 4,
                record = buildJsonObject {
                    put("comicId", COMIC_ID)
                    put("chapterId", serverChapterId)
                    put("bookmarked", true)
                    put("updatedAtMs", 400)
                },
            ),
        )

        val mangaId = database.mangasQueries.findFavorites().executeAsOne()._id
        assertTrue(database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList().isEmpty())
        assertNull(database.aethon_syncQueries.selectChapterBindingByEntityId(serverChapterId).executeAsOneOrNull())
        assertNotNull(database.aethon_syncQueries.selectReaderProgress(COMIC_ID).executeAsOneOrNull())
    }

    @Test
    fun `portable chapter state removes only the matching legacy synthetic chapter`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/manga/exact"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/manga/exact/chapter-1"))
        val workId = PortableIdentityV3.workId(work)
        val chapterId = PortableIdentityV3.chapterId(chapter)
        database.mangasQueries.insert(
            source = 42,
            url = "/manga/exact",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Exact",
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
        val mangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = "/manga/exact/chapter-1",
            name = "Chapter 1",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 10,
            chapterNumber = 1.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        val realChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        val portableStore = SqlDelightPortableBindingStore(database)
        portableStore.upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Exact",
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        portableStore.upsertChapter(
            PortableChapterBindingRecord(
                portableChapterId = chapterId,
                portableWorkId = workId,
                ref = chapter,
                localReference = realChapterId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        val legacyEntityId = "suwayomi:server:desktop:profile:main:chapter:508"
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = legacyEntityId,
            name = legacyEntityId,
            scanlator = null,
            read = false,
            bookmark = true,
            lastPageRead = 0,
            pagesLeft = 0,
            chapterNumber = 0.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 0,
            memo = JsonObject(emptyMap()),
        )
        val syntheticChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:server:desktop:profile:main:manga:3",
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = legacyEntityId,
            workEntityId = "suwayomi:server:desktop:profile:main:manga:3",
            localChapterId = syntheticChapterId,
            normalizedUrl = legacyEntityId,
            ordinal = 0.0,
            updatedAt = 1,
        )

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.chapter_state", "comic.chapter_state::$workId::$chapterId"),
                serverVersion = 5,
                lamport = 5,
                record = buildJsonObject {
                    put("comicId", workId)
                    put("chapterId", chapterId)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                    put("portableChapterRef", Json.encodeToJsonElement(chapter))
                    put("coreServerId", "desktop")
                    put("coreProfileId", "main")
                    put("suwayomiMangaId", 3)
                    put("suwayomiChapterId", 508)
                    put("bookmarked", true)
                    put("updatedAtMs", 500)
                },
            ),
        )

        val chapters = database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList()
        assertEquals(1, chapters.size)
        assertEquals(realChapterId, chapters.single()._id)
        assertTrue(chapters.single().bookmark)
        assertNull(database.aethon_syncQueries.selectChapterBindingByEntityId(legacyEntityId).executeAsOneOrNull())
    }

    @Test
    fun `portable chapter state reaches the Core-backed chapter of a title read through the Core catalog`() = runTest {
        // The device has no extension for the title: it reads it through the Core catalog, so the
        // portable chapter stays pending while the chapter exists under its server-local ids.
        val mangaId = insertTrackingManga(EpigraphCoreSource.ID, "aethon-core://suwayomi/desktop/main/manga/2")
        val coreChapterUrl = "aethon-core://suwayomi/desktop/main/chapter/211"
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = coreChapterUrl,
            name = "Chapter 17",
            scanlator = null,
            read = true,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 0,
            chapterNumber = 17.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 0,
            memo = JsonObject(emptyMap()),
        )
        val localChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:server:desktop:profile:main:manga:2",
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = "suwayomi:server:desktop:profile:main:chapter:211",
            workEntityId = "suwayomi:server:desktop:profile:main:manga:2",
            localChapterId = localChapterId,
            normalizedUrl = coreChapterUrl,
            ordinal = 17.0,
            updatedAt = 1,
        )
        val work = PortableWorkRef.Comic(DecimalSourceId("8531542650987673943"), ProviderOwnedKey("/series/165"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/series/165/a7b251fee96b1f4e"))
        val workId = PortableIdentityV3.workId(work)
        val chapterId = PortableIdentityV3.chapterId(chapter)
        fun desktopState(suwayomiChapterId: Long) = CoreConfirmedRecord(
            key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.chapter_state", "comic.chapter_state::$workId::$chapterId"),
            serverVersion = 10,
            lamport = 10,
            originServerId = ORIGIN_SERVER_ID,
            record = buildJsonObject {
                put("comicId", workId)
                put("chapterId", chapterId)
                put("portableWorkRef", Json.encodeToJsonElement(work))
                put("portableChapterRef", Json.encodeToJsonElement(chapter))
                put("coreServerId", "desktop")
                put("coreProfileId", "main")
                put("suwayomiMangaId", 2)
                put("suwayomiChapterId", suwayomiChapterId)
                put("read", false)
                put("bookmarked", true)
                put("updatedAtMs", 1_000)
            },
        )
        fun local() = database.chaptersQueries.getChaptersById(localChapterId).executeAsOne()

        // A record naming another server-local chapter leaves this one alone.
        projection.upsert(database, desktopState(suwayomiChapterId = 212))
        assertTrue(local().read)

        projection.upsert(database, desktopState(suwayomiChapterId = 211))
        assertFalse(local().read)
        assertTrue(local().bookmark)
        assertEquals(
            PortableResolutionState.PENDING_PROVIDER.name,
            database.aethon_syncQueries.selectPortableChapterBinding(chapterId).executeAsOne().resolution_state,
        )
    }

    @Test
    fun `legacy chapter state with null portable refs reaches its bound chapter`() = runTest {
        // Desktop mirrors serialized an absent portable identity as explicit nulls.
        val mangaId = insertTrackingManga(EpigraphCoreSource.ID, "aethon-core://suwayomi/desktop/main/manga/2")
        val coreChapterUrl = "aethon-core://suwayomi/desktop/main/chapter/211"
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = coreChapterUrl,
            name = "Chapter 17",
            scanlator = null,
            read = true,
            bookmark = false,
            lastPageRead = 9,
            pagesLeft = 0,
            chapterNumber = 17.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 0,
            memo = JsonObject(emptyMap()),
        )
        val localChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        val comicId = "suwayomi:server:desktop:profile:main:manga:2"
        val chapterEntityId = "suwayomi:server:desktop:profile:main:chapter:211"
        database.aethon_syncQueries.upsertIdentity(
            entityId = comicId,
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = chapterEntityId,
            workEntityId = comicId,
            localChapterId = localChapterId,
            normalizedUrl = coreChapterUrl,
            ordinal = 17.0,
            updatedAt = 1,
        )

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.chapter_state", "comic.chapter_state::$comicId::$chapterEntityId"),
                serverVersion = 10,
                lamport = 10,
                originServerId = ORIGIN_SERVER_ID,
                record = buildJsonObject {
                    put("comicId", comicId)
                    put("chapterId", chapterEntityId)
                    put("portableWorkRef", JsonNull)
                    put("portableChapterRef", JsonNull)
                    put("coreServerId", "desktop")
                    put("coreProfileId", "main")
                    put("suwayomiMangaId", 2)
                    put("suwayomiChapterId", 211)
                    put("read", false)
                    put("bookmarked", true)
                    put("updatedAtMs", 1_000)
                },
            ),
        )

        val local = database.chaptersQueries.getChaptersById(localChapterId).executeAsOne()
        assertFalse(local.read)
        assertTrue(local.bookmark)
        // The mirror publishes page zero as an absent page; unread then resets local progress.
        assertEquals(0L, local.last_page_read)
    }

    @Test
    fun `comic history on the last page marks the chapter read and later history keeps it read`() = runTest {
        projection.upsert(database, comicEntryRecord())
        projection.upsert(database, comicChapterStateRecord())
        val localChapterId = database.aethon_syncQueries
            .selectChapterBindingByEntityId(CHAPTER_ID)
            .executeAsOne()
            .local_chapter_id
        fun chapter() = database.chaptersQueries.getChaptersById(localChapterId).executeAsOne()

        // Page indexes count from zero, so index 9 of 10 pages is the last page at 90 percent.
        projection.upsert(database, comicHistoryRecord(pageIndex = 9, progressPercent = 0.9))
        assertTrue(chapter().read)

        projection.upsert(database, comicHistoryRecord(pageIndex = 2, progressPercent = 0.2, serverVersion = 4))
        assertTrue(chapter().read)
        assertEquals(2L, chapter().last_page_read)
    }

    @Test
    fun `comic history records the last read time without moving a newer local read back`() = runTest {
        projection.upsert(database, comicEntryRecord())
        projection.upsert(database, comicChapterStateRecord())
        val localChapterId = database.aethon_syncQueries
            .selectChapterBindingByEntityId(CHAPTER_ID)
            .executeAsOne()
            .local_chapter_id
        fun lastRead() = database.historyQueries.getByChapterUrl(
            database.chaptersQueries.getChaptersById(localChapterId).executeAsOne().url,
        ).executeAsOneOrNull()?.history_last_read

        projection.upsert(database, comicHistoryRecord(serverVersion = 3))
        assertEquals(300L, lastRead())

        database.historyQueries.upsert(localChapterId, 1_000L, 0L)
        projection.upsert(database, comicHistoryRecord(serverVersion = 4))
        assertEquals(1_000L, lastRead())
    }

    @Test
    fun `novel history records the last read time of its local chapter without marking it read`() = runTest {
        val work = PortableWorkRef.Novel("mahoureader", ProviderOwnedKey("/series/352/barbaro"))
        val workId = PortableIdentityV3.workId(work)
        database.mangasQueries.insert(
            source = 7,
            url = "/series/352/barbaro",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Barbaro",
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
        val mangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = "/series/352/ler/207118",
            name = "Chapter 278",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 100,
            chapterNumber = 278.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        val chapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Barbaro",
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        fun history(chapterKey: String, novelId: String = workId) = CoreConfirmedRecord(
            key = CoreReplicaKey(SCOPE_ID, "novel.history", "novel.history::barbaro"),
            serverVersion = 5,
            lamport = 5,
            originServerId = ORIGIN_SERVER_ID,
            record = buildJsonObject {
                put("novelId", novelId)
                put("chapterId", "chapter:novel:mahoureader:%2Fseries%2F352%2Fbarbaro:$chapterKey")
                put("readAtMs", 1_790_144_696_000)
            },
        )
        fun lastRead() = database.historyQueries.getByChapterUrl("/series/352/ler/207118")
            .executeAsOneOrNull()?.history_last_read

        // A record whose decoded work does not hash to its novel id is ignored.
        projection.upsert(database, history("%2Fseries%2F352%2Fler%2F207118", novelId = "novel:other"))
        assertNull(lastRead())

        projection.upsert(database, history("%2Fseries%2F352%2Fler%2F207118"))
        assertEquals(1_790_144_696_000, lastRead())
        assertFalse(database.chaptersQueries.getChaptersById(chapterId).executeAsOne().read)
    }

    @Test
    fun `comic history tombstone removes only remote progress`() = runTest {
        val entry = comicEntryRecord()
        projection.upsert(database, entry)
        projection.upsert(database, comicHistoryRecord())

        projection.replaceScope(
            database = database,
            scopeId = COMIC_SCOPE_ID,
            previousRecords = listOf(entry, comicHistoryRecord()),
            previousTombstones = emptyList(),
            records = listOf(entry),
            tombstones = listOf(
                CoreConfirmedTombstone(
                    key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.history", HISTORY_ID),
                    serverVersion = 3,
                    lamport = 3,
                    deletedAtMs = 300,
                    reasonCode = "cleared",
                ),
            ),
        )

        assertNull(
            database.aethon_syncQueries
                .selectReaderProgress(COMIC_ID)
                .executeAsOneOrNull(),
        )
        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
    }

    @Test
    fun `authoritative comic snapshot removes orphaned legacy profile progress`() = runTest {
        val staleComicId = "suwayomi:profile:main:manga:999"
        database.aethon_syncQueries.upsertIdentity(
            entityId = staleComicId,
            contentType = "MANGA",
            localReference = staleComicId,
            createdAt = 800,
            updatedAt = 800,
        )
        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = staleComicId,
            chapterEntityId = null,
            locatorJson = "{}",
            chapterOrdinal = null,
            progression = 0.75,
            serverRevision = 8,
            updatedAt = 800,
        )

        projection.replaceScope(
            database = database,
            scopeId = COMIC_SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = listOf(comicHistoryRecord()),
            tombstones = emptyList(),
        )

        assertNull(database.aethon_syncQueries.selectReaderProgress(staleComicId).executeAsOneOrNull())
        assertNotNull(database.aethon_syncQueries.selectReaderProgress(COMIC_ID).executeAsOneOrNull())
    }

    @Test
    fun `received portable comic progress joins pending hydration scope until exact bindings exist`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/Manga/Keep?A=%2F"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/Chapter/7?Cursor=Keep"))
        val workId = PortableIdentityV3.workId(work)
        val chapterId = PortableIdentityV3.chapterId(chapter)
        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.history", "comic.history::$workId"),
                serverVersion = 9,
                lamport = 9,
                originServerId = ORIGIN_SERVER_ID,
                record = buildJsonObject {
                    put("comicId", workId)
                    put("chapterId", chapterId)
                    put("pageIndex", 3)
                    put("pageCount", 12)
                    put("progressPercent", 0.25)
                    put("readAtMs", 900)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                    put("portableChapterRef", Json.encodeToJsonElement(chapter))
                },
            ),
        )

        assertEquals(0.25, database.aethon_syncQueries.selectReaderProgress(workId).executeAsOne().progression)
        assertEquals(
            PortableResolutionState.PENDING_PROVIDER.name,
            database.aethon_syncQueries.selectPortableWorkBinding(workId).executeAsOne().resolution_state,
        )
        assertEquals(
            PortableResolutionState.PENDING_PROVIDER.name,
            database.aethon_syncQueries.selectPortableChapterBinding(chapterId).executeAsOne().resolution_state,
        )
        val portableStore = SqlDelightPortableBindingStore(database)
        assertEquals(listOf(workId), portableStore.pendingWorks(ORIGIN_SERVER_ID, "main", 10).map { it.portableId })
        assertEquals(
            listOf(chapterId),
            portableStore.pendingChapters(ORIGIN_SERVER_ID, "main", 10).map { it.portableChapterId },
        )
        assertTrue(portableStore.pendingWorks("other-server", "main", 10).isEmpty())

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(
                    COMIC_SCOPE_ID,
                    "comic.chapter_state",
                    "comic.chapter_state::$workId::$chapterId",
                ),
                serverVersion = 10,
                lamport = 10,
                originServerId = ORIGIN_SERVER_ID,
                record = buildJsonObject {
                    put("chapterStateId", "comic.chapter_state::$workId::$chapterId")
                    put("comicId", workId)
                    put("chapterId", chapterId)
                    put("read", true)
                    put("bookmarked", true)
                    put("lastPageRead", 5)
                    put("updatedAtMs", 1_000)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                    put("portableChapterRef", Json.encodeToJsonElement(chapter))
                },
            ),
        )

        assertEquals(0.25, database.aethon_syncQueries.selectReaderProgress(workId).executeAsOne().progression)
    }

    @Test
    fun `chapter state for a chapter fetched after hydration binds the local chapter of a bound work`() = runTest {
        val mangaId = insertTrackingManga(42, "/series/165")
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = "/series/165/new",
            name = "Chapter 18",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 0,
            chapterNumber = 18.0,
            sourceOrder = 0,
            dateFetch = 0,
            dateUpload = 0,
            memo = JsonObject(emptyMap()),
        )
        val localChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/series/165"))
        val chapter = PortableChapterRef.Comic(work, ProviderOwnedKey("/series/165/new"))
        val workId = PortableIdentityV3.workId(work)
        val chapterId = PortableIdentityV3.chapterId(chapter)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 1,
                updatedAt = 1,
            ),
        )

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.chapter_state", "comic.chapter_state::$workId::$chapterId"),
                serverVersion = 10,
                lamport = 10,
                originServerId = ORIGIN_SERVER_ID,
                record = buildJsonObject {
                    put("comicId", workId)
                    put("chapterId", chapterId)
                    put("read", true)
                    put("updatedAtMs", 1_000)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                    put("portableChapterRef", Json.encodeToJsonElement(chapter))
                },
            ),
        )

        val binding = database.aethon_syncQueries.selectPortableChapterBinding(chapterId).executeAsOne()
        assertEquals(PortableResolutionState.BOUND.name, binding.resolution_state)
        assertEquals(localChapterId.toString(), binding.local_reference)
        assertTrue(database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsOne().read)
    }

    @Test
    fun `portable comic category assignment resolves only an exact bound work`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/Manga/Exact"))
        val workId = PortableIdentityV3.workId(work)
        database.mangasQueries.insert(
            source = 42,
            url = "/Manga/Exact",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Exact",
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
        val localMangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = localMangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Exact",
                providerLabelHint = "Fixture",
                attemptCount = 1,
                updatedAt = 1,
            ),
        )
        database.categoriesQueries.insert("Portable", 0, 0, "")
        val localCategoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        val categoryId = "suwayomi:profile:main:category:3"
        database.aethon_syncQueries.upsertCategoryIdentity(
            entityId = categoryId,
            localCategoryId = localCategoryId,
            contentScope = "MANGA",
            name = "Portable",
            sortOrder = 0,
            updatedAt = 1,
        )

        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(
                    COMIC_SCOPE_ID,
                    "comic.category_assignment",
                    "comic-category-assignment:test",
                ),
                serverVersion = 11,
                lamport = 11,
                originServerId = ORIGIN_SERVER_ID,
                record = buildJsonObject {
                    put("assignmentId", "comic-category-assignment:test")
                    put("comicId", workId)
                    put("categoryId", categoryId)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                },
            ),
        )

        assertEquals(
            listOf(localCategoryId),
            database.categoriesQueries.findAllByMangaId(localMangaId).executeAsList().map { it._id },
        )
    }

    @Test
    fun `portable novel progress is retained without a legacy identity`() = runTest {
        val work = PortableWorkRef.Novel("plugin.exact", ProviderOwnedKey("novel/Keep/Case"))
        val chapter = PortableChapterRef.Novel(work, ProviderOwnedKey("chapter/3?Cursor=Keep"))
        val workId = PortableIdentityV3.workId(work)
        val chapterId = PortableIdentityV3.chapterId(chapter)
        projection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(SCOPE_ID, "novel.progress", "novel.progress::$workId"),
                serverVersion = 10,
                lamport = 10,
                record = buildJsonObject {
                    put("chapterId", chapterId)
                    put("progressPercent", 0.35)
                    put("updatedAtMs", 1_000)
                    put("portableWorkRef", Json.encodeToJsonElement(work))
                    put("portableChapterRef", Json.encodeToJsonElement(chapter))
                },
            ),
        )

        assertEquals(0.35, database.aethon_syncQueries.selectReaderProgress(workId).executeAsOne().progression)
        assertEquals(
            work.pluginId,
            database.aethon_syncQueries.selectPortableWorkBinding(workId).executeAsOne().dependency_key,
        )
        assertEquals(
            PortableResolutionState.PENDING_PROVIDER.name,
            database.aethon_syncQueries.selectPortableChapterBinding(chapterId).executeAsOne().resolution_state,
        )
    }

    @Test
    fun `verified Core catalog entry uses internal source and preserves original binding`() = runTest {
        projection.upsert(database, verifiedCoreEntryRecord())

        val manga = database.mangasQueries.findFavorites().executeAsList().single()
        assertEquals(EpigraphCoreSource.ID, manga.source)
        assertEquals("aethon-core://suwayomi/main/manga/7", manga.url)
        assertTrue(manga.initialized)
        val binding = database.aethon_syncQueries.selectBindingsByEntityId(VERIFIED_CORE_ID).executeAsList().single()
        assertEquals("42", binding.source_id)
        assertEquals("https://source.test/title", binding.normalized_url)
    }

    @Test
    fun `Core catalog entry preserves the provider-owned key as the binding url`() = runTest {
        projection.upsert(
            database,
            verifiedCoreEntryRecord(providerKey = "/comic/89DHxSDu#"),
        )

        val binding = database.aethon_syncQueries.selectBindingsByEntityId(VERIFIED_CORE_ID).executeAsList().single()
        assertEquals("/comic/89DHxSDu#", binding.normalized_url)
        assertEquals(
            database.mangasQueries.findFavorites().executeAsList().single()._id,
            database.aethon_syncQueries
                .selectAethonCoreMangaBySourceBinding(
                    sourceId = "42",
                    providerKey = "/comic/89DHxSDu#",
                    coreSourceId = EpigraphCoreSource.ID,
                )
                .executeAsList()
                .single(),
        )
    }

    @Test
    fun `portable hydration lookup finds the existing Core row without creating another favorite`() = runTest {
        projection.upsert(database, verifiedCoreEntryRecord())

        val candidates = database.aethon_syncQueries
            .selectAethonCoreMangaBySourceBinding(
                sourceId = "42",
                providerKey = "https://source.test/title",
                coreSourceId = EpigraphCoreSource.ID,
            )
            .executeAsList()

        assertEquals(1, candidates.size)
        assertEquals(
            database.mangasQueries.findFavorites().executeAsList().single()._id,
            candidates.single(),
        )
    }

    @Test
    fun `verified Core catalog entry promotes an exact portable binding to the native source`() = runTest {
        projection.upsert(database, verifiedCoreEntryRecord())
        val legacyId = database.mangasQueries.findFavorites().executeAsOne()._id
        database.categoriesQueries.insert("Keep", 0, 0, "a")
        val categoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.insertMangaCategoryAssignment(legacyId, categoryId)

        database.mangasQueries.insert(
            source = 42,
            url = "/title/provider-owned",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Native source title",
            status = 0,
            thumbnailUrl = null,
            favorite = false,
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
        val nativeId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val portableRef = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/title/provider-owned"))
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(portableRef),
                ref = portableRef,
                localReference = nativeId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 99,
            ),
        )

        projection.upsert(database, verifiedCoreEntryRecord(providerKey = portableRef.mangaKey.value))

        val promoted = database.mangasQueries.findById(nativeId).executeAsOne()
        assertTrue(promoted.favorite)
        assertEquals(42, promoted.source)
        assertEquals("/title/provider-owned", promoted.url)
        assertFalse(database.mangasQueries.findById(legacyId).executeAsOne().favorite)
        assertEquals(
            listOf("Keep"),
            database.categoriesQueries.findAllByMangaId(nativeId).executeAsList().map { it.name },
        )
        assertEquals(
            nativeId.toString(),
            database.aethon_syncQueries.selectIdentityByEntityId(VERIFIED_CORE_ID).executeAsOne().local_reference,
        )
    }

    @Test
    fun `Core catalog entry adopts the same work restored natively from a backup`() = runTest {
        database.mangasQueries.insert(
            source = 42,
            url = "/title/restored",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Restored title",
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
        val nativeId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val categoryId = insertFolder("Reading", 0)
        database.aethon_syncQueries.insertMangaCategoryAssignment(nativeId, categoryId)

        projection.upsert(database, verifiedCoreEntryRecord(providerKey = "/title/restored"))

        val favorite = database.mangasQueries.findFavorites().executeAsList().single()
        assertEquals(nativeId, favorite._id)
        assertEquals(42, favorite.source)
        assertEquals("/title/restored", favorite.url)
        assertEquals(
            nativeId.toString(),
            database.aethon_syncQueries.selectIdentityByEntityId(VERIFIED_CORE_ID).executeAsOne().local_reference,
        )
        assertEquals(
            listOf("Reading"),
            database.categoriesQueries.findAllByMangaId(nativeId).executeAsList().map { it.name },
        )
    }

    @Test
    fun `current Core identity wins over a stale portable bridge without losing local state`() = runTest {
        val providerKey = "/title/provider-owned"
        projection.upsert(database, verifiedCoreEntryRecord(providerKey = providerKey))
        val currentId = database.mangasQueries.findFavorites().executeAsOne()._id
        database.mangasQueries.markNotFavorite(currentId)

        database.mangasQueries.insert(
            source = EpigraphCoreSource.ID,
            url = "aethon-core://suwayomi/old-server/main/manga/7",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Stale bridge",
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
        val staleId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:server:old-server:profile:main:manga:7",
            contentType = "MANGA",
            localReference = staleId.toString(),
            createdAt = 0,
            updatedAt = 0,
        )
        database.categoriesQueries.insert("Keep stale category", 0, 0, "a")
        val categoryId = database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.insertMangaCategoryAssignment(staleId, categoryId)
        database.chaptersQueries.insert(
            mangaId = staleId,
            url = "/chapter/1",
            name = "Chapter 1",
            scanlator = null,
            read = true,
            bookmark = true,
            lastPageRead = 4,
            pagesLeft = 6,
            chapterNumber = 1.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        val portableRef = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey(providerKey))
        val portableStore = SqlDelightPortableBindingStore(database)
        portableStore.upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(portableRef),
                ref = portableRef,
                localReference = staleId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )

        projection.upsert(database, verifiedCoreEntryRecord(providerKey = providerKey))

        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
        assertTrue(database.mangasQueries.findById(currentId).executeAsOne().favorite)
        assertFalse(database.mangasQueries.findById(staleId).executeAsOne().favorite)
        assertEquals(
            listOf("Keep stale category"),
            database.categoriesQueries.findAllByMangaId(currentId).executeAsList().map { it.name },
        )
        val chapter = database.chaptersQueries.getChaptersByMangaId(currentId, 0).executeAsOne()
        assertTrue(chapter.read)
        assertTrue(chapter.bookmark)
        assertEquals(currentId.toString(), portableStore.work(portableRef)?.localReference)
        assertEquals(
            currentId.toString(),
            database.aethon_syncQueries.selectIdentityByEntityId(VERIFIED_CORE_ID).executeAsOne().local_reference,
        )
    }

    @Test
    fun `current Core identity does not collide with a native row owned by the previous Core`() = runTest {
        val providerKey = "/title/native-provider-owned"
        projection.upsert(database, verifiedCoreEntryRecord(providerKey = providerKey))
        val currentId = database.mangasQueries.findFavorites().executeAsOne()._id
        database.mangasQueries.markNotFavorite(currentId)
        database.chaptersQueries.insert(
            mangaId = currentId,
            url = "/chapter/shared",
            name = "Shared chapter",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 10,
            chapterNumber = 1.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )

        database.mangasQueries.insert(
            source = 42,
            url = providerKey,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Previous native row",
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
        val previousId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:server:previous:profile:main:manga:7",
            contentType = "MANGA",
            localReference = previousId.toString(),
            createdAt = 0,
            updatedAt = 0,
        )
        database.chaptersQueries.insert(
            mangaId = previousId,
            url = "/chapter/shared",
            name = "Shared chapter",
            scanlator = null,
            read = true,
            bookmark = true,
            lastPageRead = 7,
            pagesLeft = 3,
            chapterNumber = 1.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        database.chaptersQueries.insert(
            mangaId = previousId,
            url = "/chapter/only-previous",
            name = "Previous-only chapter",
            scanlator = null,
            read = true,
            bookmark = false,
            lastPageRead = 2,
            pagesLeft = 1,
            chapterNumber = 2.0,
            sourceOrder = 1,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        val portableRef = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey(providerKey))
        val portableStore = SqlDelightPortableBindingStore(database)
        portableStore.upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(portableRef),
                ref = portableRef,
                localReference = previousId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )

        projection.upsert(database, verifiedCoreEntryRecord(providerKey = providerKey))

        assertTrue(database.mangasQueries.findById(currentId).executeAsOne().favorite)
        assertFalse(database.mangasQueries.findById(previousId).executeAsOne().favorite)
        assertEquals(currentId.toString(), portableStore.work(portableRef)?.localReference)
        val chapters = database.chaptersQueries.getChaptersByMangaId(currentId, 0).executeAsList()
        assertEquals(2, chapters.size)
        assertTrue(chapters.first { it.url == "/chapter/shared" }.read)
        assertTrue(chapters.first { it.url == "/chapter/shared" }.bookmark)
        assertEquals(7, chapters.first { it.url == "/chapter/shared" }.last_page_read)
        assertEquals(
            currentId.toString(),
            database.aethon_syncQueries.selectIdentityByEntityId(VERIFIED_CORE_ID).executeAsOne().local_reference,
        )
    }

    @Test
    fun `renumbered Suwayomi work transfers exact portable ownership to the current Core`() = runTest {
        val providerKey = "/title/renumbered"
        database.mangasQueries.insert(
            source = 42,
            url = providerKey,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Renumbered work",
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
        val existingId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val previousEntityId = "suwayomi:server:previous:profile:main:manga:99"
        database.aethon_syncQueries.upsertIdentity(
            entityId = previousEntityId,
            contentType = "MANGA",
            localReference = existingId.toString(),
            createdAt = 0,
            updatedAt = 0,
        )
        database.aethon_syncQueries.insertBinding(
            bindingId = "previous-exact-binding",
            entityId = previousEntityId,
            ecosystem = "SUWAYOMI",
            repository = "previous",
            pluginPackage = "test.extension",
            sourceId = "42",
            normalizedUrl = providerKey,
            isPrimary = true,
            createdAt = 0,
        )
        val portableRef = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey(providerKey))
        val portableStore = SqlDelightPortableBindingStore(database)
        portableStore.upsertWork(
            PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(portableRef),
                ref = portableRef,
                localReference = null,
                resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )

        projection.upsert(database, verifiedCoreEntryRecord(providerKey = providerKey))

        assertEquals(1, database.mangasQueries.findFavorites().executeAsList().size)
        assertEquals(
            existingId.toString(),
            database.aethon_syncQueries.selectIdentityByEntityId(VERIFIED_CORE_ID).executeAsOne().local_reference,
        )
        assertNull(database.aethon_syncQueries.selectIdentityByEntityId(previousEntityId).executeAsOneOrNull())
        assertEquals(existingId.toString(), portableStore.work(portableRef)?.localReference)
    }

    @Test
    fun `comic and books categories of the same name keep separate folders`() = runTest {
        val folder = insertFolder("Reading", sort = 4)

        projection.upsert(database, categoryRecord(COMIC_SCOPE_ID, "comic.category", "comic-cat-1", "Reading", 2))
        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "reading", 7))
        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", "book-cat-1", " Reading ", 9))

        // The local Comics folder is joined by the comic category only.
        assertEquals(mapOf("MANGA" to "comic-cat-1"), folderScopes(folder))
        val joined = database.categoriesQueries.findAll().executeAsList().single { it._id == folder }
        assertEquals("Reading", joined.name)
        assertEquals(2L, joined.sort)
        // Novels and books share one Books & novels folder, never listed with Comics.
        val booksFolder = database.aethon_syncQueries.selectCategoryIdentityByEntityId("novel-cat-1")
            .executeAsOne().local_category_id
        assertTrue(booksFolder != folder)
        assertEquals(mapOf("BOOK" to "book-cat-1", "NOVEL" to "novel-cat-1"), folderScopes(booksFolder))
        assertEquals(listOf(booksFolder), database.categoriesQueries.findAllBooks().executeAsList().map { it._id })
        assertTrue(database.categoriesQueries.findAllComics().executeAsList().none { it._id == booksFolder })
    }

    @Test
    fun `an exact name wins over a different letter case`() = runTest {
        val lower = insertBooksFolder("reading", sort = 0)
        val exact = insertBooksFolder("Reading", sort = 1)

        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "Reading", 1))

        assertTrue(folderScopes(lower).isEmpty())
        assertEquals(mapOf("NOVEL" to "novel-cat-1"), folderScopes(exact))
    }

    @Test
    fun `a rename in one library moves the shared folder but a replay does not undo it`() = runTest {
        val folder = insertBooksFolder("Reading", sort = 0)
        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", "book-cat-1", "Reading", 0))
        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "Reading", 0))

        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "Now reading", 0))
        // A snapshot after re-pair replays the book category with its old name.
        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", "book-cat-1", "Reading", 0))

        assertEquals("Now reading", database.categoriesQueries.findAll().executeAsList().single { it._id == folder }.name)
    }

    @Test
    fun `a desktop books category binds one folder in both libraries and its deletion removes it`() = runTest {
        val shared = "books-category:shared"
        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", shared, "Fila", 4))
        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", shared, "Fila", 4))
        // A replay of the book record must not move the id out of the novel library.
        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", shared, "Fila", 4))

        val folder = database.categoriesQueries.findAllBooks().executeAsList().single()._id
        assertEquals(mapOf("BOOK" to shared, "NOVEL" to shared), folderScopes(folder))

        listOf(BOOK_SCOPE_ID to "book.category", SCOPE_ID to "novel.category").forEachIndexed { index, (scope, type) ->
            projection.delete(
                database,
                CoreConfirmedTombstone(
                    key = CoreReplicaKey(scope, type, shared),
                    serverVersion = 10L + index,
                    lamport = 10L + index,
                    deletedAtMs = 1_000,
                    reasonCode = "deleted",
                ),
                null,
            )
            if (index == 0) assertEquals(mapOf("NOVEL" to shared), folderScopes(folder))
        }

        assertTrue(database.categoriesQueries.findAll().executeAsList().none { it._id == folder })
    }

    @Test
    fun `a binding left over from an earlier pairing is replaced by the same-named category`() = runTest {
        val folder = insertBooksFolder("Reading", sort = 0, scope = "BOOK")
        bindFolder(folder, "book-category-old", "BOOK", "Reading")

        projection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", "book-cat-1", "Reading", 0))

        assertEquals(mapOf("BOOK" to "book-cat-1"), folderScopes(folder))
        assertEquals(1, database.categoriesQueries.findAll().executeAsList().size)
    }

    @Test
    fun `a live category of the same library and name stays a separate folder`() = runTest {
        val folder = insertBooksFolder("Reading", sort = 0)
        bindFolder(folder, "novel-cat-1", "NOVEL", "Reading")
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            SCOPE_ID, "novel.category", "novel-cat-1", 1, 1, "{}", "0".repeat(64),
        )

        projection.upsert(database, categoryRecord(SCOPE_ID, "novel.category", "novel-cat-2", "Reading", 1))

        assertEquals(mapOf("NOVEL" to "novel-cat-1"), folderScopes(folder))
        val second = database.aethon_syncQueries.selectCategoryIdentityByEntityId("novel-cat-2").executeAsOne()
        assertTrue(second.local_category_id != folder)
    }

    @Test
    fun `a book category does not join a folder whose books were never published`() = runTest {
        val folder = insertBooksFolder("Reading", sort = 0, scope = "BOOK")
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        bookProjection.upsert(database, bookEntryRecord())
        database.local_booksQueries.insertCategory(BOOK_ID, folder)

        bookProjection.upsert(database, categoryRecord(BOOK_SCOPE_ID, "book.category", "book-cat-1", "Reading", 0))
        // The desktop's complete set for the book does not list the new category.
        bookProjection.upsert(
            database,
            CoreConfirmedRecord(
                key = CoreReplicaKey(BOOK_SCOPE_ID, "book.category_assignment", BOOK_ID),
                serverVersion = 3,
                lamport = 3,
                record = buildJsonObject {
                    put("bookId", BOOK_ID)
                    put("categoryIds", JsonArray(emptyList()))
                },
            ),
        )

        assertTrue(folderScopes(folder).isEmpty())
        assertEquals(listOf(folder), database.local_booksQueries.findCategoryIds(BOOK_ID).executeAsList())
    }

    @Test
    fun `book snapshot materializes metadata progress category and bookmark without downloading asset`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        val records = listOf(
            bookEntryRecord(),
            bookCategoryRecord(),
            bookAssignmentRecord(),
            bookProgressRecord(),
            bookBookmarkRecord(),
            bookHighlightRecord(),
        )

        bookProjection.replaceScope(
            database = database,
            scopeId = BOOK_SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = records,
            tombstones = emptyList(),
        )

        val book = database.local_booksQueries.findById(BOOK_ID).executeAsOne()
        assertEquals(BOOK_SHA, book.sha256)
        assertEquals("Epigraph Book", book.display_name)
        assertEquals(1L, book.chapter_count)
        assertFalse(File(book.private_path).exists())
        assertNull(book.cover_path)
        assertEquals(BOOK_COVER_SHA, book.cover_asset_sha256)
        assertEquals(BOOK_COVER_BYTES, book.cover_asset_byte_size)
        assertEquals("image/png", book.cover_asset_mime_type)
        val asset = database.aethon_syncQueries.selectAssetManifest(BOOK_SHA).executeAsOne()
        assertEquals("PENDING_DOWNLOAD", asset.state)
        assertEquals(true, asset.remote_available)
        assertNull(asset.local_uri)
        val assetLinks = database.aethon_syncQueries.selectEntityAssets(BOOK_ID).executeAsList()
        assertEquals(setOf("PUBLICATION", "COVER"), assetLinks.map { it.role }.toSet())
        val coverAsset = database.aethon_syncQueries.selectAssetManifest(BOOK_COVER_SHA).executeAsOne()
        assertEquals("BOOK_COVER", coverAsset.content_type)
        assertEquals("PENDING_DOWNLOAD", coverAsset.state)
        assertNull(coverAsset.local_uri)
        assertEquals(listOf(1L), database.local_booksQueries.findCategoryIds(BOOK_ID).executeAsList())

        val progress = database.local_booksQueries.findProgress(BOOK_ID).executeAsOne()
        val locator = kotlinx.serialization.json.Json.decodeFromString(
            ReaderLocator.serializer(),
            progress.locator_json,
        )
        assertEquals(ReaderLocator.Epub(epigraph.contract.EpigraphEntityId(BOOK_ID), "epubcfi(/6/2)", 0.4), locator)

        val bookmark = database.local_booksQueries.findBookmarks(BOOK_ID).executeAsList().single()
        assertEquals("Remember this", bookmark.note)
        val highlight = database.local_booksQueries.findHighlights(BOOK_ID).executeAsList().single()
        assertEquals("Selected text", highlight.selected_text)
        assertEquals("Highlight note", highlight.note)
    }

    @Test
    fun `novel progress that outlives its entry never fails the novel snapshot`() = runTest {
        // Desktop keeps the reading position of a novel removed from its library.
        val removedEntry = CoreConfirmedTombstone(
            key = CoreReplicaKey(SCOPE_ID, "novel.entry", CANONICAL_NOVEL_ID),
            serverVersion = 2,
            lamport = 2,
            deletedAtMs = 200,
            reasonCode = "novel_deleted",
        )

        projection.replaceScope(
            database = database,
            scopeId = SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = listOf(progressRecord()),
            tombstones = listOf(removedEntry),
        )

        assertEquals(
            0.5,
            database.aethon_syncQueries.selectReaderProgress(CANONICAL_NOVEL_ID).executeAsOne().progression,
        )

        // Adding the novel again binds the placeholder identity to a real local row.
        projection.upsert(database, novelEntryRecord())

        val identity = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID).executeAsOne()
        assertNotNull(identity.local_reference.toLongOrNull())
        assertNotNull(database.aethon_syncQueries.selectReaderProgress(CANONICAL_NOVEL_ID).executeAsOneOrNull())
        // Its source counts as a novel source even when the plugin is not installed here.
        val localNovel = database.mangasQueries.findById(identity.local_reference.toLong()).executeAsOne()
        assertEquals(
            listOf(localNovel.source),
            database.aethon_syncQueries.selectNovelSourceIds().executeAsList(),
        )
    }

    @Test
    fun `synced novel takes the source id of the installed LNReader plugin`() = runTest {
        val record = novelEntryRecord().let {
            it.copy(
                record = JsonObject(
                    (it.record as JsonObject) + ("source" to buildJsonObject {
                        put("pluginId", "Illusia")
                        put("lang", "Português")
                    }),
                ),
            )
        }

        projection.upsert(database, record)

        val identity = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID).executeAsOne()
        val localNovel = database.mangasQueries.findById(identity.local_reference.toLong()).executeAsOne()
        assertEquals(NovelSource.sourceIdFor("illusia", "pt"), localNovel.source)
        assertEquals(8409116688781432325L, localNovel.source)
    }

    @Test
    fun `desktop novel chapter state marks the chapter the plugin listed instead of adding a twin`() = runTest {
        projection.upsert(database, novelEntryRecord())
        val mangaId = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID)
            .executeAsOne().local_reference.toLong()
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = "/novel/epigraph/chapter-1",
            name = "1. The beginning",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 100,
            chapterNumber = 0.0,
            sourceOrder = 154,
            dateFetch = 1,
            dateUpload = 7,
            memo = JsonObject(emptyMap()),
        )
        val pluginChapterId = database.chaptersQueries.selectLastInsertedRowId().executeAsOne()

        projection.upsert(database, novelChapterRecord(unread = false))

        val chapters = database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList()
        assertEquals(listOf(pluginChapterId), chapters.map { it._id })
        val chapter = chapters.single()
        assertTrue(chapter.read)
        assertEquals("1. The beginning", chapter.name)
        assertEquals(0.0, chapter.chapter_number)
        assertEquals(7L, chapter.date_upload)
        assertEquals(
            pluginChapterId,
            database.aethon_syncQueries.selectChapterBindingByEntityId("chapter-1").executeAsOne().local_chapter_id,
        )

        projection.upsert(database, novelChapterRecord(unread = true, serverVersion = 3))
        val replayed = database.chaptersQueries.getChaptersById(pluginChapterId).executeAsOne()
        assertFalse(replayed.read)
        assertEquals("1. The beginning", replayed.name)
        assertEquals(0.0, replayed.chapter_number)
        assertEquals(1, database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList().size)
    }

    @Test
    fun `a twin bound by an earlier sync gives the state back to the plugin chapter and goes away`() = runTest {
        projection.upsert(database, novelEntryRecord())
        val mangaId = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID)
            .executeAsOne().local_reference.toLong()
        fun insertChapter(name: String): Long {
            database.chaptersQueries.insert(
                mangaId = mangaId,
                url = "/novel/epigraph/chapter-1",
                name = name,
                scanlator = null,
                read = false,
                bookmark = false,
                lastPageRead = 0,
                pagesLeft = 100,
                chapterNumber = 1.0,
                sourceOrder = 0,
                dateFetch = 1,
                dateUpload = 1,
                memo = JsonObject(emptyMap()),
            )
            return database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
        }
        val pluginChapterId = insertChapter("1. The beginning")
        val twinId = insertChapter("Chapter 1")
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = "chapter-1",
            workEntityId = CANONICAL_NOVEL_ID,
            localChapterId = twinId,
            normalizedUrl = "/novel/epigraph/chapter-1",
            ordinal = 1.0,
            updatedAt = 1,
        )

        projection.upsert(database, novelChapterRecord(unread = false))

        val chapters = database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList()
        assertEquals(listOf(pluginChapterId), chapters.map { it._id })
        assertTrue(chapters.single().read)
        assertEquals(
            pluginChapterId,
            database.aethon_syncQueries.selectChapterBindingByEntityId("chapter-1").executeAsOne().local_chapter_id,
        )
    }

    @Test
    fun `the same novel chapter named differently by two devices shares one local chapter`() = runTest {
        projection.upsert(database, novelEntryRecord())
        projection.upsert(database, novelChapterRecord(unread = false))
        val desktopNamed = novelChapterRecord(unread = true, serverVersion = 3).let {
            it.copy(key = it.key.copy(entityId = "desktop-chapter-1"))
        }

        projection.upsert(database, desktopNamed)

        val chapterId = database.aethon_syncQueries.selectChapterBindingByEntityId("chapter-1")
            .executeAsOne().local_chapter_id
        assertFalse(database.chaptersQueries.getChaptersById(chapterId).executeAsOne().read)
        assertNull(database.aethon_syncQueries.selectChapterBindingByEntityId("desktop-chapter-1").executeAsOneOrNull())
        val mangaId = database.chaptersQueries.getChaptersById(chapterId).executeAsOne().manga_id
        assertEquals(1, database.chaptersQueries.getChaptersByMangaId(mangaId, 0).executeAsList().size)
    }

    @Test
    fun `synced novel records its plugin as a named novel source`() = runTest {
        val remembered = mutableListOf<Pair<Long, String?>>()
        val recording = EpigraphCoreDomainProjection(rememberNovelSource = { id, name -> remembered += id to name })
        val record = novelEntryRecord().let {
            it.copy(
                record = JsonObject(
                    (it.record as JsonObject) + ("source" to buildJsonObject {
                        put("pluginId", "Illusia")
                        put("pluginName", "Illusia")
                        put("lang", "Português")
                    }),
                ),
            )
        }

        recording.upsert(database, record)

        assertEquals(listOf(NovelSource.sourceIdFor("illusia", "pt") to "Illusia"), remembered)
    }

    @Test
    fun `re-keyed novel placeholder joins the hydrated plugin row instead of duplicating it`() = runTest {
        projection.upsert(database, novelEntryRecord())
        val placeholderId = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID)
            .executeAsOne().local_reference.toLong()
        val pluginSource = NovelSource.sourceIdFor("illusia", "pt")
        val hydratedId = insertTrackingManga(pluginSource, "/novel/epigraph")
        val record = novelEntryRecord().let {
            it.copy(
                serverVersion = 2,
                record = JsonObject(
                    (it.record as JsonObject) + ("source" to buildJsonObject {
                        put("pluginId", "Illusia")
                        put("lang", "Português")
                    }),
                ),
            )
        }

        projection.upsert(database, record)

        val identity = database.aethon_syncQueries.selectIdentityByEntityId(CANONICAL_NOVEL_ID).executeAsOne()
        assertEquals(hydratedId.toString(), identity.local_reference)
        assertEquals(false, database.mangasQueries.findById(placeholderId).executeAsOne().favorite)
        assertEquals(
            listOf(hydratedId),
            database.mangasQueries.findByUrlAndSource("/novel/epigraph", pluginSource).executeAsList()
                .filter { it.favorite }.map { it._id },
        )
    }

    @Test
    fun `desktop PDF page numbers count from one and never fail the book snapshot`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        val pdfEntry = CoreConfirmedRecord(
            key = CoreReplicaKey(BOOK_SCOPE_ID, "book.entry", BOOK_ID),
            serverVersion = 1,
            lamport = 1,
            record = buildJsonObject {
                put("assetFingerprint", BOOK_SHA)
                put("title", "Epigraph PDF")
                put("subtype", "pdf")
                put("mimeType", "application/pdf")
                put("byteSize", 1234)
                put("pageCount", 5)
                put("createdAtMs", 100)
                put("bookUpdatedAtMs", 200)
            },
        )
        // Shape written by the desktop PDF reader on the last page: page 5 of 5.
        val lastPage = CoreConfirmedRecord(
            key = CoreReplicaKey(BOOK_SCOPE_ID, "book.progress", BOOK_ID),
            serverVersion = 2,
            lamport = 2,
            record = buildJsonObject {
                put("bookId", BOOK_ID)
                put("renderer", "pdf")
                put("pageIndex", 5)
                put("totalPages", 5)
                put("progressPercent", 1.0)
                put("lastReadAtMs", 400)
            },
        )
        val bookmark = CoreConfirmedRecord(
            key = CoreReplicaKey(BOOK_SCOPE_ID, "book.bookmark", BOOKMARK_ID),
            serverVersion = 3,
            lamport = 3,
            record = buildJsonObject {
                put("bookId", BOOK_ID)
                put("pageIndex", 3)
                put("progressPercent", 0.5)
                put("savedAtMs", 500)
            },
        )

        bookProjection.replaceScope(
            database = database,
            scopeId = BOOK_SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = listOf(pdfEntry, lastPage, bookmark),
            tombstones = emptyList(),
        )

        val progress = database.local_booksQueries.findProgress(BOOK_ID).executeAsOne()
        val locator = kotlinx.serialization.json.Json.decodeFromString(
            ReaderLocator.serializer(),
            progress.locator_json,
        ) as ReaderLocator.Pdf
        assertEquals(4, locator.pageIndex)
        assertEquals(5, locator.totalPages)
        val savedBookmark = database.local_booksQueries.findBookmarks(BOOK_ID).executeAsList().single()
        val bookmarkLocator = kotlinx.serialization.json.Json.decodeFromString(
            ReaderLocator.serializer(),
            savedBookmark.locator_json,
        ) as ReaderLocator.Pdf
        assertEquals(2, bookmarkLocator.pageIndex)
    }

    @Test
    fun `book absence in an unproven snapshot never deletes last known good state`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        val records = listOf(bookEntryRecord(), bookProgressRecord(), bookBookmarkRecord(), bookHighlightRecord())
        bookProjection.replaceScope(
            database = database,
            scopeId = BOOK_SCOPE_ID,
            previousRecords = emptyList(),
            previousTombstones = emptyList(),
            records = records,
            tombstones = emptyList(),
        )

        bookProjection.replaceScope(
            database = database,
            scopeId = BOOK_SCOPE_ID,
            previousRecords = records,
            previousTombstones = emptyList(),
            records = emptyList(),
            tombstones = emptyList(),
        )

        assertNotNull(database.local_booksQueries.findById(BOOK_ID).executeAsOneOrNull())
        assertNotNull(database.local_booksQueries.findProgress(BOOK_ID).executeAsOneOrNull())
        assertEquals(1, database.local_booksQueries.findBookmarks(BOOK_ID).executeAsList().size)
        assertEquals(1, database.local_booksQueries.findHighlights(BOOK_ID).executeAsList().size)
    }

    @Test
    fun `explicit book tombstone removes membership but retains immutable bytes`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        val entry = bookEntryRecord()
        bookProjection.upsert(database, entry)
        val book = database.local_booksQueries.findById(BOOK_ID).executeAsOne()
        File(book.private_path).apply {
            parentFile?.mkdirs()
            writeText("immutable bytes retained for explicit GC")
        }

        bookProjection.delete(database, bookEntryTombstone(), entry)

        assertNull(database.local_booksQueries.findById(BOOK_ID).executeAsOneOrNull())
        assertEquals(true, File(book.private_path).exists())
    }

    @Test
    fun `pending child mutation shields book entry from explicit tombstone`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        val entry = bookEntryRecord()
        bookProjection.upsert(database, entry)
        database.local_booksQueries.upsertProgress(
            bookId = BOOK_ID,
            locatorJson = "local-progress",
            progression = 0.8,
            updatedAt = 900,
        )
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "pending-progress-before-delete",
            deviceId = "phone-a",
            scopeId = BOOK_SCOPE_ID,
            entityType = "book.progress",
            entityId = "book.progress::$BOOK_ID",
            operation = "set_progress",
            payloadJson = "{}",
            createdAt = 900,
            nextAttemptAt = 900,
        )

        bookProjection.delete(database, bookEntryTombstone(), entry)

        assertNotNull(database.local_booksQueries.findById(BOOK_ID).executeAsOneOrNull())
        assertEquals(0.8, database.local_booksQueries.findProgress(BOOK_ID).executeAsOne().progression)
    }

    @Test
    fun `pending local book mutation shields local state until Core acknowledges it`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        bookProjection.upsert(database, bookEntryRecord())
        database.local_booksQueries.upsertProgress(
            bookId = BOOK_ID,
            locatorJson = "local-progress",
            progression = 0.8,
            updatedAt = 900,
        )
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "pending-progress",
            deviceId = "phone-a",
            scopeId = BOOK_SCOPE_ID,
            entityType = "book.progress",
            entityId = "book.progress::$BOOK_ID",
            operation = "set_progress",
            payloadJson = "{}",
            createdAt = 900,
            nextAttemptAt = 900,
        )

        bookProjection.upsert(database, bookProgressRecord())

        val progress = database.local_booksQueries.findProgress(BOOK_ID).executeAsOne()
        assertEquals("local-progress", progress.locator_json)
        assertEquals(0.8, progress.progression)
    }

    @Test
    fun `accepted mutation remains shielded until the required replica version is projected`() = runTest {
        val bookProjection = EpigraphCoreDomainProjection(privateBookStorageDirectory = tempDirectory)
        bookProjection.upsert(database, bookEntryRecord())
        database.local_booksQueries.upsertProgress(
            bookId = BOOK_ID,
            locatorJson = "local-progress",
            progression = 0.8,
            updatedAt = 900,
        )
        database.aethon_syncQueries.upsertReceipt("phone-a", "accepted-progress", null, 910)
        database.aethon_syncQueries.upsertReplicaWait(
            deviceId = "phone-a",
            clientMutationId = "accepted-progress",
            scopeId = BOOK_SCOPE_ID,
            entityType = "book.progress",
            entityId = "book.progress::$BOOK_ID",
            canonicalEntityId = null,
            resultStatus = "APPLIED",
            requiredServerVersion = 7,
            appliedLamport = 7,
            eventClockJson = null,
            canonicalRecordSha256 = null,
            receivedAt = 910,
        )
        val store = SqlDelightCoreReplicaStore(
            databaseHandler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            projection = bookProjection,
        )

        store.transaction {
            val staleConfirmation = bookProgressRecord().copy(serverVersion = 6, lamport = 6)
            upsertConfirmed(staleConfirmation)
            projectConfirmed(staleConfirmation)
        }
        assertEquals(0.8, database.local_booksQueries.findProgress(BOOK_ID).executeAsOne().progression)
        assertEquals(1, database.aethon_syncQueries.replicaWaitCount().executeAsOne())

        store.transaction {
            val confirmation = bookProgressRecord().copy(serverVersion = 7, lamport = 7)
            upsertConfirmed(confirmation)
            projectConfirmed(confirmation)
        }
        assertEquals(0.4, database.local_booksQueries.findProgress(BOOK_ID).executeAsOne().progression)
        assertEquals(0, database.aethon_syncQueries.replicaWaitCount().executeAsOne())
    }

    @Test
    fun `an offline folder rename that lost to a newer edit takes the newer name once superseded`() = runTest {
        val folder = insertBooksFolder("Reading", sort = 0)
        val store = SqlDelightCoreReplicaStore(
            databaseHandler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
            projection = projection,
        )
        val key = CoreReplicaKey(SCOPE_ID, "novel.category", "novel-cat-1")
        store.transaction {
            val record = categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "Reading", 0)
            upsertConfirmed(record)
            projectConfirmed(record)
        }
        // The rename made offline is still queued when the newer desktop name arrives.
        database.categoriesQueries.update(id = folder, name = "Phone_Old", sort = null, flags = null, mangaOrder = null)
        database.aethon_syncQueries.enqueueMutation(
            clientMutationId = "offline-rename",
            deviceId = "phone-a",
            scopeId = SCOPE_ID,
            entityType = "novel.category",
            entityId = "novel-cat-1",
            operation = "merge",
            payloadJson = "{}",
            createdAt = 900,
            nextAttemptAt = 900,
        )
        store.transaction {
            val newer = categoryRecord(SCOPE_ID, "novel.category", "novel-cat-1", "Desk_Newer", 0)
                .copy(serverVersion = 5, lamport = 5)
            upsertConfirmed(newer)
            projectConfirmed(newer)
        }
        assertEquals("Phone_Old", database.categoriesQueries.findAll().executeAsList().single { it._id == folder }.name)

        // Core supersedes it with the version of the newer name, which is already held here.
        database.aethon_syncQueries.upsertReceipt("phone-a", "offline-rename", null, 910)
        database.aethon_syncQueries.upsertReplicaWait(
            deviceId = "phone-a",
            clientMutationId = "offline-rename",
            scopeId = SCOPE_ID,
            entityType = "novel.category",
            entityId = "novel-cat-1",
            canonicalEntityId = null,
            resultStatus = "SUPERSEDED",
            requiredServerVersion = 5,
            appliedLamport = 5,
            eventClockJson = null,
            canonicalRecordSha256 = null,
            receivedAt = 910,
        )
        database.aethon_syncQueries.reconcileReplicaWaitWithApplied("phone-a", "offline-rename")
        database.aethon_syncQueries.deleteAcknowledgedMutation("phone-a", "offline-rename")
        store.projectHeldRecord(key)

        assertEquals(0, database.aethon_syncQueries.replicaWaitCount().executeAsOne())
        assertEquals("Desk_Newer", database.categoriesQueries.findAll().executeAsList().single { it._id == folder }.name)
    }

    @Test
    fun `comic tracking applies idempotently to the exact bound work and tombstones remove it`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/Manga/Tracked"))
        val workId = PortableIdentityV3.workId(work)
        val localMangaId = insertTrackingManga(42, "/Manga/Tracked")
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = localMangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Tracked",
                providerLabelHint = "Fixture",
                attemptCount = 1,
                updatedAt = 1,
            ),
        )
        val record = trackingRecord(COMIC_SCOPE_ID, "comic.tracking", "comicId", workId, "anilist")

        projection.upsert(database, record)
        projection.upsert(database, record)

        val stored = database.manga_syncQueries.getAllByMangaId(localMangaId).executeAsList().single()
        assertEquals(2L, stored.sync_id)
        assertEquals(4242L, stored.remote_id)
        assertNull(stored.library_id)
        assertEquals("Tracked title", stored.title)
        assertEquals(12.5, stored.last_chapter_read)
        assertEquals(100L, stored.total_chapters)
        assertEquals(8.0, stored.score)
        assertEquals(1_700_000_000_000L, stored.start_date)

        projection.upsert(
            database,
            trackingRecord(COMIC_SCOPE_ID, "comic.tracking", "comicId", "comic:missing", "anilist"),
        )
        projection.upsert(
            database,
            trackingRecord(COMIC_SCOPE_ID, "comic.tracking", "comicId", workId, "future-tracker"),
        )
        assertEquals(1, database.manga_syncQueries.getAll().executeAsList().size)

        projection.delete(
            database,
            CoreConfirmedTombstone(
                key = record.key,
                serverVersion = 8,
                lamport = 8,
                deletedAtMs = 800,
                reasonCode = "removed",
            ),
            record,
        )
        assertTrue(database.manga_syncQueries.getAllByMangaId(localMangaId).executeAsList().isEmpty())
    }

    @Test
    fun `comic tracking of a work waiting for its extension lands on the Core-served row`() = runTest {
        projection.upsert(database, verifiedCoreEntryRecord(providerKey = "/Manga/Tracked"))
        val coreMangaId = database.mangasQueries.findFavorites().executeAsList().single()._id
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/Manga/Tracked"))
        val workId = PortableIdentityV3.workId(work)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = null,
                resolution = PortableResolution(
                    PortableResolutionState.REQUIRES_USER_ACTION,
                    PortableResolutionReason.EXTENSION_NOT_FOUND,
                ),
                titleHint = "Tracked",
                providerLabelHint = "Fixture",
                attemptCount = 1,
                updatedAt = 1,
            ),
        )

        projection.upsert(database, trackingRecord(COMIC_SCOPE_ID, "comic.tracking", "comicId", workId, "anilist"))

        assertEquals(4242L, database.manga_syncQueries.getAllByMangaId(coreMangaId).executeAsList().single().remote_id)
    }

    @Test
    fun `novel tracking resolves the novel identity and skips malformed records`() = runTest {
        val localMangaId = insertTrackingManga(10002, "/novel/tracked")
        database.aethon_syncQueries.upsertIdentity(
            entityId = "novel:tracked",
            contentType = "NOVEL",
            localReference = localMangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        val record = trackingRecord(SCOPE_ID, "novel.tracking", "novelId", "novel:tracked", "novelupdates")
        val malformed = CoreConfirmedRecord(
            key = CoreReplicaKey(SCOPE_ID, "novel.tracking", "novel.tracking::novel:tracked::hardcover"),
            serverVersion = 7,
            lamport = 7,
            record = buildJsonObject {
                put("novelId", "novel:tracked")
                put("trackerKey", "hardcover")
                put("remoteId", "not-a-number")
            },
        )

        projection.upsert(database, malformed)
        projection.upsert(database, record)

        val stored = database.manga_syncQueries.getAllByMangaId(localMangaId).executeAsList().single()
        assertEquals(10L, stored.sync_id)
        projection.delete(
            database,
            CoreConfirmedTombstone(
                key = record.key,
                serverVersion = 9,
                lamport = 9,
                deletedAtMs = 900,
                reasonCode = "removed",
            ),
            null,
        )
        assertTrue(database.manga_syncQueries.getAllByMangaId(localMangaId).executeAsList().isEmpty())
    }

    private fun trackingRecord(
        scopeId: String,
        entityType: String,
        workKey: String,
        workId: String,
        trackerKey: String,
    ) = CoreConfirmedRecord(
        key = CoreReplicaKey(scopeId, entityType, "$entityType::$workId::$trackerKey"),
        serverVersion = 7,
        lamport = 7,
        record = buildJsonObject {
            put("trackingId", "$entityType::$workId::$trackerKey")
            put(workKey, workId)
            put("trackerKey", trackerKey)
            put("remoteId", "4242")
            put("libraryId", JsonNull)
            put("title", "Tracked title")
            put("remoteUrl", "https://tracker.example/4242")
            put("status", "1")
            put("progress", "12.5")
            put("totalChapters", "100")
            put("score", "8.0")
            put("startedAtMs", "1700000000000")
            put("finishedAtMs", "0")
            put("updatedAtMs", 700)
            put("futureField", "ignored")
        },
    )

    private fun insertTrackingManga(source: Long, url: String): Long {
        database.mangasQueries.insert(
            source = source,
            url = url,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Tracked",
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

    private fun comicEntryRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.entry", COMIC_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("comicId", COMIC_ID)
            put("title", COMIC_TITLE)
            put("url", "https://example.test/manga/epigraph")
            put("sourceId", "42")
            put("author", JsonArray(listOf(JsonPrimitive("future-shape"))))
            put("inLibrary", true)
            put("updatedAtMs", 100)
        },
    )

    private fun verifiedCoreEntryRecord(providerKey: String? = null) = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.entry", VERIFIED_CORE_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("comicId", VERIFIED_CORE_ID)
            put("suwayomiMangaId", "7")
            put("title", "Verified Core comic")
            put("url", "https://source.test/title")
            put("sourceId", "42")
            providerKey?.let { put("providerKey", it) }
            put("inLibrary", true)
            put("updatedAtMs", 100)
        },
    )

    private fun categoryRecord(scopeId: String, entityType: String, entityId: String, name: String, order: Long) =
        CoreConfirmedRecord(
            key = CoreReplicaKey(scopeId, entityType, entityId),
            serverVersion = 1,
            lamport = 1,
            record = buildJsonObject {
                put("name", name)
                put("order", order)
                put("updatedAtMs", 100)
            },
        )

    private fun insertFolder(name: String, sort: Long): Long {
        database.categoriesQueries.insert(name, sort, 0, "a")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    /** A Books & novels folder: Comics folders are never joined by novel or book categories. */
    private fun insertBooksFolder(name: String, sort: Long, scope: String = "NOVEL"): Long =
        insertFolder(name, sort).also { database.aethon_syncQueries.upsertCategoryScope(it, scope) }

    private fun bindFolder(folder: Long, entityId: String, scope: String, name: String, order: Long = 0) {
        database.aethon_syncQueries.upsertCategoryIdentity(entityId, folder, scope, name, order, 1)
    }

    private fun folderScopes(folder: Long): Map<String, String> =
        database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(folder).executeAsList()
            .associate { it.content_scope to it.entity_id }

    private fun comicCategoryRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.category", CATEGORY_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("name", CATEGORY_NAME)
            put("order", 0)
            put("updatedAtMs", 100)
        },
    )

    private fun comicAssignmentRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.category_assignment", ASSIGNMENT_ID),
        serverVersion = 2,
        lamport = 2,
        record = buildJsonObject {
            put("comicId", COMIC_ID)
            put("categoryId", CATEGORY_ID)
        },
    )

    private fun comicChapterStateRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.chapter_state", CHAPTER_STATE_ID),
        serverVersion = 2,
        lamport = 2,
        record = buildJsonObject {
            put("comicId", COMIC_ID)
            put("chapterId", CHAPTER_ID)
            put("url", "https://example.test/manga/epigraph/chapter-1")
            put("title", "Chapter 1")
            put("chapterNumber", 1.0)
            put("pageIndex", 3)
            put("pageCount", 10)
            put("progressPercent", 0.4)
            put("updatedAtMs", 200)
        },
    )

    private fun comicHistoryRecord(
        pageIndex: Int = 4,
        progressPercent: Double = 0.5,
        serverVersion: Long = 3,
    ) = CoreConfirmedRecord(
        key = CoreReplicaKey(COMIC_SCOPE_ID, "comic.history", HISTORY_ID),
        serverVersion = serverVersion,
        lamport = serverVersion,
        record = buildJsonObject {
            put("historyId", HISTORY_ID)
            put("comicId", COMIC_ID)
            put("chapterId", CHAPTER_ID)
            put("pageIndex", pageIndex)
            put("pageCount", 10)
            put("progressPercent", progressPercent)
            put("readAtMs", 100 * serverVersion)
        },
    )

    private fun progressTombstone() = CoreConfirmedTombstone(
        key = CoreReplicaKey(SCOPE_ID, "novel.progress", TECHNICAL_PROGRESS_ID),
        serverVersion = 2,
        lamport = 2,
        deletedAtMs = 200,
        reasonCode = "removed",
    )

    private fun progressRecord(
        progression: Double = 0.5,
        locator: String? = null,
    ) = CoreConfirmedRecord(
        key = CoreReplicaKey(SCOPE_ID, "novel.progress", TECHNICAL_PROGRESS_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("novelId", CANONICAL_NOVEL_ID)
            put("chapterId", "chapter-1")
            put("progressPercent", progression)
            locator?.let { put("locator", it) }
            put("updatedAtMs", 100)
        },
    )

    private fun novelEntryRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(SCOPE_ID, "novel.entry", CANONICAL_NOVEL_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("novelId", CANONICAL_NOVEL_ID)
            put("title", "Epigraph Novel")
            put("path", "/novel/epigraph")
            put("sourceId", "17")
            put("addedAtMs", 100)
            put("updatedAtMs", 100)
        },
    )

    private fun novelChapterRecord(
        unread: Boolean,
        serverVersion: Long = 2,
    ) = CoreConfirmedRecord(
        key = CoreReplicaKey(SCOPE_ID, "novel.chapter", "chapter-1"),
        serverVersion = serverVersion,
        lamport = serverVersion,
        record = buildJsonObject {
            put("novelId", CANONICAL_NOVEL_ID)
            put("path", "/novel/epigraph/chapter-1")
            put("title", "Chapter 1")
            put("chapterOrderKey", 1.0)
            put("releaseTimeMs", 100)
            put("unread", unread)
        },
    )

    private fun novelBookmarkRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(SCOPE_ID, "novel.bookmark", "novel-bookmark:" + "a".repeat(64)),
        serverVersion = 5,
        lamport = 5,
        record = buildJsonObject {
            put("novelId", CANONICAL_NOVEL_ID)
            put("chapterId", "chapter-1")
            put("chapterTitle", "Chapter 1")
            put("chapterOrderKey", 1.0)
            put("locator", "block:8:44")
            put("locatorSortKey", 44.0)
            put("savedAtMs", 500)
        },
    )

    private fun bookEntryRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.entry", BOOK_ID),
        serverVersion = 1,
        lamport = 1,
        record = buildJsonObject {
            put("assetFingerprint", BOOK_SHA)
            put("title", "Epigraph Book")
            put("author", "Epigraph")
            put("subtype", "epub")
            put("mimeType", "application/epub+zip")
            put("byteSize", 1234)
            // Legacy desktop snapshots used zero when structure metadata had not been parsed yet.
            put("sectionCount", 0)
            put("coverPath", "C:\\desktop-private\\cover.png")
            put("coverAssetSha256", BOOK_COVER_SHA)
            put("coverAssetByteSize", BOOK_COVER_BYTES)
            put("coverAssetMimeType", "image/png")
            put("hasCover", true)
            put("createdAtMs", 100)
            put("bookUpdatedAtMs", 200)
        },
    )

    private fun bookEntryTombstone() = CoreConfirmedTombstone(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.entry", BOOK_ID),
        serverVersion = 10,
        lamport = 10,
        deletedAtMs = 1_000,
        reasonCode = "removed",
    )

    private fun bookCategoryRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.category", BOOK_CATEGORY_ID),
        serverVersion = 2,
        lamport = 2,
        record = buildJsonObject {
            put("name", "Reading")
            put("order", 0)
            put("updatedAtMs", 200)
        },
    )

    private fun bookAssignmentRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.category_assignment", BOOK_ID),
        serverVersion = 3,
        lamport = 3,
        record = buildJsonObject {
            put("bookId", BOOK_ID)
            put("categoryIds", JsonArray(listOf(JsonPrimitive(BOOK_CATEGORY_ID))))
        },
    )

    private fun bookProgressRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.progress", "book.progress::$BOOK_ID"),
        serverVersion = 4,
        lamport = 4,
        record = buildJsonObject {
            put("bookId", BOOK_ID)
            put("renderer", "epub")
            put("location", "epubcfi(/6/2)")
            put("progressPercent", 0.4)
            put("lastReadAtMs", 400)
        },
    )

    private fun bookBookmarkRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.bookmark", BOOKMARK_ID),
        serverVersion = 5,
        lamport = 5,
        record = buildJsonObject {
            put("bookId", BOOK_ID)
            put("location", "epubcfi(/6/2)")
            put("progressPercent", 0.4)
            put("label", "Chapter")
            put("note", "Remember this")
            put("savedAtMs", 500)
        },
    )

    private fun bookHighlightRecord() = CoreConfirmedRecord(
        key = CoreReplicaKey(BOOK_SCOPE_ID, "book.highlight", HIGHLIGHT_ID),
        serverVersion = 6,
        lamport = 6,
        record = buildJsonObject {
            put("highlightId", HIGHLIGHT_ID)
            put("bookId", BOOK_ID)
            put(
                "startLocatorJson",
                buildJsonObject {
                    put("type", "epub")
                    put("entityId", BOOK_ID)
                    put("cfi", "epubcfi(/6/2)")
                    put("progression", 0.4)
                },
            )
            put(
                "endLocatorJson",
                buildJsonObject {
                    put("type", "epub")
                    put("entityId", BOOK_ID)
                    put("cfi", "epubcfi(/6/4)")
                    put("progression", 0.45)
                },
            )
            put("selectedText", "Selected text")
            put("colorArgb", 16755285)
            put("note", "Highlight note")
            put("createdAtMs", 500)
            put("updatedAtMs", 600)
        },
    )

    private companion object {
        const val SCOPE_ID = "novels:profile:main"
        const val ORIGIN_SERVER_ID = "desktop-one"
        const val CANONICAL_NOVEL_ID = "novel-1"
        const val TECHNICAL_PROGRESS_ID = "novel.progress::novel-1"
        const val COMIC_SCOPE_ID = "comics:profile:main"
        const val COMIC_ID = "suwayomi:core:manga:comic-1"
        const val COMIC_TITLE = "Epigraph Comic"
        const val CATEGORY_ID = "comic-category-1"
        const val CATEGORY_NAME = "Favorites"
        const val ASSIGNMENT_ID = "comic-assignment-1"
        const val CHAPTER_STATE_ID = "comic-chapter-state-1"
        const val CHAPTER_ID = "chapter-1"
        const val HISTORY_ID = "comic.history::$COMIC_ID"
        const val VERIFIED_CORE_ID = "suwayomi:profile:main:manga:7"
        const val BOOK_SCOPE_ID = "books:global"
        const val BOOK_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val BOOK_COVER_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const val BOOK_COVER_BYTES = 68L
        const val BOOK_ID = "epub:sha256:$BOOK_SHA"
        const val BOOK_CATEGORY_ID = "book-category-1"
        const val BOOKMARK_ID = "book-bookmark-1"
        const val HIGHLIGHT_ID = "book-highlight-1"
    }
}
