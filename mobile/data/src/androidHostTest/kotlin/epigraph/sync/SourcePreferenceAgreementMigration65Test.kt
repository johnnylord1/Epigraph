package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class SourcePreferenceAgreementMigration65Test {
    @Test
    fun `migration 65 adds the agreement table and can run again`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.migrate(driver, oldVersion = 65, newVersion = 66)
            driver.execute(
                null,
                "INSERT INTO epigraph_source_preference_agreement VALUES ('s', 'e', 'string:\"1\"', 3, 10)",
                0,
            )
            // Re-running is harmless (CREATE TABLE IF NOT EXISTS) and keeps the rows.
            Database.Schema.migrate(driver, oldVersion = 65, newVersion = 66)

            assertTrue(TABLE in tables(driver))
            assertEquals(1L, count(driver))
        }
    }

    @Test
    fun `fresh schema has the agreement table`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)
            assertTrue(TABLE in tables(driver))
        }
    }

    private fun tables(driver: JdbcSqliteDriver): Set<String> =
        driver.executeQuery(
            null,
            "SELECT name FROM sqlite_master WHERE type = 'table'",
            { cursor ->
                QueryResult.Value(
                    buildSet {
                        while (cursor.next().value) add(cursor.getString(0)!!)
                    },
                )
            },
            0,
        ).value

    private fun count(driver: JdbcSqliteDriver): Long =
        driver.executeQuery(
            null,
            "SELECT count(*) FROM $TABLE",
            { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getLong(0)!! else 0L) },
            0,
        ).value

    private companion object {
        const val TABLE = "epigraph_source_preference_agreement"
    }
}
