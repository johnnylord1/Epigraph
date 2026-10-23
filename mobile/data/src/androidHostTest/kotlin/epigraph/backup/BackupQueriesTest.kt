package epigraph.backup

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

/** The single-query reads backups use instead of one lookup per history row. */
class BackupQueriesTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `history of one manga comes with its chapter urls and only that manga`() {
        insertManga(1)
        insertManga(2)
        insertChapter(id = 10, mangaId = 1, url = "/a/1")
        insertChapter(id = 11, mangaId = 1, url = "/a/2")
        insertChapter(id = 20, mangaId = 2, url = "/b/1")
        sql("INSERT INTO history(history_chapter_id, history_last_read, history_time_read) VALUES (10, 100, 5)")
        sql("INSERT INTO history(history_chapter_id, history_last_read, history_time_read) VALUES (11, NULL, NULL)")
        sql("INSERT INTO history(history_chapter_id, history_last_read, history_time_read) VALUES (20, 300, 7)")

        val history = database.historyQueries
            .getBackupByMangaId(1) { url, lastRead, timeRead -> Triple(url, lastRead, timeRead) }
            .executeAsList()
            .sortedBy { it.first }

        assertEquals(listOf(Triple("/a/1", 100L, 5L), Triple("/a/2", null, null)), history)
    }

    @Test
    fun `backup chapters include those the scanlator filter would hide`() {
        insertManga(1)
        insertChapter(id = 10, mangaId = 1, url = "/a/1", scanlator = "Kept")
        insertChapter(id = 11, mangaId = 1, url = "/a/2", scanlator = "Filtered")
        sql("UPDATE mangas SET filtered_scanlators = 'Filtered' WHERE _id = 1")

        val urls = database.chaptersQueries.getBackupChaptersByMangaId(1).executeAsList().map { it.url }.sorted()

        assertEquals(listOf("/a/1", "/a/2"), urls)
    }

    private fun insertManga(id: Long) = sql(
        "INSERT INTO mangas(_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags) " +
            "VALUES ($id, 1, '/m/$id', 'Manga $id', 0, 1, 1, 0, 0, 0)",
    )

    private fun insertChapter(id: Long, mangaId: Long, url: String, scanlator: String? = null) = sql(
        "INSERT INTO chapters(_id, manga_id, url, name, scanlator, read, bookmark, last_page_read, pages_left, " +
            "chapter_number, source_order, date_fetch, date_upload) " +
            "VALUES ($id, $mangaId, '$url', 'Chapter', ${scanlator?.let { "'$it'" } ?: "NULL"}, 0, 0, 0, 0, 1, 0, 0, 0)",
    )

    private fun sql(statement: String) {
        driver.execute(null, statement, 0)
    }
}
