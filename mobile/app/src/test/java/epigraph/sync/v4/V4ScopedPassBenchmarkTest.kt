package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import kotlin.time.measureTimedValue

/**
 * One-work scoped local-edit pass on a large library: [V4SyncEngine.syncWithLocalEdits] with a
 * [V4LocalScope] naming a single work, against the real [V4ComicDomainBridge] and
 * [SqlDelightV4SyncStore] on an in-memory database. The fake Core is an OkHttp interceptor.
 *
 * The library is 250 favorites with 200 chapters each by default. `EPIGRAPH_V4_SCOPED_WORKS` and
 * `EPIGRAPH_V4_SCOPED_CHAPTERS` override the size. The pass must finish under [BUDGET_MS].
 */
class V4ScopedPassBenchmarkTest {
    private val works = System.getenv("EPIGRAPH_V4_SCOPED_WORKS")?.toIntOrNull() ?: 250
    private val chaptersPerWork = System.getenv("EPIGRAPH_V4_SCOPED_CHAPTERS")?.toIntOrNull() ?: 200
    private val prefix = "https://mirror.example/manga/"

    @Test
    fun `one-work scoped pass on a large library finishes under the budget`() = runTest {
        val phone = openDatabase()
        populateLibrary(phone.driver, works, chaptersPerWork, prefix)
        val bridge = V4ComicDomainBridge(phone.handler)
        val core = FakeCore(initial = emptyList())
        val store = SqlDelightV4SyncStore(phone.database)
        var generation = 0L
        val engine = benchmarkEngine(store, core, bridge, localEditGeneration = { generation })

        // Full pass: builds the digest baseline and the entity map for the whole library.
        val (initial, initialMs) = measureTimedValue { engine.syncOnce("tok") }
        assertTrue(initial is V4SyncRunResult.Synced, "initial sync: $initial")

        // One chapter read-state change in work 1, the only work the scoped pass names.
        val workKey = V4PortableUrl.canonicalWorkKey("123", "${prefix}1")
        phone.driver.execute(null, "UPDATE chapters SET read = 1 - read WHERE _id = 1", 0)
        generation += 1
        val before = core.records.size
        val scope = V4LocalScope(setOf(workKey))
        val (result, passMs) = measureTimedValue { engine.syncWithLocalEdits("tok") { V4LocalPlan(generation, scope) } }
        assertTrue(result is V4SyncRunResult.Synced, "scoped pass: $result")
        val uploaded = core.records.size - before
        assertEquals(1, uploaded, "one edit must upload one item")

        // Phase breakdown on the settled state: the same reads the pass makes, timed one by one.
        val readMs = measureMs { bridge.readLocalScoped("srv-1", "main", scope) }
        val read = bridge.readLocalScoped("srv-1", "main", scope)
        val loadMs = measureMs { store.loadDigests("srv-1", "main") }
        val hasMs = measureMs { store.hasDigests("srv-1", "main") }
        val commitMs = measureMs { read.commit(V4HlcClock("phone")) }

        println(
            "V4 scoped-pass benchmark works=$works chapters/work=$chaptersPerWork " +
                "initialSync=${initialMs.inWholeMilliseconds} ms " +
                "scopedPass=${passMs.inWholeMilliseconds} ms " +
                "readLocalScoped=$readMs ms loadDigestsAll=$loadMs ms hasDigests=$hasMs ms " +
                "commit=$commitMs ms requests=${core.requestCounts()}",
        )
        assertTrue(
            passMs.inWholeMilliseconds < BUDGET_MS,
            "scoped pass took ${passMs.inWholeMilliseconds} ms, budget $BUDGET_MS ms",
        )
        phone.close()
    }

    private suspend fun measureMs(block: suspend () -> Unit): Long {
        val start = System.nanoTime()
        block()
        return (System.nanoTime() - start) / 1_000_000L
    }

    private fun benchmarkEngine(
        store: SqlDelightV4SyncStore,
        core: FakeCore,
        bridge: V4DomainBridge,
        localEditGeneration: () -> Long = { 0L },
    ): V4SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor { chain -> core.handle(chain.request()) }.build()
        val endpoint = "https://127.0.0.1:4778/".toHttpUrl()
        val engine = V4SyncEngine(
            "srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"), V4SseClient(client, endpoint, "0.1.0"), bridge,
            domainProgress = MemoryV4SyncDomainProgress(),
            localEditGeneration = localEditGeneration,
        )
        engine.useDomainPolicy(
            V4SyncDomainPolicy(
                syncComics = true, syncNovels = false, syncBooks = false,
                reconcileComicRepositories = false, reconcileComicExtensions = false,
                reconcileNovelRepositories = false, reconcileNovelPlugins = false,
            ),
        )
        return engine
    }

    private fun populateLibrary(driver: JdbcSqliteDriver, workCount: Int, chapters: Int, prefix: String) {
        val mangaRows = (1..workCount).map { id -> "($id, 123, '$prefix$id', 'Title $id', 1, 1, 1, 0, 0, 0)" }
        mangaRows.chunked(500).forEach { chunk ->
            driver.execute(
                null,
                "INSERT INTO mangas (_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags) VALUES " +
                    chunk.joinToString(","),
                0,
            )
        }
        val chapterRows = sequence {
            for (work in 1..workCount) for (index in 1..chapters) {
                val id = (work.toLong() - 1) * chapters + index
                yield("($id, $work, '$prefix$work/ch/$index', 'Chapter $index', ${index % 2}, 0, 0, 0, $index, $index, 0, 0)")
            }
        }
        var batch = ArrayList<String>(500)
        for (row in chapterRows) {
            batch += row
            if (batch.size == 500) {
                driver.insertChapters(batch)
                batch = ArrayList(500)
            }
        }
        if (batch.isNotEmpty()) driver.insertChapters(batch)
    }

    private fun JdbcSqliteDriver.insertChapters(rows: List<String>) {
        execute(
            null,
            "INSERT INTO chapters (_id, manga_id, url, name, read, bookmark, last_page_read, pages_left, " +
                "chapter_number, source_order, date_fetch, date_upload) VALUES " + rows.joinToString(","),
            0,
        )
    }

    private fun openDatabase(): OpenDatabase {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        driver.execute(null, "PRAGMA foreign_keys = ON", 0)
        val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
        return OpenDatabase(driver, database, AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO))
    }

    private class OpenDatabase(
        val driver: JdbcSqliteDriver,
        val database: Database,
        val handler: AndroidDatabaseHandler,
    ) {
        fun close() {
            driver.close()
        }
    }

    /** Minimal in-memory Core: capabilities, snapshot, change pages and bulk writes. */
    private class FakeCore(initial: List<V4WireRecord>) {
        val records = ArrayList<V4WireRecord>(initial)
        private val counts = linkedMapOf<String, Int>()
        private val json = V4CoreHttpClient.DEFAULT_JSON

        fun requestCounts(): String = counts.entries.joinToString(" ") { "${it.key}=${it.value}" }

        fun handle(request: Request): Response {
            val path = request.url.encodedPath
            counts[path] = (counts[path] ?: 0) + 1
            val head = records.size.toLong()
            return when (path) {
                "/v4/capabilities" -> ok(request, CAPABILITIES.format(head))
                "/v4/snapshot" -> {
                    val afterSeq = request.url.queryParameter("afterSeq")?.toLong() ?: 0L
                    val limit = request.url.queryParameter("limit")?.toInt()
                    val end = if (limit == null) records.size else minOf(records.size, afterSeq.toInt() + limit)
                    val page = records.subList(afterSeq.toInt(), end).toList()
                    val response = V4SnapshotResponse(
                        profileId = "main",
                        serverSeq = head,
                        minReplayableSeq = 0,
                        serverTimeMs = SERVER_TIME_MS,
                        recordCount = page.size,
                        records = page,
                        hasMore = limit != null && end < records.size,
                        nextAfterSeq = page.lastOrNull()?.serverSeq ?: afterSeq,
                    )
                    ok(request, json.encodeToString(V4SnapshotResponse.serializer(), response))
                }
                "/v4/changes" -> {
                    val since = request.url.queryParameter("sinceSeq")?.toLong() ?: 0L
                    val limit = request.url.queryParameter("limit")?.toInt() ?: 1_000
                    val end = minOf(records.size, since.toInt() + limit)
                    val page = records.subList(since.toInt(), end).toList()
                    val response = V4ChangesResponse(
                        profileId = "main",
                        serverSeq = head,
                        minReplayableSeq = 0,
                        nextSeq = since + page.size,
                        hasMore = end < records.size,
                        serverTimeMs = SERVER_TIME_MS,
                        changes = page,
                    )
                    ok(request, json.encodeToString(V4ChangesResponse.serializer(), response))
                }
                "/v4/sync/bulk" -> {
                    val buffer = okio.Buffer()
                    request.body?.writeTo(buffer)
                    val raw = java.util.zip.GZIPInputStream(buffer.inputStream()).use { it.readBytes() }
                    val batch = json.decodeFromString(V4BatchRequest.serializer(), raw.decodeToString())
                    val expected = batch.expectedServerSeq
                    if (expected != null && expected != head) {
                        return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(409)
                            .message("Conflict").header("X-Epigraph-Server-Time-Ms", SERVER_TIME_MS.toString())
                            .body("""{"error":{"code":"conflict","message":"seq"}}""".toResponseBody(JSON_TYPE))
                            .build()
                    }
                    for (item in batch.items) {
                        records += V4WireRecord(
                            serverSeq = records.size + 1L,
                            domain = item.domain,
                            entityType = item.entityType,
                            entityKey = item.entityKey,
                            deleted = item.deleted,
                            hlc = item.hlc,
                            originDeviceId = "phone",
                            payload = item.payload,
                        )
                    }
                    val summary = V4WriteSummary(
                        serverSeq = records.size.toLong(),
                        serverTimeMs = SERVER_TIME_MS,
                        acceptedCount = batch.items.size,
                        mergedCount = 0,
                        deduplicatedCount = 0,
                        noopCount = 0,
                        rejected = emptyList(),
                    )
                    ok(request, json.encodeToString(V4WriteSummary.serializer(), summary))
                }
                else -> Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(404)
                    .message("Not Found").header("X-Epigraph-Server-Time-Ms", SERVER_TIME_MS.toString())
                    .body("""{"error":{"code":"not_found","message":"$path"}}""".toResponseBody(JSON_TYPE))
                    .build()
            }
        }

        private fun ok(request: Request, body: String): Response =
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .header("X-Epigraph-Server-Time-Ms", SERVER_TIME_MS.toString())
                .body(body.toResponseBody(JSON_TYPE))
                .build()

        private companion object {
            const val SERVER_TIME_MS = 2_000_000L
            val JSON_TYPE = "application/json".toMediaType()
            const val CAPABILITIES =
                """{"protocolVersion":4,"minClientVersion":"0.1.0","profileId":"main","deviceId":"core",""" +
                    """"serverSeq":%d,"minReplayableSeq":0,"serverTimeMs":2000000,""" +
                    """"supportsPagedSnapshot":true,"maxSnapshotPageItems":5000}"""
        }
    }

    private companion object {
        /** A one-work scoped pass must stay under this on a 250-favorite library. */
        const val BUDGET_MS = 2_000L
    }
}
