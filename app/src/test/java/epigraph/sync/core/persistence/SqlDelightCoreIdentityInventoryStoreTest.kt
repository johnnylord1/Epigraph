package epigraph.sync.core.persistence
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class SqlDelightCoreIdentityInventoryStoreTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val store = SqlDelightCoreIdentityInventoryStore(database) { 20 }

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `store preserves local id and resolves its core identity`() {
        database.aethon_syncQueries.upsertIdentity("local-42", "MANGA", "42", 1, 1)
        store.upsertRemoteIdentity(
            CoreRemoteIdentityRecord(
                entityId = "local-42",
                serverId = "desktop-a",
                profileId = "main",
                remoteType = "SUWAYOMI_MANGA",
                remoteId = "9001",
                bindingStatus = CoreRemoteBindingStatus.BOUND,
                updatedAt = 2,
            ),
        )

        assertEquals("local-42", store.remoteIdentity("local-42")?.entityId)
        assertEquals(
            "local-42",
            store.remoteIdentity("desktop-a", "main", "SUWAYOMI_MANGA", "9001")?.entityId,
        )
        assertEquals("42", database.aethon_syncQueries.selectIdentityByEntityId("local-42").executeAsOne().local_reference)
    }

    @Test
    fun `notification decision survives cache updates`() {
        val hash = "c".repeat(64)
        assertTrue(store.saveExtensionInventory(1, "desktop-a", "main", hash, "{}", 10))
        store.markExtensionInventoryNotified("desktop-a", "main", hash)
        assertFalse(store.saveExtensionInventory(1, "desktop-a", "main", hash, "{}", 11))

        val replacement = "d".repeat(64)
        assertTrue(store.saveExtensionInventory(2, "desktop-a", "main", replacement, "{}", 12))
        assertEquals(2L, store.latestExtensionInventory()?.schemaVersion)
        assertEquals(replacement, store.latestExtensionInventory()?.inventoryHash)
    }

    @Test
    fun `inventory caches remain separated by server and profile`() {
        val first = "a".repeat(64)
        val second = "b".repeat(64)
        store.saveExtensionInventory(1, "desktop-a", "main", first, "{}", 10)
        store.saveExtensionInventory(1, "desktop-b", "main", second, "{}", 11)

        val inventories = store.extensionInventories()

        assertEquals(2, inventories.size)
        assertEquals(
            setOf("desktop-a:main:$first", "desktop-b:main:$second"),
            inventories.map { "${it.serverId}:${it.profileId}:${it.inventoryHash}" }.toSet(),
        )
    }
}
