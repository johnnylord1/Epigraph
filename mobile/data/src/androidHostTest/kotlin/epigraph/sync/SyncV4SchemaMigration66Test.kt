package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.v4.V4Hlc
import epigraph.sync.v4.V4HlcClock
import epigraph.sync.v4.V4PortableUrl
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import yokai.data.Database
import java.nio.file.Files
import java.nio.file.Path

class SyncV4SchemaMigration66Test {
    @Test
    fun `upgrading a prior schema preserves existing library and sync data`(@TempDir tempDir: Path) {
        val database = tempDir.resolve("upgrade.db")
        Files.copy(Path.of("src/commonMain/sqldelight/65.db"), database)
        JdbcSqliteDriver("jdbc:sqlite:$database").use { driver ->
            Database.Schema.migrate(driver, oldVersion = 65, newVersion = 66)
            driver.execute(
                null,
                "INSERT INTO categories (_id, name, sort, flags, manga_order) VALUES (42, 'Before V4', 0, 0, '')",
                0,
            )
            driver.execute(
                null,
                "INSERT INTO aethon_sync_receipt (device_id, client_mutation_id, received_at) VALUES ('test-phone', 'before-v4', 1000)",
                0,
            )
            val previousTables = tables(driver)
            val previousReceipts = count(driver, "aethon_sync_receipt")

            Database.Schema.migrate(driver, oldVersion = 66, newVersion = 67)

            assertTrue(tables(driver).containsAll(previousTables))
            assertEquals(previousReceipts, count(driver, "aethon_sync_receipt"))
            val name = driver.executeQuery(
                null,
                "SELECT name FROM categories WHERE _id = 42",
                { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getString(0) else null) },
                0,
            ).value
            assertEquals("Before V4", name)
            assertEquals(0L, count(driver, "v4_outbox"))
        }
    }

    @Test
    fun `migration 66 adds all Sync V4 tables and is idempotent`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.migrate(driver, oldVersion = 66, newVersion = 67)
            driver.execute(
                null,
                "INSERT INTO v4_sync_state VALUES ('srv', 'main', 10, 0, '\"etag\"', 1000, 0, 0, 1, 1000)",
                0,
            )
            // Re-running migration 66 keeps rows intact.
            Database.Schema.migrate(driver, oldVersion = 66, newVersion = 67)

            val allTables = tables(driver)
            assertTrue("v4_sync_state" in allTables)
            assertTrue("v4_entity_map" in allTables)
            assertTrue("v4_outbox" in allTables)
            assertTrue("v4_pending_extension_prefs" in allTables)
            assertEquals(1L, count(driver, "v4_sync_state"))
        }
    }

    @Test
    fun `fresh schema contains Sync V4 tables`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            Database.Schema.create(driver)
            val allTables = tables(driver)
            assertTrue("v4_sync_state" in allTables)
            assertTrue("v4_entity_map" in allTables)
            assertTrue("v4_outbox" in allTables)
            assertTrue("v4_pending_extension_prefs" in allTables)
        }
    }

    @Test
    fun `portable URL normalization matches Rust Core for style=list and hosts`() {
        val withStyle = V4PortableUrl.normalizePortableUrl(
            "https://toonily.com/webtoon/perfect-half/chapter-66/?style=list",
        )
        val withoutStyle = V4PortableUrl.normalizePortableUrl("/webtoon/perfect-half/chapter-66/")
        val altMirror = V4PortableUrl.normalizePortableUrl(
            "https://toonily.net/webtoon/perfect-half//chapter-66?utm_source=app&style=paged",
        )
        assertEquals("/webtoon/perfect-half/chapter-66", withStyle)
        assertEquals(withStyle, withoutStyle)
        assertEquals(withStyle, altMirror)
        assertEquals(
            "/read?a=1&b=2",
            V4PortableUrl.normalizePortableUrl("https://example.org/read?b=2&style=list&a=1"),
        )
    }

    @Test
    fun `HLC clock stays strictly monotonic and calibrates server clock offset`() {
        var fakeWall = 10_000L
        val clock = V4HlcClock(deviceId = "android-1", wallClockMs = { fakeWall })
        clock.calibrateServerTime(serverTimeMs = 60_000L) // +50s offset
        val a = clock.next()
        val b = clock.next()
        assertTrue(b > a)
        assertEquals(60_000L, a.tsMs)
        assertEquals(0L, a.counter)
        assertEquals(1L, b.counter)

        // Observing a future remote HLC advances the local clock monotonically.
        val observed = clock.observe(V4Hlc(tsMs = 70_000L, counter = 4L, deviceId = "desktop-1"))
        assertEquals(70_000L, observed.tsMs)
        assertEquals(5L, observed.counter)
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

    private fun count(driver: JdbcSqliteDriver, table: String): Long =
        driver.executeQuery(
            null,
            "SELECT count(*) FROM $table",
            { cursor -> QueryResult.Value(if (cursor.next().value) cursor.getLong(0)!! else 0L) },
            0,
        ).value
}
