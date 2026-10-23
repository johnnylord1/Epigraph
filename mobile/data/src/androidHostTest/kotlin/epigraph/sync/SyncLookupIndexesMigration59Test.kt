package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class SyncLookupIndexesMigration59Test {
    @Test
    fun `migration 59 adds the backfill lookup indexes and keeps rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(null, "CREATE TABLE aethon_portable_work_binding (portable_id TEXT PRIMARY KEY, local_reference TEXT)", 0)
            driver.execute(null, "CREATE TABLE aethon_portable_chapter_binding (portable_chapter_id TEXT PRIMARY KEY, local_reference TEXT)", 0)
            driver.execute(
                null,
                "CREATE TABLE aethon_sync_outbox (id INTEGER PRIMARY KEY, scope_id TEXT, entity_type TEXT, entity_id TEXT)",
                0,
            )
            driver.execute(null, "INSERT INTO aethon_portable_work_binding VALUES ('w1', '7')", 0)

            Database.Schema.migrate(driver, oldVersion = 59, newVersion = 60)
            // Re-running is harmless (CREATE INDEX IF NOT EXISTS).
            Database.Schema.migrate(driver, oldVersion = 59, newVersion = 60)

            assertTrue(indexes(driver).containsAll(LOOKUP_INDEXES))
            assertEquals(1L, count(driver, "aethon_portable_work_binding"))
        }
    }

    @Test
    fun `fresh schema has the indexes and the lookups use them`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)

            assertTrue(indexes(driver).containsAll(LOOKUP_INDEXES))
            assertTrue(
                plan(driver, "SELECT portable_id FROM aethon_portable_work_binding WHERE local_reference = '1'")
                    .contains("aethon_portable_work_local_index"),
            )
            assertTrue(
                plan(driver, "SELECT portable_chapter_id FROM aethon_portable_chapter_binding WHERE local_reference = '1'")
                    .contains("aethon_portable_chapter_local_index"),
            )
            assertTrue(
                plan(
                    driver,
                    "SELECT 1 FROM aethon_sync_outbox WHERE scope_id = 's' AND entity_type = 't' AND entity_id = 'e'",
                ).contains("aethon_sync_outbox_entity_index"),
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
        val LOOKUP_INDEXES = setOf(
            "aethon_portable_work_local_index",
            "aethon_portable_chapter_local_index",
            "aethon_sync_outbox_entity_index",
        )
    }
}
