package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.Database

class LocalBookChapterStateMigration62Test {
    @Test
    fun `migration 62 adds empty chapter state tables that follow their book`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(null, "CREATE TABLE local_books (book_id TEXT NOT NULL PRIMARY KEY)", 0)
            driver.execute(null, "INSERT INTO local_books VALUES ('book')", 0)

            Database.Schema.migrate(driver, oldVersion = 62, newVersion = 63)
            // Re-running is harmless.
            Database.Schema.migrate(driver, oldVersion = 62, newVersion = 63)

            assertEquals(1L, count(driver, "local_books"))
            assertEquals(0L, count(driver, "local_book_chapter_state"))
            assertEquals(0L, count(driver, "local_book_reading_state"))

            driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            driver.execute(
                null,
                "INSERT INTO local_book_chapter_state (book_id, chapter_index, updated_at) VALUES ('book', 3, 1)",
                0,
            )
            driver.execute(null, "INSERT INTO local_book_reading_state (book_id) VALUES ('book')", 0)
            assertEquals(0L, flagged(driver))

            driver.execute(null, "DELETE FROM local_books", 0)
            assertEquals(0L, count(driver, "local_book_chapter_state"))
            assertEquals(0L, count(driver, "local_book_reading_state"))
        }
    }

    private fun flagged(driver: JdbcSqliteDriver): Long = single(
        driver,
        "SELECT COUNT(*) FROM local_book_chapter_state WHERE bookmark != 0 OR read_override IS NOT NULL",
    )

    private fun count(driver: JdbcSqliteDriver, table: String): Long = single(driver, "SELECT COUNT(*) FROM $table")

    private fun single(driver: JdbcSqliteDriver, sql: String): Long =
        driver.executeQuery(
            null,
            sql,
            { cursor ->
                cursor.next()
                QueryResult.Value(cursor.getLong(0)!!)
            },
            0,
        ).value
}
