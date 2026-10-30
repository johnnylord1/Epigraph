package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class ChapterBindingLocalIndexMigration60Test {
    @Test
    fun `migration 60 adds the local chapter index and keeps rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                null,
                "CREATE TABLE aethon_chapter_binding (chapter_entity_id TEXT PRIMARY KEY, work_entity_id TEXT, local_chapter_id INTEGER)",
                0,
            )
            driver.execute(null, "INSERT INTO aethon_chapter_binding VALUES ('c1', 'w1', 7)", 0)

            Database.Schema.migrate(driver, oldVersion = 60, newVersion = 61)
            // Re-running is harmless (CREATE INDEX IF NOT EXISTS).
            Database.Schema.migrate(driver, oldVersion = 60, newVersion = 61)

            assertTrue(indexes(driver).contains(LOCAL_CHAPTER_INDEX))
            assertEquals(1L, count(driver, "aethon_chapter_binding"))
        }
    }

    @Test
    fun `fresh schema has the index and the chapter lookup uses it`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)

            assertTrue(indexes(driver).contains(LOCAL_CHAPTER_INDEX))
            assertTrue(
                plan(driver, "SELECT * FROM aethon_chapter_binding WHERE local_chapter_id = 1")
                    .contains(LOCAL_CHAPTER_INDEX),
            )
        }
    }

    private fun indexes(driver: JdbcSqliteDriver): Set<String> =
        driver.executeQuery(
            null,
            "SELECT name FROM sqlite_master WHERE type = 'index'",
            { cursor ->
                QueryResult.Value(
                    buildSet {
                        while (cursor.next().value) add(cursor.getString(0)!!)
                    },
                )
            },
            0,
        ).value

    private fun count(driver: JdbcSqliteDriver, table: String): Long =
        driver.executeQuery(
            null,
            "SELECT count(*) FROM $table",
            { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getLong(0)!! else 0L) },
            0,
        ).value

    private fun plan(driver: JdbcSqliteDriver, sql: String): String =
        driver.executeQuery(
            null,
            "EXPLAIN QUERY PLAN $sql",
            { cursor ->
                QueryResult.Value(
                    buildList {
                        while (cursor.next().value) add(cursor.getString(3).orEmpty())
                    }.joinToString("\n"),
                )
            },
            0,
        ).value

    private companion object {
        const val LOCAL_CHAPTER_INDEX = "aethon_chapter_binding_local_chapter_index"
    }
}
