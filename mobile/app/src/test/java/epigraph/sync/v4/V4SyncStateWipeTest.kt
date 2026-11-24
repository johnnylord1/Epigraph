package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.OkHttpClient
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

class V4SyncStateWipeTest {
    private fun createInMemoryDatabase(): Pair<JdbcSqliteDriver, Database> {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        val db = Database(
            driver = driver,
            mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
            chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
        )
        return driver to db
    }

    private fun countRows(driver: JdbcSqliteDriver, table: String): Long =
        driver.executeQuery(
            identifier = null,
            sql = "SELECT COUNT(*) FROM $table",
            mapper = { cursor ->
                cursor.next()
                app.cash.sqldelight.db.QueryResult.Value(cursor.getLong(0) ?: 0L)
            },
            parameters = 0,
        ).value

    private fun seedLibrary(driver: JdbcSqliteDriver, db: Database) {
        driver.execute(
            null,
            "INSERT INTO mangas(_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags) VALUES (1, 100, '/m1', 'Local Manga', 1, 1, 1, 0, 0, 0)",
            0,
        )
        driver.execute(
            null,
            "INSERT INTO chapters(_id, manga_id, url, name, read, bookmark, last_page_read, pages_left, chapter_number, source_order, date_fetch, date_upload) VALUES (10, 1, '/c1', 'Chapter 1', 0, 0, 0, 0, 1, 1, 20, 10)",
            0,
        )
        db.categoriesQueries.insert("Reading", 1, 0, "")
        val hash = "c".repeat(64)
        db.local_booksQueries.insert(
            bookId = "epub:sha256:$hash",
            contentType = "EPUB",
            sha256 = hash,
            displayName = "Local Book",
            author = null,
            description = null,
            coverPath = null,
            coverAssetSha256 = null,
            coverAssetByteSize = null,
            coverAssetMimeType = null,
            privatePath = "/tmp/book.epub",
            mimeType = "application/epub+zip",
            byteSize = 10,
            chapterCount = null,
            pageCount = null,
            importedAt = 1,
            updatedAt = 1,
        )
    }

    private fun assertLibraryIntact(driver: JdbcSqliteDriver) {
        assertEquals(1L, countRows(driver, "mangas"))
        assertEquals(1L, countRows(driver, "chapters"))
        assertEquals(1L, countRows(driver, "categories"))
        assertEquals(1L, countRows(driver, "local_books"))
    }

    @Test
    fun `re-pairing with the same Core keeps outbox HLCs and sync state`() {
        val (driver, db) = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        val progress = MemoryV4SyncDomainProgress()
        val editHlc = V4Hlc(tsMs = 5_000_000L, counter = 3L, deviceId = "phone-1")

        seedLibrary(driver, db)
        store.saveState(
            V4SyncCursorState(
                serverId = "srv-1",
                profileId = "main",
                serverSeq = 42L,
                initialSyncCompleted = true,
            ),
        )
        store.upsertEntityMap(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.work",
            entityKey = "src:/work-1",
            localId = "1",
            hlc = editHlc,
            deleted = false,
        )
        store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.work",
            entityKey = "src:/work-1",
            deleted = false,
            hlc = editHlc,
            payload = buildJsonObject { put("favorite", JsonPrimitive(true)) },
        )
        progress.save("srv-1", "main", setOf("comics", "novels"))

        // Re-pairing with the same serverId: handOverToServer("srv-1") preserves everything for srv-1.
        store.handOverToServer("srv-1", "main", progress)

        val state = store.loadState("srv-1", "main")
        assertEquals(42L, state.serverSeq)
        assertTrue(state.initialSyncCompleted)
        assertEquals(1L, countRows(driver, "v4_entity_map WHERE server_id = 'srv-1'"))
        assertEquals(setOf("comics", "novels"), progress.load("srv-1", "main"))

        val outbox = store.loadDueOutbox("srv-1", "main", V4SyncDomainPolicy(), limit = 10)
        assertEquals(1, outbox.size)
        assertEquals(5_000_000L, outbox[0].hlc_ts_ms)
        assertEquals(3L, outbox[0].hlc_counter)
        assertEquals("phone-1", outbox[0].hlc_device_id)
        assertLibraryIntact(driver)
    }

    @Test
    fun `switching to a different Core moves outbox with original HLCs and clears old server state`() {
        val (driver, db) = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        val progress = MemoryV4SyncDomainProgress()
        val editHlc = V4Hlc(tsMs = 9_876_543L, counter = 7L, deviceId = "phone-1")
        val payload = buildJsonObject { put("read", JsonPrimitive(true)) }

        seedLibrary(driver, db)
        store.saveState(
            V4SyncCursorState(
                serverId = "srv-1",
                profileId = "main",
                serverSeq = 99L,
                initialSyncCompleted = true,
            ),
        )
        store.upsertEntityMap(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.chapter",
            entityKey = "src:/c1",
            localId = "10",
            hlc = editHlc,
            deleted = false,
        )
        val mutationId = store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.chapter",
            entityKey = "src:/c1",
            deleted = false,
            hlc = editHlc,
            payload = payload,
        )
        store.recordFailure(mutationId, backoffMs = 9_999_999L, error = "HTTP 503")
        store.savePendingExtensionPref(
            serverId = "srv-1",
            profileId = "main",
            kind = "comic",
            sourceOrPluginId = "src-1",
            prefKey = "pref-1",
            payloadJson = "{}",
            hlc = editHlc,
        )
        progress.save("srv-1", "main", setOf("comics"))

        // Switch to srv-2.
        store.handOverToServer("srv-2", "main", progress)

        // Old server's state, entity map, pending prefs, and domain progress are cleared.
        val oldState = store.loadState("srv-1", "main")
        assertEquals(0L, oldState.serverSeq)
        assertFalse(oldState.initialSyncCompleted)
        assertEquals(0L, countRows(driver, "v4_entity_map WHERE server_id = 'srv-1'"))
        assertEquals(0, store.loadPendingExtensionPrefs("srv-1", "main", "comic").size)
        assertNull(progress.load("srv-1", "main"))

        // Outbox rows were moved to srv-2 with original HLCs, payloads, no duplicates, and backoff reset.
        assertEquals(0L, store.countPendingOutbox("srv-1", "main"))
        val newOutbox = store.loadDueOutbox("srv-2", "main", V4SyncDomainPolicy(), limit = 10)
        assertEquals(1, newOutbox.size)
        assertEquals(1L, countRows(driver, "v4_outbox"))
        assertEquals(mutationId, newOutbox[0].client_mutation_id)
        assertEquals("srv-2", newOutbox[0].server_id)
        assertEquals(9_876_543L, newOutbox[0].hlc_ts_ms)
        assertEquals(7L, newOutbox[0].hlc_counter)
        assertEquals("phone-1", newOutbox[0].hlc_device_id)
        assertEquals(payload.toString(), newOutbox[0].payload_json)
        assertEquals(0L, newOutbox[0].attempts)
        assertEquals(0L, newOutbox[0].next_retry_at_ms)
        assertNull(newOutbox[0].last_error)

        assertLibraryIntact(driver)
    }

    @Test
    fun `unpair only keeps outbox intact while clearing nothing prematurely`() {
        val (driver, db) = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        val editHlc = V4Hlc(tsMs = 3_333_333L, counter = 2L, deviceId = "phone-1")

        seedLibrary(driver, db)
        store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.work",
            entityKey = "src:/work-1",
            deleted = false,
            hlc = editHlc,
            payload = buildJsonObject { put("favorite", JsonPrimitive(true)) },
        )

        // Unpairing does not wipe v4_outbox; pending edits remain queued for the next pair.
        assertEquals(1L, store.countPendingOutbox("srv-1", "main"))
        assertLibraryIntact(driver)
    }

    @Test
    fun `invalidated engine cannot write state back after handover`() = runTest {
        val (_, db) = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        val client = OkHttpClient()
        val clock = V4HlcClock(deviceId = "phone-1")
        val engine = V4SyncEngine(
            serverId = "srv-1",
            profileId = "main",
            deviceId = "phone-1",
            store = store,
            http = V4CoreHttpClient(client, okhttp3.HttpUrl.Builder().scheme("https").host("localhost").build(), "1.0", clock),
            sse = V4SseClient(client, okhttp3.HttpUrl.Builder().scheme("https").host("localhost").build(), "1.0", clock),
            bridge = CompositeV4DomainBridge(),
        )

        engine.invalidate()
        val result = engine.syncOnce("token")
        assertTrue(result is V4SyncRunResult.Failed)
        assertEquals("Engine invalidated", (result as V4SyncRunResult.Failed).reason)
        assertFalse(store.loadState("srv-1", "main").initialSyncCompleted)
    }
}
