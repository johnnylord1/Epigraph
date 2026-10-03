package epigraph.sync.core.extensions
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class SqlDelightCoreSourceRelinkStoreTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also {
        Database.Schema.create(it)
    }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val store = SqlDelightCoreSourceRelinkStore(handler)

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `package enrichment is isolated to the bound core scope`() = runTest {
        bind("entity-a", "server-a", "BOUND", "/a")
        bind("entity-b", "server-b", "BOUND", "/b")
        bind("entity-legacy", "server-a", "LEGACY_UNBOUND", "/legacy")

        store.resolveUnknownPackages("server-a", "main", mapOf(10L to "ext.example"))

        assertEquals("ext.example", packageFor("entity-a"))
        assertEquals("unknown", packageFor("entity-b"))
        assertEquals("unknown", packageFor("entity-legacy"))
    }

    private fun bind(entityId: String, serverId: String, status: String, url: String) {
        database.aethon_syncQueries.upsertIdentity(entityId, "MANGA", entityId, 1, 1)
        database.aethon_syncQueries.upsertCoreRemoteIdentity(
            entityId = entityId,
            serverId = serverId,
            profileId = "main",
            remoteType = "SUWAYOMI_MANGA",
            remoteId = entityId,
            bindingStatus = status,
            updatedAt = 1,
        )
        database.aethon_syncQueries.insertBinding(
            bindingId = "binding-$entityId",
            entityId = entityId,
            ecosystem = "SUWAYOMI",
            repository = "core-$serverId",
            pluginPackage = "unknown",
            sourceId = "10",
            normalizedUrl = url,
            isPrimary = true,
            createdAt = 1,
        )
    }

    private fun packageFor(entityId: String): String = database.aethon_syncQueries
        .selectBindingsByEntityId(entityId)
        .executeAsOne()
        .plugin_package
}
