package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.Database

class PortableStateMembershipMigration61Test {
    @Test
    fun `migration 61 turns server version stamps into state memberships and keeps rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                null,
                "CREATE TABLE aethon_portable_manifest_work (server_id TEXT, profile_id TEXT, portable_id TEXT, observed_at INTEGER)",
                0,
            )
            driver.execute(null, "INSERT INTO aethon_portable_manifest_work VALUES ('s', 'main', 'comic:library', 1761236444000)", 0)
            driver.execute(null, "INSERT INTO aethon_portable_manifest_work VALUES ('s', 'main', 'comic:history', 105688)", 0)
            driver.execute(null, "INSERT INTO aethon_portable_manifest_work VALUES ('s', 'main', 'comic:state', 0)", 0)

            Database.Schema.migrate(driver, oldVersion = 61, newVersion = 62)
            // Re-running is harmless.
            Database.Schema.migrate(driver, oldVersion = 61, newVersion = 62)

            assertEquals(
                mapOf("comic:library" to 1761236444000L, "comic:history" to 0L, "comic:state" to 0L),
                stamps(driver),
            )
        }
    }

    private fun stamps(driver: JdbcSqliteDriver): Map<String, Long> =
        driver.executeQuery(
            null,
            "SELECT portable_id, observed_at FROM aethon_portable_manifest_work",
            { cursor ->
                QueryResult.Value(
                    buildMap {
                        while (cursor.next().value) put(cursor.getString(0)!!, cursor.getLong(1)!!)
                    },
                )
            },
            0,
        ).value
}
