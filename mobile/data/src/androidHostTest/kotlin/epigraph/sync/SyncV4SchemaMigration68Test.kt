package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import yokai.data.Database
import java.nio.file.Files
import java.nio.file.Path

/**
 * Migration 68 (`68.sqm`) creates `v4_local_digest`. The upgrade fixture is the committed
 * schema snapshot `68.db` (the schema before this migration); the fresh-schema check covers
 * the current `v4_sync.sq` definition.
 */
class SyncV4SchemaMigration68Test {
    @Test
    fun `upgrading from 68 creates v4_local_digest and leaves existing v4_entity_map rows untouched`(@TempDir tempDir: Path) {
        val database = tempDir.resolve("upgrade68.db")
        Files.copy(Path.of("src/commonMain/sqldelight/68.db"), database)
        JdbcSqliteDriver("jdbc:sqlite:$database").use { driver ->
            driver.execute(
                null,
                "INSERT INTO v4_entity_map (server_id, profile_id, domain, entity_type, entity_key, local_id, hlc_ts_ms, hlc_counter, hlc_device_id, deleted, updated_at_ms, payload_json) " +
                    "VALUES ('srv', 'main', 'comics', 'comic.work', 'comic:https://example.com/a', '42', 1000, 0, 'dev', 0, 1000, '{\"kind\":\"comic\"}')",
                0,
            )

            Database.Schema.migrate(driver, oldVersion = 68, newVersion = 69)

            assertTrue(tableExists(driver, "v4_local_digest"))
            val payload = driver.executeQuery(
                null,
                "SELECT payload_json FROM v4_entity_map WHERE entity_key = 'comic:https://example.com/a'",
                { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else "MISSING") },
                0,
            ).value
            assertEquals("{\"kind\":\"comic\"}", payload)

            driver.execute(
                null,
                "INSERT INTO v4_local_digest (server_id, profile_id, domain, entity_type, entity_key, digest, deleted) " +
                    "VALUES ('srv', 'main', 'comics', 'comic.work', 'comic:https://example.com/a', 'abc', 0)",
                0,
            )
            val digest = driver.executeQuery(
                null,
                "SELECT digest FROM v4_local_digest WHERE entity_key = 'comic:https://example.com/a'",
                { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
                0,
            ).value
            assertEquals("abc", digest)
        }
    }

    @Test
    fun `fresh schema includes v4_local_digest with its composite key`() {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            Database.Schema.create(driver)
            assertTrue(tableExists(driver, "v4_local_digest"))
            val columns = mutableListOf<String>()
            driver.executeQuery(
                null,
                "PRAGMA table_info(v4_local_digest)",
                { cursor ->
                    while (cursor.next().value) {
                        cursor.getString(1)?.let(columns::add)
                    }
                    QueryResult.Unit
                },
                0,
            )
            assertEquals(listOf("server_id", "profile_id", "domain", "entity_type", "entity_key", "digest", "deleted"), columns)
        }
    }

    private fun tableExists(driver: JdbcSqliteDriver, table: String): Boolean = driver.executeQuery(
        null,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '$table'",
        { cursor -> QueryResult.Value(cursor.next().value) },
        0,
    ).value
}
