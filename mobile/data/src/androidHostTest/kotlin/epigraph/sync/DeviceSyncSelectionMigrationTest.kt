package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import yokai.data.Database

class DeviceSyncSelectionMigrationTest {
    @Test
    fun `migration 45 adds policy storage without rewriting offline library rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                identifier = null,
                sql = """
                    CREATE TABLE mangas(
                        _id INTEGER NOT NULL PRIMARY KEY,
                        title TEXT NOT NULL,
                        thumbnail_url TEXT,
                        initialized INTEGER NOT NULL
                    )
                """.trimIndent(),
                parameters = 0,
            )
            driver.execute(null, "INSERT INTO mangas VALUES (7, 'Offline title', 'cover.jpg', 1)", 0)

            Database.Schema.migrate(driver, oldVersion = 45, newVersion = 48)

            driver.execute(
                identifier = null,
                sql = """
                    INSERT INTO aethon_device_sync_selection(
                        server_id, profile_id, device_id, schema_version,
                        comics_enabled, novels_enabled, books_enabled,
                        comic_extensions, novel_repositories, novel_plugins,
                        book_asset_policy, updated_at, comic_repositories
                    ) VALUES (
                        'desktop-a', 'main', 'phone-a', 1,
                        1, 1, 1,
                        'INVENTORY_ONLY', 'INVENTORY_ONLY', 'INVENTORY_ONLY',
                        'ON_DEMAND', 100, 'INVENTORY_ONLY'
                    )
                """.trimIndent(),
                parameters = 0,
            )

            assertNotNull(tableName(driver, "aethon_device_sync_selection"))
            assertNotNull(tableName(driver, "aethon_core_novel_dependency_inventory_cache"))
            assertEquals("Offline title", mangaTitle(driver, 7))
        }
    }

    private fun tableName(driver: JdbcSqliteDriver, name: String): String? = driver.executeQuery(
        identifier = null,
        sql = "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        mapper = { cursor ->
            if (cursor.next().value) QueryResult.Value(cursor.getString(0)) else QueryResult.Value(null)
        },
        parameters = 1,
        binders = { bindString(0, name) },
    ).value

    private fun mangaTitle(driver: JdbcSqliteDriver, id: Long): String? = driver.executeQuery(
        identifier = null,
        sql = "SELECT title FROM mangas WHERE _id = ?",
        mapper = { cursor ->
            if (cursor.next().value) QueryResult.Value(cursor.getString(0)) else QueryResult.Value(null)
        },
        parameters = 1,
        binders = { bindLong(0, id) },
    ).value
}
