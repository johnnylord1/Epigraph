package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.BookEntrySnapshot
import epigraph.contract.ClientMutationId
import epigraph.contract.ContentType
import epigraph.contract.DeviceId
import epigraph.contract.ReaderLocator
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.operationWireName
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class EpigraphBookMutationRouterTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val coordinator = EpigraphMutationCoordinator(
        AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO),
    )
    private var mutationSequence = 0
    private val router = EpigraphBookMutationRouter(
        coordinator = coordinator,
        deviceId = DeviceId("phone-a"),
        mutationIds = ClientMutationIdFactory { ClientMutationId("book-${++mutationSequence}") },
        clock = { 1_000 },
    )
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `book writes and outbox commands commit as one transaction`() = runTest {
        router.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        val categoryId = insertCategory("Favorites", 0)
        router.setCategory(BOOK_ID.value, categoryId, enabled = true)
        router.saveProgress(
            BOOK_ID.value,
            ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/2)", 0.4),
        )
        router.upsertBookmark(
            BookBookmarkMutation(
                bookmarkId = "bookmark-1",
                bookId = BOOK_ID.value,
                locator = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/4)", 0.5),
                label = "Chapter",
                note = "Note",
                createdAtEpochMillis = 1_100,
                updatedAtEpochMillis = 1_200,
            ),
        )
        router.upsertHighlight(
            BookHighlightMutation(
                highlightId = "highlight-1",
                bookId = BOOK_ID.value,
                start = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/4)", 0.5),
                end = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/6)", 0.55),
                selectedText = "Selected text",
                colorArgb = 0xffaa55,
                note = "Highlight note",
                createdAtEpochMillis = 1_300,
                updatedAtEpochMillis = 1_400,
            ),
        )

        assertNotNull(database.local_booksQueries.findById(BOOK_ID.value).executeAsOneOrNull())
        assertEquals(1, database.local_booksQueries.findCategoryIds(BOOK_ID.value).executeAsList().size)
        assertEquals(1, database.local_booksQueries.findBookmarks(BOOK_ID.value).executeAsList().size)
        assertEquals(1, database.local_booksQueries.findHighlights(BOOK_ID.value).executeAsList().size)
        val publication = database.aethon_syncQueries.selectAssetManifest(BOOK_HASH).executeAsOne()
        assertEquals("PENDING_UPLOAD", publication.state)
        assertEquals(false, publication.remote_available)
        assertEquals("/private/$BOOK_HASH.epub", publication.local_uri)
        val assetLink = database.aethon_syncQueries.selectEntityAssets(BOOK_ID.value).executeAsOne()
        assertEquals(BOOK_HASH, assetLink.sha256)
        assertEquals("PUBLICATION", assetLink.role)

        val rows = database.aethon_syncQueries.selectReadyMutations(2_000, 20).executeAsList()
        assertEquals(6, rows.size)
        assertEquals(
            listOf(
                "upsert_book_entry",
                "upsert_category",
                "set_book_category_assignments",
                "set_progress",
                "upsert_book_bookmark",
                "upsert_book_highlight",
            ),
            rows.map { row -> json.decodeFromString<SyncCommandEnvelope>(row.payload_json).command.operationWireName() },
        )
    }

    @Test
    fun `PDF progress without document progression changes neither state nor outbox`() = runTest {
        val pdfHash = "b".repeat(64)
        val pdfId = EpigraphEntityId("pdf:sha256:$pdfHash")
        router.publish(
            snapshot(
                bookId = pdfId,
                contentType = ContentType.PDF,
                sha256 = pdfHash,
                mimeType = "application/pdf",
            ),
            "/private/$pdfHash.pdf",
            null,
        )
        val before = coordinator.pendingCount()

        val failure = runCatching {
            router.saveProgress(pdfId.value, ReaderLocator.Pdf(pdfId, pageIndex = 2))
        }.exceptionOrNull()
        assertInstanceOf(IllegalStateException::class.java, failure)

        assertEquals(before, coordinator.pendingCount())
        assertEquals(null, database.local_booksQueries.findProgress(pdfId.value).executeAsOneOrNull())
    }

    @Test
    fun `latest unattempted book progress replaces the stale offline position`() = runTest {
        router.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        router.saveProgress(
            BOOK_ID.value,
            ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/2)", 0.2),
        )
        router.saveProgress(
            BOOK_ID.value,
            ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/8)", 0.8),
        )

        val progressRows = database.aethon_syncQueries
            .selectReadyMutations(2_000, 20)
            .executeAsList()
            .filter { it.entity_type == "book.progress" }

        assertEquals(1, progressRows.size)
        val envelope = json.decodeFromString<SyncCommandEnvelope>(progressRows.single().payload_json)
        val progress = assertInstanceOf(SyncCommand.SetProgress::class.java, envelope.command)
        assertEquals(0.8, (progress.locator as ReaderLocator.Epub).progression)
        assertEquals(0.8, database.local_booksQueries.findProgress(BOOK_ID.value).executeAsOne().progression)
    }

    @Test
    fun `older progress callback cannot overwrite a newer reader position`() = runTest {
        var now = 1_000L
        val timestampedRouter = EpigraphBookMutationRouter(
            coordinator = coordinator,
            deviceId = DeviceId("phone-a"),
            mutationIds = ClientMutationIdFactory { ClientMutationId("ordered-${++mutationSequence}") },
            clock = { now },
        )
        timestampedRouter.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        now = 3_000L
        timestampedRouter.saveProgress(
            BOOK_ID.value,
            ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/8)", 0.8),
        )
        now = 2_000L
        timestampedRouter.saveProgress(
            BOOK_ID.value,
            ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/2)", 0.2),
        )

        val progressRows = database.aethon_syncQueries
            .selectReadyMutations(4_000, 20)
            .executeAsList()
            .filter { it.entity_type == "book.progress" }
        val envelope = json.decodeFromString<SyncCommandEnvelope>(progressRows.single().payload_json)
        val progress = assertInstanceOf(SyncCommand.SetProgress::class.java, envelope.command)

        assertEquals(0.8, (progress.locator as ReaderLocator.Epub).progression)
        assertEquals(0.8, database.local_booksQueries.findProgress(BOOK_ID.value).executeAsOne().progression)
    }

    @Test
    fun `discovered book structure updates metadata without resetting asset state`() = runTest {
        router.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        database.aethon_syncQueries.updateAssetMaterialization(
            localUri = "/private/$BOOK_HASH.epub",
            remoteAvailable = true,
            state = "AVAILABLE",
            updatedAt = 1_500,
            sha256 = BOOK_HASH,
            contentType = ContentType.EPUB.name,
            byteSize = 123,
            mimeType = "application/epub+zip",
        )
        val initialOutboxCount = coordinator.pendingCount()

        router.saveStructure(BOOK_ID.value, chapterCount = 29, pageCount = null)

        val book = database.local_booksQueries.findById(BOOK_ID.value).executeAsOne()
        assertEquals(29L, book.chapter_count)
        val asset = database.aethon_syncQueries.selectAssetManifest(BOOK_HASH).executeAsOne()
        assertEquals("AVAILABLE", asset.state)
        assertEquals(true, asset.remote_available)
        assertEquals(initialOutboxCount, coordinator.pendingCount())
        val structureRow = database.aethon_syncQueries.selectReadyMutations(2_000, 20)
            .executeAsList()
            .last()
        val envelope = json.decodeFromString<SyncCommandEnvelope>(structureRow.payload_json)
        val command = assertInstanceOf(SyncCommand.UpsertBookEntry::class.java, envelope.command)
        assertEquals(29, command.entry.chapterCount)
    }

    @Test
    fun `unchanged book structure does not enqueue duplicate metadata`() = runTest {
        router.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        router.saveStructure(BOOK_ID.value, chapterCount = 29, pageCount = null)
        val pending = coordinator.pendingCount()

        router.saveStructure(BOOK_ID.value, chapterCount = 29, pageCount = null)

        assertEquals(pending, coordinator.pendingCount())
    }

    @Test
    fun `local structure repairs an older confirmed Core entry`() = runTest {
        router.publish(snapshot(), "/private/$BOOK_HASH.epub", coverPath = null)
        router.saveStructure(BOOK_ID.value, chapterCount = 29, pageCount = null)
        database.aethon_syncQueries.deleteUnattemptedMutationForEntity(
            deviceId = "phone-a",
            scopeId = "books:global",
            entityType = "book.entry",
            entityId = BOOK_ID.value,
        )
        database.aethon_syncQueries.upsertCoreReplicaRecord(
            scopeId = "books:global",
            entityType = "book.entry",
            entityId = BOOK_ID.value,
            serverVersion = 10,
            lamport = 10,
            recordJson = """{"tocCount":1,"spineCount":1,"sectionCount":1}""",
            payloadSha256 = "c".repeat(64),
        )

        router.saveStructure(BOOK_ID.value, chapterCount = 29, pageCount = null)

        assertEquals(1, coordinator.pendingCount())
        val row = database.aethon_syncQueries.selectReadyMutations(2_000, 20).executeAsOne()
        val envelope = json.decodeFromString<SyncCommandEnvelope>(row.payload_json)
        val command = assertInstanceOf(SyncCommand.UpsertBookEntry::class.java, envelope.command)
        assertEquals(29, command.entry.chapterCount)
    }

    private fun insertCategory(name: String, sort: Long): Long {
        database.categoriesQueries.insert(name, sort, flags = 0, mangaOrder = "")
        return database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
    }

    private fun snapshot(
        bookId: EpigraphEntityId = BOOK_ID,
        contentType: ContentType = ContentType.EPUB,
        sha256: String = BOOK_HASH,
        mimeType: String = "application/epub+zip",
    ) = BookEntrySnapshot(
        bookId = bookId,
        contentType = contentType,
        sha256 = sha256,
        title = "Example book",
        author = "Author",
        description = "Description",
        mimeType = mimeType,
        byteSize = 123,
        createdAtEpochMillis = 100,
        updatedAtEpochMillis = 100,
    )

    private companion object {
        const val BOOK_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        val BOOK_ID = EpigraphEntityId("epub:sha256:$BOOK_HASH")
    }
}
