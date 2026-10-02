package epigraph.sync

import app.cash.sqldelight.db.QueryResult
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class CategoryIdentityMigration54Test {
    @Test
    fun `migration 54 restores each identity's library from its entity id`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            createVersion53Tables(driver)
            insertFolder(driver, 1)
            insertFolder(driver, 2)
            insertFolder(driver, 3)
            insertFolder(driver, 4)
            // Routers had re-labelled these to the library that touched them last.
            insertIdentity(driver, COMIC_CATEGORY_ID, 1, "BOOK")
            insertIdentity(driver, "novel-category-local-2", 2, "MANGA")
            insertIdentity(driver, "book-category-local-3", 3, "NOVEL")
            insertIdentity(driver, "desktop-novel-category", 4, "NOVEL")

            Database.Schema.migrate(driver, oldVersion = 54, newVersion = 55)

            assertEquals(
                listOf(
                    Identity("book-category-local-3", 3, "BOOK", "Folder 3", 3),
                    Identity("desktop-novel-category", 4, "NOVEL", "Folder 4", 4),
                    Identity("novel-category-local-2", 2, "NOVEL", "Folder 2", 2),
                    Identity(COMIC_CATEGORY_ID, 1, "MANGA", "Folder 1", 1),
                ),
                identities(driver),
            )
        }
    }

    @Test
    fun `after migration 54 a folder holds one identity per library`() {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        driver.use {
            createVersion53Tables(driver)
            insertFolder(driver, 1)
            insertIdentity(driver, COMIC_CATEGORY_ID, 1, "MANGA")

            Database.Schema.migrate(driver, oldVersion = 54, newVersion = 55)

            insertIdentity(driver, "novel-category-local-1", 1, "NOVEL")
            insertIdentity(driver, "book-category-local-1", 1, "BOOK")
            assertEquals(listOf("BOOK", "MANGA", "NOVEL"), identities(driver).map { it.scope }.sorted())

            val duplicate = runCatching { insertIdentity(driver, "another-comic-category", 1, "MANGA") }
            assertTrue(duplicate.isFailure)

            driver.execute(null, "PRAGMA foreign_keys = ON", 0)
            driver.execute(null, "DELETE FROM categories WHERE _id = 1", 0)
            assertTrue(identities(driver).isEmpty())
        }
    }

    private fun createVersion53Tables(driver: JdbcSqliteDriver) {
        driver.execute(
            null,
            """
                CREATE TABLE categories(
                    _id INTEGER NOT NULL PRIMARY KEY,
                    name TEXT NOT NULL,
                    sort INTEGER NOT NULL,
                    flags INTEGER NOT NULL,
                    manga_order TEXT NOT NULL
                )
            """.trimIndent(),
            0,
        )
        driver.execute(
            null,
            """
                CREATE TABLE aethon_category_identity (
                    entity_id TEXT NOT NULL PRIMARY KEY,
                    local_category_id INTEGER NOT NULL UNIQUE,
                    content_scope TEXT NOT NULL CHECK(content_scope IN ('ALL', 'MANGA', 'NOVEL', 'BOOK')),
                    name TEXT NOT NULL,
                    sort_order INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(local_category_id) REFERENCES categories(_id) ON DELETE CASCADE
                )
            """.trimIndent(),
            0,
        )
    }

    private fun insertFolder(driver: JdbcSqliteDriver, id: Long) {
        driver.execute(
            null,
            "INSERT INTO categories(_id, name, sort, flags, manga_order) VALUES (?, ?, ?, 0, '')",
            3,
        ) {
            bindLong(0, id)
            bindString(1, "Folder $id")
            bindLong(2, id)
        }
    }

    private fun insertIdentity(driver: JdbcSqliteDriver, entityId: String, folder: Long, scope: String) {
        driver.execute(
            null,
            """
                INSERT INTO aethon_category_identity(
                    entity_id, local_category_id, content_scope, name, sort_order, updated_at
                ) VALUES (?, ?, ?, ?, ?, 1)
            """.trimIndent(),
            5,
        ) {
            bindString(0, entityId)
            bindLong(1, folder)
            bindString(2, scope)
            bindString(3, "Folder $folder")
            bindLong(4, folder)
        }
    }

    private fun identities(driver: JdbcSqliteDriver): List<Identity> = driver.executeQuery(
        identifier = null,
        sql = """
            SELECT entity_id, local_category_id, content_scope, name, sort_order
            FROM aethon_category_identity
            ORDER BY entity_id
        """.trimIndent(),
        mapper = { cursor ->
            val rows = mutableListOf<Identity>()
            while (cursor.next().value) {
                rows += Identity(
                    cursor.getString(0)!!,
                    cursor.getLong(1)!!,
                    cursor.getString(2)!!,
                    cursor.getString(3)!!,
                    cursor.getLong(4)!!,
                )
            }
            QueryResult.Value(rows)
        },
        parameters = 0,
    ).value

    private data class Identity(
        val entityId: String,
        val folder: Long,
        val scope: String,
        val name: String,
        val sortOrder: Long,
    )

    private companion object {
        const val COMIC_CATEGORY_ID = "suwayomi:server:desktop-a:profile:main:category:5"
    }
}
