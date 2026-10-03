package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.Database

class CoreCatalogMigrationTest {
    @Test
    fun `migration 44 initializes only persisted Epigraph Core catalog rows`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            driver.execute(
                identifier = null,
                sql = """
                    CREATE TABLE mangas(
                        _id INTEGER NOT NULL PRIMARY KEY,
                        source INTEGER NOT NULL,
                        initialized INTEGER NOT NULL
                    )
                """.trimIndent(),
                parameters = 0,
            )
            driver.execute(null, "INSERT INTO mangas VALUES (1, 3238364976084580419, 0)", 0)
            driver.execute(null, "INSERT INTO mangas VALUES (2, 42, 0)", 0)

            Database.Schema.migrate(driver, oldVersion = 44, newVersion = 45)

            assertEquals(1L, initialized(driver, 1))
            assertEquals(0L, initialized(driver, 2))
        }
    }

    private fun initialized(driver: JdbcSqliteDriver, id: Long): Long? = driver.executeQuery(
        identifier = null,
        sql = "SELECT initialized FROM mangas WHERE _id = ?",
        mapper = { cursor ->
            if (cursor.next().value) QueryResult.Value(cursor.getLong(0)) else QueryResult.Value(null)
        },
        parameters = 1,
        binders = { bindLong(0, id) },
    ).value
}
