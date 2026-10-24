package epigraph.sync.core.extensions
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonObject
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

    @Test
    fun `a pass moves a work once and then reports it as already bound`() = runTest {
        val mangaId = insertManga(source = 99, url = "/core/a")
        database.aethon_syncQueries.upsertIdentity("entity-a", "MANGA", mangaId.toString(), 1, 1)
        database.aethon_syncQueries.insertBinding(
            bindingId = "binding-entity-a",
            entityId = "entity-a",
            ecosystem = "SUWAYOMI",
            repository = "core-server-a",
            pluginPackage = "ext.example",
            sourceId = "10",
            normalizedUrl = "/a",
            isPrimary = true,
            createdAt = 1,
        )
        val candidates = store.candidates()
        val missing = candidates.single().copy(entityId = "entity-gone")

        assertEquals(CoreSourceRelinkCount(bound = 1, moved = 1), store.relinkAll(candidates + missing))
        val manga = database.mangasQueries.findById(mangaId).executeAsOne()
        assertEquals(10L, manga.source)
        assertEquals("/a", manga.url)
        assertEquals(CoreSourceRelinkCount(bound = 1, moved = 0), store.relinkAll(candidates + missing))
    }

    private fun insertManga(source: Long, url: String): Long {
        database.mangasQueries.insert(
            source = source,
            url = url,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Comic",
            status = 0,
            thumbnailUrl = null,
            favorite = true,
            lastUpdate = null,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        return database.mangasQueries.selectLastInsertedRowId().executeAsOne()
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
