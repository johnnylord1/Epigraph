package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.Database

class LocalBookPdfOutlineMigration63Test {
    @Test
    fun `migration 63 adds an empty outline table that follows its book`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(null, "CREATE TABLE local_books (book_id TEXT NOT NULL PRIMARY KEY)", 0)
            driver.execute(null, "INSERT INTO local_books VALUES ('book')", 0)

            Database.Schema.migrate(driver, oldVersion = 63, newVersion = 64)
            // Re-running is harmless.
            Database.Schema.migrate(driver, oldVersion = 63, newVersion = 64)

            assertEquals(1L, count(driver, "local_books"))
            assertEquals(0L, count(driver, "local_book_pdf_outline"))

            driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            driver.execute(null, "INSERT INTO local_book_pdf_outline VALUES ('book', '[]')", 0)
            assertEquals(1L, count(driver, "local_book_pdf_outline"))

            driver.execute(null, "DELETE FROM local_books", 0)
            assertEquals(0L, count(driver, "local_book_pdf_outline"))
        }
    }

    private fun count(driver: JdbcSqliteDriver, table: String): Long =
        driver.executeQuery(
            null,
            "SELECT COUNT(*) FROM $table",
            { cursor ->
                cursor.next()
                QueryResult.Value(cursor.getLong(0)!!)
            },
            0,
        ).value
}
