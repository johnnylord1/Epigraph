package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter
import java.util.zip.GZIPInputStream

private fun inMemoryDatabase(): Database {
    val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
    Database.Schema.create(driver)
    return Database(
        driver = driver,
        mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
        chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
    )
}

private fun okResponse(request: Request, body: String): Response =
    Response.Builder()
        .request(request)
        .protocol(Protocol.HTTP_1_1)
        .code(200)
        .message("OK")
        .header("X-Epigraph-Server-Time-Ms", "2000000")
        .body(body.toResponseBody("application/json".toMediaType()))
        .build()

private fun payload(title: String): JsonObject = buildJsonObject { put("title", JsonPrimitive(title)) }

private fun keys(items: List<JsonObject>): List<String> =
    items.map { it.getValue("entityKey").jsonPrimitive.content }

private fun decodeBulkItems(request: Request): List<JsonObject> {
    val buffer = Buffer()
    request.body!!.writeTo(buffer)
    val text = GZIPInputStream(buffer.inputStream()).bufferedReader().use { it.readText() }
    return Json.parseToJsonElement(text).jsonObject.getValue("items").jsonArray.map { it.jsonObject }
}

/**
 * Stateful fake of one comic-like domain plus a fake Core. The bridge's local state is [local];
 * remote changes are queued with [remoteUpsert] / [remoteDelete] and delivered on the next pull.
 */
private class BaselineRig(initialSyncCompleted: Boolean = true) {
    val store = SqlDelightV4SyncStore(inMemoryDatabase(), wallClockMs = { 1_000_000L })
    var generation = 0L
    var serverSeq = 5L
    val local = linkedMapOf<String, JsonObject>()
    var onExport: () -> Unit = {}
    var onDigest: () -> Unit = {}
    private val uploadedItems = mutableListOf<JsonObject>()
    private val pendingChanges = mutableListOf<String>()

    private val bridge = object : V4DomainBridge {
        override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock): List<V4OutgoingItem> {
            onExport()
            return local.map { (k, p) -> V4ItemDraft("comics", "comic.work", k, p) }.stamp(clock)
        }

        override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> {
            onDigest()
            return local.map { (k, p) ->
                val draft = V4ItemDraft("comics", "comic.work", k, p)
                V4DigestedItem(draft.key, V4LocalDigest.of(draft), deleted = false)
            }
        }

        override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
            for (record in records) {
                if (record.deleted) {
                    local.remove(record.entityKey)
                } else {
                    local[record.entityKey] = (record.payload as? JsonObject) ?: JsonObject(emptyMap())
                }
            }
        }
    }

    private val client = OkHttpClient.Builder().addInterceptor { chain ->
        val request = chain.request()
        when (request.url.encodedPath) {
            "/v4/sync/bulk" -> {
                val items = decodeBulkItems(request)
                uploadedItems += items
                okResponse(
                    request,
                    """{"serverSeq":$serverSeq,"serverTimeMs":2000000,"acceptedCount":${items.size},"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""",
                )
            }
            "/v4/changes" -> {
                val changes = pendingChanges.joinToString(",")
                pendingChanges.clear()
                okResponse(
                    request,
                    """{"profileId":"main","serverSeq":$serverSeq,"minReplayableSeq":0,"nextSeq":$serverSeq,"hasMore":false,"serverTimeMs":2000000,"changes":[$changes]}""",
                )
            }
            "/v4/capabilities" -> okResponse(
                request,
                """{"profileId":"main","deviceId":"srv-1","serverSeq":$serverSeq,"minReplayableSeq":0,"serverTimeMs":2000000}""",
            )
            "/v4/snapshot" -> okResponse(
                request,
                """{"profileId":"main","serverSeq":$serverSeq,"minReplayableSeq":0,"serverTimeMs":2000000,"recordCount":0,"records":[]}""",
            )
            else -> error("Unexpected call: ${request.url.encodedPath}")
        }
    }.build()

    val engine: V4SyncEngine

    init {
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 5, initialSyncCompleted = initialSyncCompleted))
        val url = "https://127.0.0.1:4777/".toHttpUrl()
        engine = V4SyncEngine(
            "srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, url, "0.1.0"),
            V4SseClient(client, url, "0.1.0"),
            bridge,
            localEditGeneration = { generation },
        )
        engine.useDomainPolicy(
            V4SyncDomainPolicy(
                syncComics = true, syncNovels = true, syncBooks = true,
                reconcileComicRepositories = false, reconcileComicExtensions = false,
                reconcileNovelRepositories = false, reconcileNovelPlugins = false,
            ),
        )
    }

    /** Runs one local-edit pass and returns the items it uploaded. */
    suspend fun pass(): List<JsonObject> {
        uploadedItems.clear()
        val result = engine.syncWithLocalEdits("tok")
        check(result is V4SyncRunResult.Synced) { "Expected Synced, got $result" }
        return uploadedItems.toList()
    }

    fun remoteUpsert(entityKey: String, title: String) =
        queueChange(entityKey, deleted = false, payloadJson = """{"title":"$title"}""")

    fun remoteDelete(entityKey: String) = queueChange(entityKey, deleted = true, payloadJson = "{}")

    private fun queueChange(entityKey: String, deleted: Boolean, payloadJson: String) {
        serverSeq += 1
        pendingChanges += """{"serverSeq":$serverSeq,"domain":"comics","entityType":"comic.work","entityKey":"$entityKey","deleted":$deleted,"originDeviceId":"desktop","hlc":{"tsMs":$serverSeq,"counter":0,"deviceId":"desktop"},"payload":$payloadJson}"""
    }
}

class V4LocalEditBaselineTest {
    @Test
    fun `second pass uploads only the item edited between passes`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.local["b"] = payload("B1")
        assertEquals(setOf("a", "b"), keys(rig.pass()).toSet())

        rig.local["a"] = payload("A2")
        assertEquals(listOf("a"), keys(rig.pass()))
    }

    @Test
    fun `remote tombstone is not echoed and not resurrected by a later unrelated edit`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.local["b"] = payload("B1")
        assertEquals(setOf("a", "b"), keys(rig.pass()).toSet())

        rig.local["b"] = payload("B2")
        rig.remoteDelete("a")
        assertEquals(listOf("b"), keys(rig.pass()))
        assertFalse(rig.local.containsKey("a"))

        rig.local["c"] = payload("C1")
        assertEquals(listOf("c"), keys(rig.pass()))
        assertFalse(rig.local.containsKey("a"))
    }

    @Test
    fun `empty digest table after upgrade uploads with the baseline clock`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")

        val uploaded = rig.pass().single()

        val hlc = uploaded.getValue("hlc").jsonObject
        assertEquals(1L, hlc.getValue("tsMs").jsonPrimitive.content.toLong())
        assertEquals(0L, hlc.getValue("counter").jsonPrimitive.content.toLong())
    }

    @Test
    fun `remove then re-add of an identical payload uploads with a fresh clock`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.pass()

        rig.local.remove("a")
        val tombstone = rig.pass().single()
        assertEquals("a", tombstone.getValue("entityKey").jsonPrimitive.content)
        assertTrue(tombstone.getValue("deleted").jsonPrimitive.content.toBoolean())

        rig.local["a"] = payload("A1")
        val readded = rig.pass().single()
        val tsMs = readded.getValue("hlc").jsonObject.getValue("tsMs").jsonPrimitive.content.toLong()
        assertTrue(tsMs > 1L, "Re-added item must not reuse the baseline clock, was $tsMs")
    }

    @Test
    fun `local edit during baseline refresh aborts the refresh and is uploaded on the next pass`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.pass()

        rig.onDigest = {
            rig.onDigest = {}
            rig.local["a"] = payload("A2")
            rig.generation = rig.generation + 1
        }
        rig.engine.refreshBaseline(0L)

        assertEquals(listOf("a"), keys(rig.pass()))
    }

    @Test
    fun `end-of-pass refresh records remote-applied items so they are not echoed`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.pass()

        rig.remoteUpsert("c", "C1")
        rig.pass()
        assertTrue(rig.store.loadDigests("srv-1", "main").containsKey(V4DigestKey("comics", "comic.work", "c")))

        assertEquals(emptyList<String>(), keys(rig.pass()))
    }

    @Test
    fun `a generation bump during the pass aborts the end-of-pass refresh so the edit is uploaded next pass`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = payload("A1")
        rig.pass()

        rig.onExport = {
            rig.onExport = {}
            rig.local["a"] = payload("A2")
            rig.generation = rig.generation + 1
        }
        // The pass captured generation 0 before the export bumped it, so its refresh must not run
        // and the stored digest stays at A1.
        assertEquals(emptyList<String>(), keys(rig.pass()))
        assertEquals(listOf("a"), keys(rig.pass()))
    }

    @Test
    fun `remote apply during a pending edit is not re-uploaded by a later pass`() = runTest {
        val rig = BaselineRig()
        rig.local["w"] = payload("A")
        rig.pass()

        // Desktop moves work A -> B while a local edit is pending, so syncOnce skips its baseline refresh.
        rig.generation = 1L
        rig.remoteUpsert("w", "B")
        assertTrue(rig.engine.syncOnce("tok") is V4SyncRunResult.Synced)
        assertEquals(payload("B"), rig.local["w"])

        // Desktop then moves B -> C while the phone is offline. The phone makes an unrelated edit.
        rig.local["x"] = payload("X1")
        rig.generation = 2L
        assertEquals(listOf("x"), keys(rig.pass()))
    }

    @Test
    fun `full merge while an edit is pending leaves a recorded baseline`() = runTest {
        val rig = BaselineRig(initialSyncCompleted = false)
        rig.local["a"] = payload("A1")
        rig.generation = 1L

        assertTrue(rig.engine.syncOnce("tok") is V4SyncRunResult.Synced)

        assertTrue(rig.store.loadDigests("srv-1", "main").containsKey(V4DigestKey("comics", "comic.work", "a")))
    }
}
