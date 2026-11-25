package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import yokai.data.Database
import java.nio.file.Files
import java.nio.file.Path

class SyncV4SchemaMigration67Test {
    @Test
    fun `upgrading from 67 preserves existing v4_entity_map rows and adds payload_json`(@TempDir tempDir: Path) {
        val database = tempDir.resolve("upgrade67.db")
        Files.copy(Path.of("src/commonMain/sqldelight/67.db"), database)
        JdbcSqliteDriver("jdbc:sqlite:$database").use { driver ->
            driver.execute(
                null,
                "INSERT INTO v4_entity_map (server_id, profile_id, domain, entity_type, entity_key, local_id, hlc_ts_ms, hlc_counter, hlc_device_id, deleted, updated_at_ms) " +
                    "VALUES ('srv', 'main', 'extensions', 'extension.repo', 'novel:https://example.com', 'novel:https://example.com', 1000, 0, 'dev', 0, 1000)",
                0,
            )

            Database.Schema.migrate(driver, oldVersion = 67, newVersion = 68)

            val payload = driver.executeQuery(
                null,
                "SELECT payload_json FROM v4_entity_map WHERE entity_key = 'novel:https://example.com'",
                { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else "MISSING") },
                0,
            ).value
            assertNull(payload)

            driver.execute(
                null,
                "UPDATE v4_entity_map SET payload_json = '{\"kind\":\"novel\"}' WHERE entity_key = 'novel:https://example.com'",
                0,
            )
            val updated = driver.executeQuery(
                null,
                "SELECT payload_json FROM v4_entity_map WHERE entity_key = 'novel:https://example.com'",
                { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
                0,
            ).value
            assertEquals("{\"kind\":\"novel\"}", updated)
        }
    }

    @Test
    fun `fresh schema includes payload_json on v4_entity_map`() {
        JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).use { driver ->
            Database.Schema.create(driver)
            val columns = mutableListOf<String>()
            driver.executeQuery(
                null,
                "PRAGMA table_info(v4_entity_map)",
                { cursor ->
                    while (cursor.next().value) {
                        cursor.getString(1)?.let(columns::add)
                    }
                    QueryResult.Unit
                },
                0,
            )
            assertTrue("payload_json" in columns)
        }
    }
}
