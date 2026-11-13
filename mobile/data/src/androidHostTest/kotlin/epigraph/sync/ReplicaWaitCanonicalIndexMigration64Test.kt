package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class ReplicaWaitCanonicalIndexMigration64Test {
    @Test
    fun `migration 64 adds the canonical wait index and keeps rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                null,
                "CREATE TABLE aethon_sync_replica_wait (client_mutation_id TEXT PRIMARY KEY, scope_id TEXT, " +
                    "entity_type TEXT, entity_id TEXT, canonical_entity_id TEXT, required_server_version INTEGER)",
                0,
            )
            driver.execute(null, "INSERT INTO aethon_sync_replica_wait VALUES ('m1', 's', 't', 'e', 'c', 3)", 0)

            Database.Schema.migrate(driver, oldVersion = 64, newVersion = 65)
            // Re-running is harmless (CREATE INDEX IF NOT EXISTS).
            Database.Schema.migrate(driver, oldVersion = 64, newVersion = 65)

            assertTrue(CANONICAL_INDEX in indexes(driver))
            assertEquals(1L, count(driver, "aethon_sync_replica_wait"))
        }
    }

    @Test
    fun `fresh schema answers the canonical branch from an index`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)

            assertTrue(CANONICAL_INDEX in indexes(driver))
            val plan = plan(
                driver,
                "SELECT 1 FROM aethon_sync_replica_wait WHERE scope_id = 's' AND entity_type = 't' " +
                    "AND (entity_id = 'e' OR canonical_entity_id = 'e') AND required_server_version > 1",
            )
            assertTrue(plan.contains(CANONICAL_INDEX), plan)
            assertFalse(plan.contains("SCAN aethon_sync_replica_wait"), plan)
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
        const val CANONICAL_INDEX = "aethon_sync_replica_wait_canonical_index"
    }
}
