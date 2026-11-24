package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ReaderLocator
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import java.io.File

class V4BookDomainBridgeTest {
    @Test
    fun `book and novel folders stay separate from same named comics category`(@TempDir root: File) = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            Database.Schema.create(driver)
            val db = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
            db.categoriesQueries.insert("Completed", 0, 0, "")
            val comicId = db.categoriesQueries.selectLastInsertedRowId().executeAsOne()
            val handler = AndroidDatabaseHandler(db, driver)
            val bookBridge = V4BookDomainBridge(handler, root)
            val novelBridge = V4NovelDomainBridge(handler) { emptyMap() }
            val bookCategory = V4WireRecord(1, "books", "book.category", "completed", false, V4Hlc(1, 0, "desktop"), "desktop", buildJsonObject {
                put("name", "Completed")
                put("order", 0)
            }, 1)
            val novelCategory = V4WireRecord(2, "novels", "novel.category", "completed", false, V4Hlc(2, 0, "desktop"), "desktop", buildJsonObject {
                put("name", "Completed")
                put("order", 0)
            }, 2)

            bookBridge.applyRemoteRecords("core", "main", listOf(bookCategory))
            novelBridge.applyRemoteRecords("core", "main", listOf(novelCategory))

            val comics = db.categoriesQueries.findAllComics().executeAsList()
            val booksAndNovels = db.categoriesQueries.findAllBooks().executeAsList()
            assertEquals(listOf("Completed"), comics.map { it.name })
            assertEquals(1, booksAndNovels.count { it.name == "Completed" })
            assertNotEquals(comicId, booksAndNovels.single { it.name == "Completed" }._id)
        }
    }

    @Test
    fun `partial or invalid cover metadata is ignored without rejecting the book record`() {
        val hash = "a".repeat(64)
        assertNull(parseV4BookCoverMetadata(hash, null, "image/png"))
        assertNull(parseV4BookCoverMetadata(hash, 0, "image/png"))
        assertNull(parseV4BookCoverMetadata(hash, 32, "image/gif"))
        assertNull(parseV4BookCoverMetadata("A".repeat(64), 32, "image/png"))
        assertEquals(V4BookCoverMetadata(hash, 32, "image/png"), parseV4BookCoverMetadata(hash, 32, "image/png"))
    }

    @Test
    fun `desktop EPUB and PDF locator JSON matches Android ReaderLocator serializers`() {
        val epub = buildJsonObject {
            put("type", "epub")
            put("entityId", "desktop-epub")
            put("cfi", "epubcfi(/6/2)")
            put("href", "Text/chapter-1.xhtml")
            put("progression", 0.4)
        }
        val pdf = buildJsonObject {
            put("type", "pdf")
            put("entityId", "desktop-pdf")
            put("pageIndex", 4)
            put("pageOffset", 0.25)
            put("characterOffset", 8)
            put("totalPages", 10)
            put("documentProgression", 0.5)
        }

        val epubLocator = V4CoreHttpClient.DEFAULT_JSON.decodeFromJsonElement(ReaderLocator.serializer(), epub)
        val pdfLocator = V4CoreHttpClient.DEFAULT_JSON.decodeFromJsonElement(ReaderLocator.serializer(), pdf)
        assertEquals(ReaderLocator.Epub(EpigraphEntityId("desktop-epub"), "epubcfi(/6/2)", 0.4, "Text/chapter-1.xhtml"), epubLocator)
        assertEquals(epub, V4CoreHttpClient.DEFAULT_JSON.encodeToJsonElement(ReaderLocator.serializer(), epubLocator))
        assertEquals(ReaderLocator.Pdf(EpigraphEntityId("desktop-pdf"), 4, 0.25, 8, 10, 0.5), pdfLocator)
    }

    @Test
    fun `unbound book tombstone preserves an existing local book and ignores its child tombstone`(@TempDir root: File) = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            Database.Schema.create(driver)
            val db = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
            val hash = "c".repeat(64)
            db.local_booksQueries.insert(
                bookId = "epub:sha256:$hash", contentType = "EPUB", sha256 = hash,
                displayName = "Local book", author = null, description = null, coverPath = null,
                coverAssetSha256 = null, coverAssetByteSize = null, coverAssetMimeType = null,
                privatePath = root.resolve("local.epub").absolutePath, mimeType = "application/epub+zip",
                byteSize = 10, chapterCount = null, pageCount = null, importedAt = 1, updatedAt = 1,
            )
            val bridge = V4BookDomainBridge(AndroidDatabaseHandler(db, driver), root)
            val tombstone = V4WireRecord(1, "books", "book.work", hash, true, V4Hlc(10, 0, "desktop"), "desktop", JsonNull, 10)
            val childTombstone = V4WireRecord(2, "books", "book.bookmark", "$hash|old", true, V4Hlc(11, 0, "desktop"), "desktop", JsonNull, 11)

            bridge.applyRemoteRecords("core", "main", listOf(tombstone, childTombstone))

            assertNotNull(db.local_booksQueries.findBySha256(hash).executeAsOneOrNull())
        }
    }

    @Test
    fun `preserved unbound local book keeps progress and bookmarks when child tombstones arrive in a later batch`(@TempDir root: File) = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            Database.Schema.create(driver)
            val db = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
            val hash = "e".repeat(64)
            val bookId = "epub:sha256:$hash"
            db.local_booksQueries.insert(
                bookId = bookId, contentType = "EPUB", sha256 = hash,
                displayName = "Local book", author = null, description = null, coverPath = null,
                coverAssetSha256 = null, coverAssetByteSize = null, coverAssetMimeType = null,
                privatePath = root.resolve("local.epub").absolutePath, mimeType = "application/epub+zip",
                byteSize = 10, chapterCount = null, pageCount = null, importedAt = 1, updatedAt = 1,
            )
            val locatorJson = V4CoreHttpClient.DEFAULT_JSON.encodeToString(
                ReaderLocator.serializer(),
                ReaderLocator.Epub(EpigraphEntityId(bookId), "epubcfi(/6/2)", 0.4, "ch1.xhtml"),
            )
            db.local_booksQueries.upsertProgress(bookId, locatorJson, 0.4, 100L)
            db.local_booksQueries.upsertBookmark("bm-1", bookId, locatorJson, "Bm", null, 100L, 100L)

            val bridge = V4BookDomainBridge(AndroidDatabaseHandler(db, driver), root)
            val workTombstone = V4WireRecord(1, "books", "book.work", hash, true, V4Hlc(10, 0, "desktop"), "desktop", JsonNull, 10)
            bridge.applyRemoteRecords("core", "main", listOf(workTombstone))

            val progressTombstone = V4WireRecord(2, "books", "book.progress", hash, true, V4Hlc(11, 0, "desktop"), "desktop", JsonNull, 11)
            val bookmarkTombstone = V4WireRecord(3, "books", "book.bookmark", "$hash|bm-1", true, V4Hlc(12, 0, "desktop"), "desktop", JsonNull, 12)
            bridge.applyRemoteRecords("core", "main", listOf(progressTombstone, bookmarkTombstone))

            assertNotNull(db.local_booksQueries.findBySha256(hash).executeAsOneOrNull())
            assertNotNull(db.local_booksQueries.findProgress(bookId).executeAsOneOrNull())
            assertEquals(1, db.local_booksQueries.findBookmarks(bookId).executeAsList().size)
        }
    }

    @Test
    fun `PDF state round trips through local reader tables and deletes cleanly`(@TempDir root: File) = runTest {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            Database.Schema.create(driver)
            val db = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
            val bridge = V4BookDomainBridge(AndroidDatabaseHandler(db, driver), root)
            val hash = "a".repeat(64)
            val locator = buildJsonObject {
                put("type", "pdf")
                put("entityId", "desktop-book")
                put("pageIndex", 5)
                put("documentProgression", 0.5)
            }
            val payloads = listOf(
                Triple("book.work", hash, buildJsonObject {
                    put("fileSha256", hash)
                    put("subtype", "pdf")
                    put("title", "Example")
                    put("pageCount", 10)
                    put("coverSha256", "b".repeat(64))
                }),
                Triple("book.progress", hash, buildJsonObject {
                    put("locator", locator)
                    put("progressPercent", 0.5)
                }),
                Triple("book.bookmark", "$hash|bookmark", buildJsonObject { put("locator", locator) }),
                Triple("book.category", "reference", buildJsonObject { put("name", "Reference") }),
                Triple("book.category_assignment", "$hash|reference", buildJsonObject { put("categoryKey", "reference") }),
                Triple("book.highlight", "$hash|highlight", buildJsonObject {
                    put("startLocator", locator)
                    put("endLocator", locator)
                    put("selectedText", "Example text")
                }),
            )
            val records = payloads.mapIndexed { index, (type, key, payload) ->
                val seq = index + 1L
                V4WireRecord(seq, "books", type, key, false, V4Hlc(seq, 0, "desktop"), "desktop", payload, seq)
            }
            bridge.applyRemoteRecords("core", "main", records.reversed())
            val book = db.local_booksQueries.findBySha256(hash).executeAsOne()
            assertEquals(File(File(root, "pdf"), "$hash.pdf").absolutePath, book.private_path)
            assertEquals(0.5, db.local_booksQueries.findProgress(book.book_id).executeAsOne().progression)
            assertEquals(1, db.local_booksQueries.findBookmarks(book.book_id).executeAsList().size)
            assertEquals(1, db.local_booksQueries.findHighlights(book.book_id).executeAsList().size)
            assertEquals(1, db.local_booksQueries.findCategoryIds(book.book_id).executeAsList().size)
            val exported = bridge.exportLocalSnapshot("core", "main", V4HlcClock("phone"))
            assertEquals(payloads.map { it.first to it.second }.toSet(), exported.map { it.entityType to it.entityKey }.toSet())

            val deleted = records.first().copy(serverSeq = 10, hlc = V4Hlc(10, 0, "desktop"), deleted = true, payload = JsonNull)
            bridge.applyRemoteRecords("core", "main", listOf(deleted) + records)
            assertNull(db.local_booksQueries.findBySha256(hash).executeAsOneOrNull())
            assertNull(db.local_booksQueries.findProgress(book.book_id).executeAsOneOrNull())
            assertEquals(emptyList<Any>(), db.local_booksQueries.findBookmarks(book.book_id).executeAsList())
        }
    }
}
