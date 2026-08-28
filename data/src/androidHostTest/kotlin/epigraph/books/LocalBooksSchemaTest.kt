package epigraph.books
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import yokai.data.Database

/** Verifies the local publication tables independently of the sync schema. */
class LocalBooksSchemaTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val queries = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter)).local_booksQueries

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `epub and pdf identities are content addressed and progress is replaceable`() {
        queries.insert(
            bookId = "epub-${"a".repeat(64)}",
            contentType = "EPUB",
            sha256 = "a".repeat(64),
            displayName = "A book",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "/private/epub",
            mimeType = "application/epub+zip",
            byteSize = 10,
            chapterCount = null,
            pageCount = null,
            importedAt = 1,
            updatedAt = 1,
        )
        queries.insert(
            bookId = "pdf-${"b".repeat(64)}",
            contentType = "PDF",
            sha256 = "b".repeat(64),
            displayName = "A PDF",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "/private/pdf",
            mimeType = "application/pdf",
            byteSize = 20,
            chapterCount = null,
            pageCount = null,
            importedAt = 2,
            updatedAt = 2,
        )

        assertEquals(2L, queries.findAll().executeAsList().size.toLong())
        assertNotNull(queries.findBySha256("a".repeat(64)).executeAsOneOrNull())

        queries.upsertProgress("epub-${"a".repeat(64)}", "{\"cfi\":\"aethon-spine:1\"}", 0.5, 3)
        queries.upsertProgress("epub-${"a".repeat(64)}", "{\"cfi\":\"aethon-spine:2\"}", 0.75, 4)

        val progress = queries.findProgress("epub-${"a".repeat(64)}").executeAsOne()
        assertEquals("{\"cfi\":\"aethon-spine:2\"}", progress.locator_json)
        assertEquals(0.75, progress.progression)
    }

    @Test
    fun `book annotations are scoped by book`() {
        val bookId = "pdf-${"c".repeat(64)}"
        queries.insert(
            bookId = bookId,
            contentType = "PDF",
            sha256 = "c".repeat(64),
            displayName = "Notes",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "/private/notes",
            mimeType = "application/pdf",
            byteSize = 3,
            chapterCount = null,
            pageCount = null,
            importedAt = 1,
            updatedAt = 1,
        )
        queries.insertBookmark("bookmark", bookId, "{\"page\":1}", "Page one", null, 1, 2)
        queries.insertHighlight("highlight", bookId, "{\"page\":1}", "{\"page\":1}", "selected", 0xff00ff00, null, 1, 2)

        assertEquals(1, queries.findBookmarks(bookId).executeAsList().size)
        assertEquals(1, queries.findHighlights(bookId).executeAsList().size)
        assertEquals(0, queries.findBookmarks("pdf-${"d".repeat(64)}").executeAsList().size)
    }
}
