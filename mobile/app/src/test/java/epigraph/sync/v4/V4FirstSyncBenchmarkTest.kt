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
import java.util.zip.GZIPInputStream
import kotlin.time.measureTimedValue

/**
 * Synthetic first-sync benchmark on the JVM: the real [V4SyncEngine], [V4ComicDomainBridge] and
 * [SqlDelightV4SyncStore] run against an in-memory fake Core served through OkHttp interceptors.
 *
 * Two directions are measured: an empty phone importing a full desktop library (import) and a full
 * phone pairing with a Core that already holds a few records (send). Each run prints per-phase
 * timings and checks logical equality (digests keyed by entity key, and the Core's key set).
 *
 * Sizes default to 1,000 works x 100 chapters; `EPIGRAPH_V4_BENCH_WORKS` and
 * `EPIGRAPH_V4_BENCH_CHAPTERS` override them for quick local runs.
 */
/** Turns a local export item into the record a Core would hold after accepting it. */
private fun V4OutgoingItem.toWire(seq: Long, origin: String) = V4WireRecord(
    serverSeq = seq,
    domain = domain,
    entityType = entityType,
    entityKey = entityKey,
    deleted = deleted,
    hlc = hlc,
    originDeviceId = origin,
    payload = payload,
)

class V4FirstSyncBenchmarkTest {
    private val works = System.getenv("EPIGRAPH_V4_BENCH_WORKS")?.toIntOrNull() ?: 1_000
    private val chaptersPerWork = System.getenv("EPIGRAPH_V4_BENCH_CHAPTERS")?.toIntOrNull() ?: 100
    private val extraCoreWorks = 33

    @Test
    fun `import from full desktop library into an empty phone`() = runTest {
        val source = openDatabase()
        populateLibrary(source.driver, works, chaptersPerWork, prefix = "https://mirror.example/manga/")
        val sourceBridge = V4ComicDomainBridge(source.handler)
        val exported = sourceBridge.exportLocalSnapshot("core", "main", V4HlcClock("desktop"))
        val core = FakeCore(
            initial = exported.mapIndexed { index, item -> item.toWire(index + 1L, "desktop") },
        )

        val phone = openDatabase()
        val store = SqlDelightV4SyncStore(phone.database)
        val timings = PhaseTimings()
        val engine = benchmarkEngine(store, core, V4ComicDomainBridge(phone.handler).timed(timings))

        val sampler = HeapSampler().start()
        val (result, total) = measureTimedValue { engine.syncOnce("tok") }
        val peakMb = sampler.stop()
        assertTrue(result is V4SyncRunResult.Synced, "sync result: $result")
        report("import", total.inWholeMilliseconds, timings, core, peakMb)

        // Logical equality: the phone holds the same digests as the desktop, keyed by entity key.
        val expected = sourceBridge.digestSnapshot("core", "main").associate { it.key to it.digest }
        val actual = phone.digests(store)
        assertEquals(expected.size, actual.size, "digest row count")
        assertEquals(expected, actual.mapValues { it.value.digest }, "digests keyed by entity key")
        assertEquals(
            exported.map { it.entityType to it.entityKey }.toSet(),
            V4ComicDomainBridge(phone.handler).exportLocalSnapshot("core", "main", V4HlcClock("phone"))
                .map { it.entityType to it.entityKey }.toSet(),
            "phone library keys",
        )
        source.close()
        phone.close()
    }

    @Test
    fun `send full phone library to a Core that already holds records`() = runTest {
        val phone = openDatabase()
        populateLibrary(phone.driver, works, chaptersPerWork, prefix = "https://mirror.example/manga/")
        val phoneBridge = V4ComicDomainBridge(phone.handler)
        val phoneKeys = phoneBridge.exportLocalSnapshot("srv-1", "main", V4HlcClock("phone"))
            .map { it.entityType to it.entityKey }.toSet()

        // A desktop that already holds a few works the phone does not have yet.
        val extra = openDatabase()
        // Keys drop the host, so the extra works use a different path to avoid colliding with the phone's works.
        populateLibrary(extra.driver, extraCoreWorks, 0, prefix = "https://extra.example/extra-manga/")
        val extraItems = V4ComicDomainBridge(extra.handler).exportLocalSnapshot("core", "main", V4HlcClock("desktop"))
        val core = FakeCore(initial = extraItems.mapIndexed { index, item -> item.toWire(index + 1L, "desktop") })

        val store = SqlDelightV4SyncStore(phone.database)
        val timings = PhaseTimings()
        val engine = benchmarkEngine(store, core, phoneBridge.timed(timings))

        val sampler = HeapSampler().start()
        val (result, total) = measureTimedValue { engine.syncOnce("tok") }
        val peakMb = sampler.stop()
        assertTrue(result is V4SyncRunResult.Synced, "sync result: $result")
        report("send", total.inWholeMilliseconds, timings, core, peakMb)

        // Logical equality: the Core holds the phone's library plus the extra works, and the phone
        // imported the extra works. Digests are compared with the phone's own export.
        val coreKeys = core.liveKeys()
        assertEquals(phoneKeys + extraItems.map { it.entityType to it.entityKey }.toSet(), coreKeys, "core key set")
        val expectedDigests = phoneBridge.digestSnapshot("srv-1", "main").associate { it.key to it.digest }
        assertEquals(expectedDigests, phone.digests(store).mapValues { it.value.digest }, "digests keyed by entity key")
        assertEquals(works + extraCoreWorks, expectedDigests.keys.count { it.entityType == "comic.work" })
        extra.close()
        phone.close()
    }

    @Test
    fun `one local edit after a full sync is uploaded by a local-edit pass`() = runTest {
        val phone = openDatabase()
        populateLibrary(phone.driver, works, chaptersPerWork, prefix = "https://mirror.example/manga/")
        val phoneBridge = V4ComicDomainBridge(phone.handler)
        val core = FakeCore(initial = emptyList())
        val store = SqlDelightV4SyncStore(phone.database)
        var generation = 0L
        val engine = benchmarkEngine(store, core, phoneBridge, localEditGeneration = { generation })
        assertTrue(engine.syncOnce("tok") is V4SyncRunResult.Synced)
        val before = core.records.size

        // One chapter read-state change on the phone, then the local-edit pass that must send it.
        phone.driver.execute(null, "UPDATE chapters SET read = 1 - read WHERE _id = 1", 0)
        generation += 1
        val sampler = HeapSampler().start()
        val (result, total) = measureTimedValue { engine.syncWithLocalEdits("tok") }
        val peakMb = sampler.stop()
        assertTrue(result is V4SyncRunResult.Synced, "sync result: $result")
        val uploaded = core.records.size - before
        println(
            "V4 first-sync benchmark [one-edit] works=$works chapters/work=$chaptersPerWork " +
                "total=${total.inWholeMilliseconds} ms uploaded=$uploaded peakHeapMb=$peakMb " +
                "requests=${core.requestCounts()}",
        )
        assertTrue(uploaded in 1..2, "one edit must upload one or two items, was $uploaded")
        phone.close()
    }

    private fun report(direction: String, totalMs: Long, timings: PhaseTimings, core: FakeCore, peakMb: Long) {
        println(
            "V4 first-sync benchmark [$direction] works=$works chapters/work=$chaptersPerWork " +
                "total=${totalMs} ms peakHeapMb=$peakMb " + timings.render() +
                " requests=${core.requestCounts()} coreRecords=${core.records.size}",
        )
    }

    /** Samples used JVM heap on a daemon thread every 5 ms and keeps the highest reading, in MiB. */
    private class HeapSampler {
        @Volatile private var peakBytes = 0L
        @Volatile private var running = false
        private val thread = Thread {
            val runtime = Runtime.getRuntime()
            while (running) {
                peakBytes = maxOf(peakBytes, runtime.totalMemory() - runtime.freeMemory())
                Thread.sleep(5)
            }
        }.apply { isDaemon = true }

        fun start(): HeapSampler = apply {
            running = true
            thread.start()
        }

        fun stop(): Long {
            running = false
            thread.join()
            return peakBytes / (1024 * 1024)
        }
    }

    private fun benchmarkEngine(
        store: SqlDelightV4SyncStore,
        core: FakeCore,
        bridge: V4DomainBridge,
        localEditGeneration: () -> Long = { 0L },
    ): V4SyncEngine {
        val client = OkHttpClient.Builder().addInterceptor { chain -> core.handle(chain.request()) }.build()
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
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
        val mangaRows = (1..workCount).map { id ->
            "($id, 123, '$prefix$id', 'Title $id', 1, 1, 1, 0, 0, 0)"
        }
        mangaRows.chunked(500).forEach { chunk ->
            driver.execute(
                null,
                "INSERT INTO mangas (_id, source, url, title, status, favorite, initialized, viewer, hide_title, chapter_flags) VALUES " +
                    chunk.joinToString(","),
                0,
            )
        }
        if (chapters == 0) return
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

    private inner class OpenDatabase(
        val driver: JdbcSqliteDriver,
        val database: Database,
        val handler: AndroidDatabaseHandler,
    ) {
        fun digests(store: SqlDelightV4SyncStore): Map<V4DigestKey, V4StoredDigest> = store.loadDigests("srv-1", "main")

        fun close() {
            driver.close()
        }
    }

    /** Accumulates call counts and wall time per bridge phase. */
    private class PhaseTimings {
        private val counts = linkedMapOf<String, Int>()
        private val millis = linkedMapOf<String, Long>()

        fun record(name: String, nanos: Long) {
            counts[name] = (counts[name] ?: 0) + 1
            millis[name] = (millis[name] ?: 0L) + nanos / 1_000_000L
        }

        var appliedRecords = 0
        var appliedWorks = 0

        fun render(): String = millis.keys.joinToString(" ") { "$it=${millis[it]}ms/${counts[it]}x" } +
            " appliedRecords=$appliedRecords appliedWorks=$appliedWorks"
    }

    private fun V4DomainBridge.timed(timings: PhaseTimings): V4DomainBridge {
        val delegate = this
        return object : V4DomainBridge {
            private suspend fun <T> phase(name: String, block: suspend () -> T): T {
                val start = System.nanoTime()
                try {
                    return block()
                } finally {
                    timings.record(name, System.nanoTime() - start)
                }
            }

            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) =
                phase("export") { delegate.exportLocalSnapshot(serverId, profileId, clock) }

            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
                timings.appliedRecords += records.size
                timings.appliedWorks += records.count { it.entityType == "comic.work" }
                phase("apply") { delegate.applyRemoteRecords(serverId, profileId, records) }
            }

            override suspend fun digestSnapshot(serverId: String, profileId: String) =
                phase("digestAll") { delegate.digestSnapshot(serverId, profileId) }

            override suspend fun digestAffected(serverId: String, profileId: String, records: List<V4WireRecord>) =
                phase("digestAffected") { delegate.digestAffected(serverId, profileId, records) }

            override suspend fun exportAndDigest(serverId: String, profileId: String, clock: V4HlcClock) =
                phase("exportAndDigest") { delegate.exportAndDigest(serverId, profileId, clock) }
        }
    }

    /**
     * In-memory Core: records are indexed by `serverSeq - 1`. It serves capabilities, paged
     * snapshots, change pages and bulk writes, and counts requests by path.
     */
    private class FakeCore(initial: List<V4WireRecord>) {
        val records = ArrayList<V4WireRecord>(initial)
        private val counts = linkedMapOf<String, Int>()
        private val json = V4CoreHttpClient.DEFAULT_JSON

        fun requestCounts(): String = counts.entries.joinToString(" ") { "${it.key}=${it.value}" }

        fun liveKeys(): Set<Pair<String, String>> {
            val latest = LinkedHashMap<Pair<String, String>, Boolean>()
            for (record in records) latest[record.entityType to record.entityKey] = record.deleted
            return latest.filterValues { !it }.keys
        }

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
                    val nextAfterSeq = page.lastOrNull()?.serverSeq ?: afterSeq
                    val response = V4SnapshotResponse(
                        profileId = "main",
                        serverSeq = head,
                        minReplayableSeq = 0,
                        serverTimeMs = SERVER_TIME_MS,
                        recordCount = page.size,
                        records = page,
                        hasMore = limit != null && end < records.size,
                        nextAfterSeq = nextAfterSeq,
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
                    val raw = GZIPInputStream(buffer.inputStream()).use { it.readBytes() }
                    val batch = json.decodeFromString(V4BatchRequest.serializer(), raw.decodeToString())
                    val expected = batch.expectedServerSeq
                    if (expected != null && expected != head) {
                        return Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(409)
                            .message("Conflict").header("X-Epigraph-Server-Time-Ms", SERVER_TIME_MS.toString())
                            .body("""{"error":{"code":"conflict","message":"seq"}}""".toResponseBody(JSON_TYPE))
                            .build()
                    }
                    for (item in batch.items) {
                        records += item.toWire(records.size + 1L, "phone")
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
}
