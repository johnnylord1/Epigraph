package epigraph.sync

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import yokai.data.Database

class CoreIdentityInventorySchemaTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
        it.execute(null, "PRAGMA foreign_keys = ON", 0)
    }
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val queries = database.aethon_syncQueries

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `remote identity preserves local entity id and is unique per core identity`() {
        queries.upsertIdentity("local-manga-7", "MANGA", "7", 1, 1)
        queries.upsertCoreRemoteIdentity(
            "local-manga-7",
            "desktop-a",
            "main",
            "SUWAYOMI_MANGA",
            "701",
            "BOUND",
            2,
        )

        val row = queries.selectCoreRemoteIdentityByEntityId("local-manga-7").executeAsOne()
        assertEquals("local-manga-7", row.entity_id)
        assertEquals("desktop-a", row.server_id)
        assertEquals("701", row.remote_id)
        assertEquals("7", queries.selectIdentityByEntityId("local-manga-7").executeAsOne().local_reference)

        queries.upsertIdentity("local-manga-8", "MANGA", "8", 1, 1)
        assertThrows(Exception::class.java) {
            queries.upsertCoreRemoteIdentity(
                "local-manga-8",
                "desktop-a",
                "main",
                "SUWAYOMI_MANGA",
                "701",
                "BOUND",
                3,
            )
        }
    }

    @Test
    fun `remote identity follows local entity lifecycle`() {
        queries.upsertIdentity("local-manga-9", "MANGA", "9", 1, 1)
        queries.upsertCoreRemoteIdentity(
            "local-manga-9",
            "legacy_unbound",
            "main",
            "SUWAYOMI_MANGA",
            "9",
            "LEGACY_UNBOUND",
            2,
        )
        assertNotNull(queries.selectCoreRemoteIdentityByEntityId("local-manga-9").executeAsOneOrNull())

        driver.execute(null, "DELETE FROM aethon_content_identity WHERE entity_id = ?", 1) {
            bindString(0, "local-manga-9")
        }
        assertNull(queries.selectCoreRemoteIdentityByEntityId("local-manga-9").executeAsOneOrNull())
    }

    @Test
    fun `inventory cache preserves notification state across report refresh`() {
        val firstHash = "a".repeat(64)
        val secondHash = "b".repeat(64)
        queries.upsertCoreExtensionInventoryCache("desktop-a", "main", 1, firstHash, "{\"v\":1}", 1, 2)
        queries.markCoreExtensionInventoryNotified(firstHash, "desktop-a", "main")
        queries.acknowledgeCoreExtensionInventory(firstHash, "desktop-a", "main")
        queries.upsertCoreExtensionInventoryCache("desktop-a", "main", 2, secondHash, "{\"v\":2}", 3, 4)

        val row = queries.selectCoreExtensionInventoryCache("desktop-a", "main").executeAsOne()
        assertEquals(2L, row.schema_version)
        assertEquals(secondHash, row.inventory_hash)
        assertEquals(firstHash, row.notified_inventory_hash)
        assertEquals(firstHash, row.acknowledged_inventory_hash)
    }
}
