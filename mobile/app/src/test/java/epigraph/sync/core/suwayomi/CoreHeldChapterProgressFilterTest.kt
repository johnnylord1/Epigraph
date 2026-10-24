package epigraph.sync.core.suwayomi

import android.content.SharedPreferences
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.sync.ComicBackfillCandidate
import epigraph.sync.core.portable.CoreChapterCatalog
import epigraph.sync.core.portable.CoreChapterCatalogReader
import epigraph.sync.core.portable.CoreChapterList
import epigraph.sync.core.portable.CoreWorkKey
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class CoreHeldChapterProgressFilterTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also { Database.Schema.create(it) }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val preferences = MemoryPreferences()

    @AfterEach
    fun close() = driver.close()

    /** A desktop holding [nodes] for Suwayomi manga 7, or failing / serving another work. */
    private class FakeCatalog(
        var nodes: List<JsonObject> = emptyList(),
        var fails: Boolean = false,
        var servedMangaId: Long = 7,
        val reachable: Boolean = true,
    ) : CoreChapterCatalog {
        var asked = 0

        override suspend fun <T> withReader(block: suspend (CoreChapterCatalogReader) -> T): T? {
            if (!reachable) return null
            return block(
                object : CoreChapterCatalogReader {
                    override suspend fun libraryIds(): Map<CoreWorkKey, Long> = emptyMap()

                    override suspend fun chapters(suwayomiMangaId: Long): CoreChapterList {
                        asked++
                        if (fails) error("chapters unavailable")
                        return CoreChapterList(emptyList(), CoreChapterNodes(SERVER, PROFILE, servedMangaId, nodes))
                    }
                },
            )
        }
    }

    private fun serve(localMangaId: Long) {
        database.aethon_syncQueries.upsertIdentity(
            entityId = "suwayomi:server:$SERVER:profile:$PROFILE:manga:7",
            contentType = "MANGA",
            localReference = localMangaId.toString(),
            createdAt = 0,
            updatedAt = 0,
        )
    }

    private fun candidate(chapterId: Long, read: Boolean = true, lastPageRead: Long = 0, mangaId: Long = 1) =
        ComicBackfillCandidate(
            mangaId = mangaId,
            chapterId = chapterId,
            url = "/c/$chapterId",
            read = read,
            bookmarked = false,
            lastPageRead = lastPageRead,
        )

    private fun node(url: String, read: Boolean, lastPageRead: Long = 0) = buildJsonObject {
        put("url", url)
        put("isRead", read)
        put("isBookmarked", false)
        put("lastPageRead", lastPageRead)
    }

    private fun filter(catalog: CoreChapterCatalog) = CoreHeldChapterProgressFilter(handler, catalog, preferences)

    @Test
    fun `chapters the desktop holds wait and the rest is published`() = runTest {
        serve(1)
        val catalog = FakeCatalog(nodes = listOf(node("/c/10", read = true), node("/c/11", read = false)))
        val candidates = listOf(candidate(10), candidate(11), candidate(12))

        assertEquals(setOf(10L), filter(catalog).withheld(candidates))
    }

    @Test
    fun `a page read further here than on the desktop is published`() = runTest {
        serve(1)
        val catalog = FakeCatalog(
            nodes = listOf(node("/c/10", read = false, lastPageRead = 3), node("/c/11", read = false, lastPageRead = 9)),
        )
        val candidates = listOf(candidate(10, read = false, lastPageRead = 5), candidate(11, read = false, lastPageRead = 5))

        assertEquals(setOf(11L), filter(catalog).withheld(candidates))
    }

    @Test
    fun `a confirmed title needs no second request until its local state changes`() = runTest {
        serve(1)
        val catalog = FakeCatalog(nodes = listOf(node("/c/10", read = true)))
        val filter = filter(catalog)
        // Chapter 11 is published by the first run, so it is no longer a candidate afterwards.
        filter.withheld(listOf(candidate(10), candidate(11)))

        assertEquals(setOf(10L), filter.withheld(listOf(candidate(10))))
        assertEquals(1, catalog.asked)

        catalog.nodes = emptyList()
        assertEquals(emptySet<Long>(), filter.withheld(listOf(candidate(10, lastPageRead = 4))))
        assertEquals(2, catalog.asked)
    }

    @Test
    fun `the cached filter withholds every served title it has not confirmed`() = runTest {
        serve(1)
        val catalog = FakeCatalog(nodes = emptyList())
        val candidates = listOf(candidate(10), candidate(20, mangaId = 2))

        assertEquals(setOf(10L), filter(catalog).cachedOnly.withheld(candidates))
        assertEquals(0, catalog.asked)
    }

    @Test
    fun `titles the desktop does not serve are published`() = runTest {
        serve(1)
        val catalog = FakeCatalog(nodes = listOf(node("/c/10", read = true)), servedMangaId = 8)

        assertEquals(emptySet<Long>(), filter(catalog).withheld(listOf(candidate(10))))
    }

    @Test
    fun `a title whose check keeps failing is published on the third failure`() = runTest {
        serve(1)
        val filter = filter(FakeCatalog(fails = true))
        val candidates = listOf(candidate(10))

        assertEquals(setOf(10L), filter.withheld(candidates))
        assertEquals(setOf(10L), filter.withheld(candidates))
        assertEquals(emptySet<Long>(), filter.withheld(candidates))
    }

    @Test
    fun `without a Core session served titles wait`() = runTest {
        serve(1)
        val filter = filter(FakeCatalog(reachable = false))

        repeat(4) { assertEquals(setOf(10L), filter.withheld(listOf(candidate(10)))) }
        assertTrue(preferences.values.isEmpty())
    }

    @Test
    fun `chapters still served by the Core match by their chapter reference`() = runTest {
        serve(1)
        val reference = SuwayomiCoreContentReference.forChapter(SERVER, PROFILE, 44)
        val catalog = FakeCatalog(
            nodes = listOf(buildJsonObject {
                put("id", 44)
                put("isRead", true)
            }),
        )
        val candidates = listOf(candidate(10).copy(url = reference))

        assertEquals(setOf(10L), filter(catalog).withheld(candidates))
    }

    private class MemoryPreferences : SharedPreferences {
        val values = mutableMapOf<String, Any?>()

        override fun getAll(): MutableMap<String, *> = values
        override fun getString(key: String, defValue: String?): String? = values[key] as? String ?: defValue
        override fun getStringSet(key: String, defValues: MutableSet<String>?): MutableSet<String>? = defValues
        override fun getInt(key: String, defValue: Int): Int = values[key] as? Int ?: defValue
        override fun getLong(key: String, defValue: Long): Long = values[key] as? Long ?: defValue
        override fun getFloat(key: String, defValue: Float): Float = values[key] as? Float ?: defValue
        override fun getBoolean(key: String, defValue: Boolean): Boolean = values[key] as? Boolean ?: defValue
        override fun contains(key: String): Boolean = key in values
        override fun registerOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit
        override fun unregisterOnSharedPreferenceChangeListener(listener: SharedPreferences.OnSharedPreferenceChangeListener?) = Unit

        override fun edit(): SharedPreferences.Editor = object : SharedPreferences.Editor {
            private val changes = mutableMapOf<String, Any?>()

            override fun putString(key: String, value: String?) = apply { changes[key] = value }
            override fun putStringSet(key: String, values: MutableSet<String>?) = apply { changes[key] = values }
            override fun putInt(key: String, value: Int) = apply { changes[key] = value }
            override fun putLong(key: String, value: Long) = apply { changes[key] = value }
            override fun putFloat(key: String, value: Float) = apply { changes[key] = value }
            override fun putBoolean(key: String, value: Boolean) = apply { changes[key] = value }
            override fun remove(key: String) = apply { changes[key] = null }
            override fun clear() = apply { values.keys.forEach { changes[it] = null } }
            override fun commit(): Boolean {
                apply()
                return true
            }
            override fun apply() {
                changes.forEach { (key, value) -> if (value == null) values.remove(key) else values[key] = value }
                changes.clear()
            }
        }
    }

    private companion object {
        const val SERVER = "desktop"
        const val PROFILE = "main"
    }
}
