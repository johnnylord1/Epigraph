package epigraph.sync.core.policy

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.Database

class DeviceSyncSelectionTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(
        driver,
        chaptersAdapter = tachiyomi.data.Chapters.Adapter(yokai.data.memoColumnAdapter),
        mangasAdapter = tachiyomi.data.Mangas.Adapter(yokai.data.memoColumnAdapter),
    )
    private val store: DeviceSyncSelectionStore = SqlDelightDeviceSyncSelectionStore(database)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `recommended defaults enable every domain and inventory without automatic assets`() {
        val defaults = DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-a", updatedAtMs = 100)

        assertEquals(SyncDomain.entries.toSet(), defaults.enabledDomains)
        assertEquals(DependencyInventoryMode.INVENTORY_ONLY, defaults.comicRepositories)
        assertEquals(DependencyInventoryMode.INVENTORY_ONLY, defaults.comicExtensions)
        assertEquals(DependencyInventoryMode.INVENTORY_ONLY, defaults.novelRepositories)
        assertEquals(DependencyInventoryMode.INVENTORY_ONLY, defaults.novelPlugins)
        assertEquals(BookAssetPolicy.ON_DEMAND, defaults.bookAssets)
    }

    @Test
    fun `normalization disables inventories whose domains are disabled`() {
        val selection = DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-a", 100).copy(
            enabledDomains = setOf(SyncDomain.BOOKS),
        ).normalized()

        assertEquals(setOf(SyncDomain.BOOKS), selection.enabledDomains)
        assertEquals(DependencyInventoryMode.DISABLED, selection.comicRepositories)
        assertEquals(DependencyInventoryMode.DISABLED, selection.comicExtensions)
        assertEquals(DependencyInventoryMode.DISABLED, selection.novelRepositories)
        assertEquals(DependencyInventoryMode.DISABLED, selection.novelPlugins)
        assertEquals(BookAssetPolicy.ON_DEMAND, selection.bookAssets)
    }

    @Test
    fun `selection requires one domain and canonical identity`() {
        assertThrows(IllegalArgumentException::class.java) {
            DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-a", 100).copy(enabledDomains = emptySet())
        }
        assertThrows(IllegalArgumentException::class.java) {
            DeviceSyncSelectionV1.defaults(" desktop-a", "main", "phone-a", 100)
        }
    }

    @Test
    fun `store isolates records by server profile and device and normalizes writes`() {
        val first = DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-a", 100).copy(
            enabledDomains = setOf(SyncDomain.COMICS),
        )
        val second = DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-b", 200)

        store.upsert(first)
        store.upsert(second)

        assertEquals(setOf(SyncDomain.COMICS), store.load("desktop-a", "main", "phone-a")?.enabledDomains)
        assertEquals(
            DependencyInventoryMode.DISABLED,
            store.load("desktop-a", "main", "phone-a")?.novelRepositories,
        )
        assertEquals(200, store.load("desktop-a", "main", "phone-b")?.updatedAtMs)
        assertNull(store.load("desktop-b", "main", "phone-a"))
    }

    @Test
    fun `deleting a selection preserves offline content and other devices`() {
        database.aethon_syncQueries.upsertIdentity(
            entityId = "book:sha256:offline",
            contentType = "EPUB",
            localReference = "offline-book",
            createdAt = 1,
            updatedAt = 1,
        )
        store.upsert(DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-a", 100))
        store.upsert(DeviceSyncSelectionV1.defaults("desktop-a", "main", "phone-b", 100))

        store.delete("desktop-a", "main", "phone-a")

        assertNull(store.load("desktop-a", "main", "phone-a"))
        assertEquals("phone-b", store.load("desktop-a", "main", "phone-b")?.deviceId)
        assertTrue(
            database.aethon_syncQueries.selectIdentityByEntityId("book:sha256:offline").executeAsOneOrNull() != null,
        )
    }
}
