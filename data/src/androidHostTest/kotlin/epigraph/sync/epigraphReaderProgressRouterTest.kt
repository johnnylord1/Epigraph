package epigraph.sync

import epigraph.contract.ClientMutationId
import epigraph.contract.DecimalSourceId
import kotlinx.serialization.json.JsonObject
import epigraph.contract.DeviceId
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.SyncScopeId
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphReaderProgressRouterTest {
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
    fun `catalog backed comic progress queues official chapter mutation with confirmation context`() = runTest {
        val mangaId = insertManga()
        val chapterId = insertChapter(mangaId)
        val portableWork = PortableWorkRef.Comic(DecimalSourceId("1"), ProviderOwnedKey("/comic/1"))
        val portableWorkId = PortableIdentityV3.workId(portableWork)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = portableWorkId,
                ref = portableWork,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Example",
                providerLabelHint = "Fixture",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        val router = EpigraphReaderProgressRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone"),
            scopeId = SyncScopeId("novels:profile:main"),
            comicScopeId = SyncScopeId("comics:profile:main"),
            mutationIds = ClientMutationIdFactory {
                ClientMutationId("mutation-${System.nanoTime()}")
            },
        )

        val result = router.setComicProgress(
            localMangaId = mangaId,
            localChapterId = chapterId,
            pageIndex = 3,
            pageCount = 10,
            progression = 0.3,
            read = true,
            bookmarked = true,
            lastPageRead = 5,
            pagesLeft = 5,
        )

        assertTrue(result.emitted)
        val chapter = database.chaptersQueries.getChaptersById(chapterId).executeAsOne()
        assertEquals(true, chapter.read)
        assertEquals(true, chapter.bookmark)
        assertEquals(5, chapter.last_page_read)
        assertEquals(5, chapter.pages_left)
        val queued = database.aethon_syncQueries
            .selectReadyMutations(Long.MAX_VALUE - 1, 10)
            .executeAsList()
        assertEquals(2, queued.size)
        val history = queued.single { it.entity_type == "comic.history" }
        val chapterState = queued.single { it.entity_type == "comic.chapter_state" }
        val payload = Json.parseToJsonElement(history.payload_json).jsonObject
        val locator = payload["command"]!!.jsonObject["locator"]!!.jsonObject
        assertEquals("1", locator["portableWork"]!!.jsonObject["sourceId"]!!.jsonPrimitive.content)
        assertEquals("/comic/1", locator["portableWork"]!!.jsonObject["mangaKey"]!!.jsonPrimitive.content)
        assertEquals(
            "https://source.test/chapter/900",
            locator["portableChapter"]!!.jsonObject["chapterKey"]!!.jsonPrimitive.content,
        )
        assertEquals("comics:profile:main", history.scope_id)
        assertEquals(portableWorkId, history.entity_id)
        val statePayload = Json.parseToJsonElement(chapterState.payload_json).jsonObject
        val state = statePayload["command"]!!.jsonObject["state"]!!.jsonObject
        assertEquals("true", state["read"]!!.jsonPrimitive.content)
        assertEquals("true", state["bookmarked"]!!.jsonPrimitive.content)
        assertEquals("5", state["lastPageRead"]!!.jsonPrimitive.content)
        assertEquals(
            "https://source.test/chapter/900",
            state["portableChapterRef"]!!.jsonObject["chapterKey"]!!.jsonPrimitive.content,
        )
        assertEquals(0, database.aethon_suwayomi_mutation_queueQueries.selectReady(Long.MAX_VALUE - 1, 10).executeAsList().size)
    }

    @Test
    fun `legacy profile identity remains writable after server scoped identity support`() = runTest {
        val mangaId = insertManga()
        val chapterId = insertChapter(mangaId)
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:profile:legacy:manga:8",
            contentType = "MANGA",
            localReference = mangaId.toString(),
            createdAt = 1,
            updatedAt = 1,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = "suwayomi:profile:legacy:chapter:901",
            workEntityId = "suwayomi:profile:legacy:manga:8",
            localChapterId = chapterId,
            normalizedUrl = "https://source.test/chapter/901",
            ordinal = 4.0,
            updatedAt = 1,
        )
        val router = EpigraphReaderProgressRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone"),
            scopeId = SyncScopeId("novels:profile:legacy"),
            mutationIds = ClientMutationIdFactory {
                ClientMutationId("legacy-${System.nanoTime()}")
            },
        )

        val result = router.setComicProgress(
            localMangaId = mangaId,
            localChapterId = chapterId,
            pageIndex = 1,
            pageCount = 5,
            progression = 0.4,
        )

        assertTrue(result.emitted)
        val queued = database.aethon_syncQueries
            .selectReadyMutations(Long.MAX_VALUE - 1, 10)
            .executeAsList()
            .single()
        assertEquals("comics:profile:legacy", queued.scope_id)
        assertEquals("suwayomi:profile:legacy:manga:8", queued.entity_id)
    }

    @Test
    fun `novel progress preserves plugin and provider owned chapter keys`() = runTest {
        val mangaId = insertManga()
        val chapterId = insertChapter(mangaId)
        val portableWork = PortableWorkRef.Novel("lnreader.plugin", ProviderOwnedKey("/novel/KeepCase"))
        val portableWorkId = PortableIdentityV3.workId(portableWork)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = portableWorkId,
                ref = portableWork,
                dependencyKey = "lnreader.plugin",
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Novel",
                providerLabelHint = "LNReader",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        val router = EpigraphReaderProgressRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone"),
            scopeId = SyncScopeId("novels:profile:main"),
            mutationIds = ClientMutationIdFactory { ClientMutationId("novel-${System.nanoTime()}") },
        )

        val result = router.setNovelProgress(mangaId, chapterId, progression = 0.4)

        assertTrue(result.emitted)
        val queued = database.aethon_syncQueries
            .selectReadyMutations(Long.MAX_VALUE - 1, 10)
            .executeAsList()
            .single()
        val locator = Json.parseToJsonElement(queued.payload_json)
            .jsonObject["command"]!!
            .jsonObject["locator"]!!
            .jsonObject
        assertEquals("lnreader.plugin", locator["portableWork"]!!.jsonObject["pluginId"]!!.jsonPrimitive.content)
        assertEquals("/novel/KeepCase", locator["portableWork"]!!.jsonObject["novelKey"]!!.jsonPrimitive.content)
        assertEquals(
            "https://source.test/chapter/900",
            locator["portableChapter"]!!.jsonObject["chapterKey"]!!.jsonPrimitive.content,
        )
        assertEquals(portableWorkId, queued.entity_id)
    }

    @Test
    fun `novel read bookmark and exact locator share one atomic outbox batch`() = runTest {
        val mangaId = insertManga()
        val chapterId = insertChapter(mangaId)
        val portableWork = PortableWorkRef.Novel("lnreader.plugin", ProviderOwnedKey("/novel/Atomic"))
        val portableWorkId = PortableIdentityV3.workId(portableWork)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = portableWorkId,
                ref = portableWork,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Atomic",
                providerLabelHint = "Fixture",
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
        var mutationNumber = 0
        val router = EpigraphReaderProgressRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone"),
            scopeId = SyncScopeId("novels:profile:main"),
            mutationIds = ClientMutationIdFactory { ClientMutationId("novel-state-${++mutationNumber}") },
            clock = { 2_000 },
        )

        val result = router.setNovelProgress(
            localMangaId = mangaId,
            localChapterId = chapterId,
            progression = 0.4,
            blockIndex = 7,
            textOffset = 31,
            read = true,
            bookmarked = true,
            lastPageRead = 40,
            pagesLeft = 60,
        )

        assertTrue(result.emitted)
        val chapter = database.chaptersQueries.getChaptersById(chapterId).executeAsOne()
        assertTrue(chapter.read)
        assertTrue(chapter.bookmark)
        val queued = database.aethon_syncQueries
            .selectReadyMutations(Long.MAX_VALUE - 1, 10)
            .executeAsList()
        assertEquals(setOf("novel.progress", "novel.chapter", "novel.bookmark"), queued.map { it.entity_type }.toSet())
        val chapterState = Json.parseToJsonElement(queued.single { it.entity_type == "novel.chapter" }.payload_json)
            .jsonObject["command"]!!.jsonObject
        assertEquals("false", chapterState["unread"]!!.jsonPrimitive.content)
        assertEquals("Chapter 3", chapterState["title"]!!.jsonPrimitive.content)
        val bookmark = queued.single { it.entity_type == "novel.bookmark" }
        assertTrue(bookmark.entity_id.startsWith("novel-bookmark:"))
        assertEquals(79, bookmark.entity_id.length)

        val locator = router.getNovelLocator(mangaId, chapterId)
        assertEquals(7, locator?.blockIndex)
        assertEquals(31, locator?.textOffset)
        assertEquals(0.4, locator?.progression)
        assertEquals(result.chapterEntityId, locator?.chapterId)
    }

    private fun insertManga(): Long {
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

    private fun insertChapter(mangaId: Long): Long {
        database.chaptersQueries.insert(
            mangaId = mangaId,
            url = "https://source.test/chapter/900",
            name = "Chapter 3",
            scanlator = null,
            read = false,
            bookmark = false,
            lastPageRead = 0,
            pagesLeft = 10,
            chapterNumber = 3.0,
            sourceOrder = 0,
            dateFetch = 1,
            dateUpload = 1,
            memo = JsonObject(emptyMap()),
        )
        return database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
    }
}
