package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test
import yokai.data.Database

class PortableBindingMigration47Test {
    @Test
    fun `migration 47 adds portable bindings without rewriting legacy bindings`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                null,
                "CREATE TABLE legacy_marker(id TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)",
                0,
            )
            driver.execute(null, "INSERT INTO legacy_marker VALUES ('v2', 'preserved')", 0)

            Database.Schema.migrate(driver, oldVersion = 47, newVersion = 48)

            assertNotNull(tableName(driver, "aethon_portable_work_binding"))
            assertNotNull(tableName(driver, "aethon_portable_chapter_binding"))
            assertNotNull(tableName(driver, "aethon_comic_dependency_v3"))
            assertNotNull(tableName(driver, "aethon_novel_dependency_v3"))
            assertEquals("preserved", marker(driver))
        }
    }

    private fun tableName(driver: JdbcSqliteDriver, name: String): String? = driver.executeQuery(
        null,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        { cursor ->
            if (cursor.next().value) QueryResult.Value(cursor.getString(0)) else QueryResult.Value(null)
        },
        1,
    ) { bindString(0, name) }.value

    private fun marker(driver: JdbcSqliteDriver): String? = driver.executeQuery(
        null,
        "SELECT value FROM legacy_marker WHERE id = 'v2'",
        { cursor ->
            if (cursor.next().value) QueryResult.Value(cursor.getString(0)) else QueryResult.Value(null)
        },
        0,
    ).value
}
