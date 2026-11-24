package epigraph.sync.v4

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.memoColumnAdapter

class V4SyncEngineTest {
    private fun createInMemoryDatabase(): Database {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY)
        Database.Schema.create(driver)
        return Database(
            driver = driver,
            mangasAdapter = Mangas.Adapter(memoAdapter = memoColumnAdapter),
            chaptersAdapter = Chapters.Adapter(memoAdapter = memoColumnAdapter),
        )
    }

    private fun jsonResponse(request: okhttp3.Request, code: Int, body: String, etag: String? = null): Response =
        Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message(if (code in 200..299) "OK" else "ERR")
            .apply { if (etag != null) header("ETag", etag) }
            .header("X-Epigraph-Server-Time-Ms", "2000000")
            .body(body.toResponseBody("application/json".toMediaType()))
            .build()

    @Test
    fun `incremental pull ignores disabled domains`() = runTest {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase())
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 5, initialSyncCompleted = true))
        val applied = mutableListOf<V4WireRecord>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            jsonResponse(request, 200, """{"profileId":"main","serverSeq":7,"minReplayableSeq":0,"nextSeq":7,"hasMore":false,"serverTimeMs":2000000,"changes":[
                {"serverSeq":6,"domain":"books","entityType":"book.work","entityKey":"${"a".repeat(64)}","deleted":false,"originDeviceId":"desktop","hlc":{"tsMs":6,"counter":0,"deviceId":"desktop"},"payload":{}},
                {"serverSeq":7,"domain":"comics","entityType":"comic.work","entityKey":"src:/work","deleted":false,"originDeviceId":"desktop","hlc":{"tsMs":7,"counter":0,"deviceId":"desktop"},"payload":{}}]}""")
        }.build()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = emptyList<V4OutgoingItem>()
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) { applied += records }
        }
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
        val engine = V4SyncEngine("srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"), V4SseClient(client, endpoint, "0.1.0"), bridge)
        engine.useDomainPolicy(V4SyncDomainPolicy(syncComics = true, syncNovels = false, syncBooks = false,
            reconcileComicRepositories = false, reconcileComicExtensions = false,
            reconcileNovelRepositories = false, reconcileNovelPlugins = false))

        val result = engine.syncOnce("tok") as V4SyncRunResult.Synced

        assertEquals(1, result.appliedCount)
        assertEquals(listOf("comics"), applied.map { it.domain })
    }

    @Test
    fun `re-enabled domain gets a scoped baseline snapshot catch-up`() = runTest {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase())
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 5, initialSyncCompleted = true))
        val progress = MemoryV4SyncDomainProgress().also { it.save("srv-1", "main", setOf("comics")) }
        val paths = mutableListOf<String>()
        val applied = mutableListOf<V4WireRecord>()
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            paths += request.url.encodedPath
            when (request.url.encodedPath) {
                "/v4/sync/bulk" -> jsonResponse(request, 200, """{"serverSeq":6,"serverTimeMs":2000000,"acceptedCount":1,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""")
                "/v4/snapshot" -> jsonResponse(request, 200, """{"profileId":"main","serverSeq":6,"minReplayableSeq":0,"serverTimeMs":2000000,"recordCount":2,"records":[
                    {"serverSeq":5,"domain":"comics","entityType":"comic.work","entityKey":"src:/work","deleted":false,"originDeviceId":"desktop","hlc":{"tsMs":5,"counter":0,"deviceId":"desktop"},"payload":{}},
                    {"serverSeq":6,"domain":"books","entityType":"book.work","entityKey":"${"b".repeat(64)}","deleted":false,"originDeviceId":"desktop","hlc":{"tsMs":6,"counter":0,"deviceId":"desktop"},"payload":{}}]}""")
                "/v4/changes" -> jsonResponse(request, 200, """{"profileId":"main","serverSeq":6,"minReplayableSeq":0,"nextSeq":6,"hasMore":false,"serverTimeMs":2000000,"changes":[]}""")
                else -> error("Unexpected path ${request.url.encodedPath}")
            }
        }.build()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = listOf(
                V4OutgoingItem(domain = "comics", entityType = "comic.work", entityKey = "src:/work", hlc = clock.next()),
                V4OutgoingItem(domain = "books", entityType = "book.work", entityKey = "${"b".repeat(64)}", hlc = clock.next()),
            )
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) { applied += records }
        }
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
        val engine = V4SyncEngine("srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"), V4SseClient(client, endpoint, "0.1.0"), bridge,
            domainProgress = progress)
        engine.useDomainPolicy(V4SyncDomainPolicy(syncComics = true, syncNovels = false, syncBooks = true,
            reconcileComicRepositories = false, reconcileComicExtensions = false,
            reconcileNovelRepositories = false, reconcileNovelPlugins = false))

        val result = engine.syncOnce("tok")

        assertTrue(result is V4SyncRunResult.Synced)
        assertEquals(listOf("books"), applied.map { it.domain })
        assertEquals(setOf("comics", "books"), progress.load("srv-1", "main"))
        assertTrue(paths.contains("/v4/sync/bulk"))
        assertTrue(paths.contains("/v4/snapshot"))
    }

    @Test
    fun `outbox drain leaves disabled domain rows pending`() = runTest {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase())
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 5, initialSyncCompleted = true))
        store.enqueueOutbox("srv-1", "main", "comics", "comic.chapter", "src:/work|/ch",
            false, V4Hlc(6, 0, "phone"), buildJsonObject { put("isRead", JsonPrimitive(true)) }, "comic-mutation")
        store.enqueueOutbox("srv-1", "main", "books", "book.work", "${"e".repeat(64)}",
            false, V4Hlc(7, 0, "phone"), buildJsonObject { put("title", JsonPrimitive("Local")) }, "book-mutation")
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            when (request.url.encodedPath) {
                "/v4/deltas" -> jsonResponse(request, 200, """{"serverSeq":6,"serverTimeMs":2000000,"acceptedCount":1,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""")
                "/v4/changes" -> jsonResponse(request, 200, """{"profileId":"main","serverSeq":6,"minReplayableSeq":0,"nextSeq":6,"hasMore":false,"serverTimeMs":2000000,"changes":[]}""")
                else -> error("Unexpected path ${request.url.encodedPath}")
            }
        }.build()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = emptyList<V4OutgoingItem>()
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) = Unit
        }
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
        val engine = V4SyncEngine("srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"), V4SseClient(client, endpoint, "0.1.0"), bridge)
        engine.useDomainPolicy(V4SyncDomainPolicy(syncComics = true, syncNovels = false, syncBooks = false,
            reconcileComicRepositories = false, reconcileComicExtensions = false,
            reconcileNovelRepositories = false, reconcileNovelPlugins = false))

        val result = engine.syncOnce("tok") as V4SyncRunResult.Synced

        assertEquals(1, result.uploadedCount)
        assertEquals(0L, result.pendingOutboxCount)
        assertEquals(1L, store.countPendingOutbox("srv-1", "main"))
    }

    @Test
    fun `disabling a domain while serverSeq advances prunes domainProgress so re-enabling triggers catch-up and clear wipes it`() = runTest {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase())
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 5, initialSyncCompleted = true))
        val progress = MemoryV4SyncDomainProgress().also { it.save("srv-1", "main", setOf("comics", "books")) }
        val paths = mutableListOf<String>()
        val applied = mutableListOf<V4WireRecord>()
        var currentSeq = 5L
        val client = OkHttpClient.Builder().addInterceptor { chain ->
            val request = chain.request()
            paths += request.url.encodedPath
            when (request.url.encodedPath) {
                "/v4/changes" -> {
                    currentSeq = 6L
                    jsonResponse(request, 200, """{"profileId":"main","serverSeq":6,"minReplayableSeq":0,"nextSeq":6,"hasMore":false,"serverTimeMs":2000000,"changes":[]}""")
                }
                "/v4/sync/bulk" -> jsonResponse(request, 200, """{"serverSeq":6,"serverTimeMs":2000000,"acceptedCount":0,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""")
                "/v4/snapshot" -> jsonResponse(request, 200, """{"profileId":"main","serverSeq":6,"minReplayableSeq":0,"serverTimeMs":2000000,"recordCount":1,"records":[
                    {"serverSeq":6,"domain":"books","entityType":"book.work","entityKey":"${"b".repeat(64)}","deleted":false,"originDeviceId":"desktop","hlc":{"tsMs":6,"counter":0,"deviceId":"desktop"},"payload":{}}]}""")
                else -> error("Unexpected path ${request.url.encodedPath}")
            }
        }.build()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = emptyList<V4OutgoingItem>()
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) { applied += records }
        }
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
        val engine = V4SyncEngine("srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"), V4SseClient(client, endpoint, "0.1.0"), bridge,
            domainProgress = progress)

        // Disable books while serverSeq advances 5 -> 6.
        engine.useDomainPolicy(V4SyncDomainPolicy(syncComics = true, syncNovels = false, syncBooks = false,
            reconcileComicRepositories = false, reconcileComicExtensions = false,
            reconcileNovelRepositories = false, reconcileNovelPlugins = false))
        assertTrue(engine.syncOnce("tok") is V4SyncRunResult.Synced)
        assertEquals(setOf("comics"), progress.load("srv-1", "main"))
        assertFalse(paths.contains("/v4/snapshot"))

        // Re-enable books: must trigger snapshot catch-up.
        engine.useDomainPolicy(V4SyncDomainPolicy(syncComics = true, syncNovels = false, syncBooks = true,
            reconcileComicRepositories = false, reconcileComicExtensions = false,
            reconcileNovelRepositories = false, reconcileNovelPlugins = false))
        assertTrue(engine.syncOnce("tok") is V4SyncRunResult.Synced)
        assertEquals(listOf("books"), applied.map { it.domain })
        assertEquals(setOf("comics", "books"), progress.load("srv-1", "main"))
        assertTrue(paths.contains("/v4/snapshot"))

        // Clearing server state removes domain progress for that server.
        store.clearServerState("srv-1", progress)
        assertEquals(null, progress.load("srv-1", "main"))
    }

    @Test
    fun `initial sync uploads bulk snapshot, applies remote snapshot, and subsequent empty reconnect is 1-call no-op`() = runTest {
        val db = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        val calls = mutableListOf<String>()

        val mockClient = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val req = chain.request()
                val path = req.url.encodedPath
                calls += "${req.method} $path"
                when {
                    path == "/v4/capabilities" -> jsonResponse(
                        req,
                        200,
                        """{"protocolVersion":4,"minClientVersion":"0.1.0","profileId":"main","deviceId":"android-1","serverSeq":5,"minReplayableSeq":0,"serverTimeMs":2000000}""",
                    )
                    path == "/v4/sync/bulk" -> {
                        assertEquals("gzip", req.header("Content-Encoding"))
                        jsonResponse(
                            req,
                            200,
                            """{"serverSeq":7,"serverTimeMs":2000000,"acceptedCount":2,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""",
                        )
                    }
                    path == "/v4/snapshot" -> jsonResponse(
                        req,
                        200,
                        """{"protocolVersion":4,"profileId":"main","serverSeq":7,"minReplayableSeq":0,"serverTimeMs":2000000,"recordCount":1,"records":[{"serverSeq":7,"domain":"comics","entityType":"comic.work","entityKey":"src1:/manga/a","deleted":false,"hlc":{"tsMs":2000000,"counter":0,"deviceId":"desktop-1"},"originDeviceId":"desktop-1","payload":{"title":"Remote Comic"},"updatedAtMs":2000000}]}""",
                        etag = "\"v4:main:all:t1:7\"",
                    )
                    path == "/v4/changes" -> jsonResponse(
                        req,
                        200,
                        """{"protocolVersion":4,"profileId":"main","serverSeq":7,"minReplayableSeq":0,"nextSeq":7,"hasMore":false,"serverTimeMs":2000000,"changes":[]}""",
                    )
                    else -> error("Unexpected call: ${req.method} $path")
                }
            })
            .build()

        val applied = mutableListOf<V4WireRecord>()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(
                serverId: String,
                profileId: String,
                clock: V4HlcClock,
            ): List<V4OutgoingItem> = listOf(
                V4OutgoingItem(
                    domain = "comics",
                    entityType = "comic.work",
                    entityKey = "src1:/manga/local",
                    hlc = clock.next(),
                    payload = buildJsonObject { put("title", JsonPrimitive("Local Comic")) },
                ),
            )

            override suspend fun applyRemoteRecords(
                serverId: String,
                profileId: String,
                records: List<V4WireRecord>,
            ) {
                applied += records
            }
        }

        val clock = V4HlcClock("android-1", wallClockMs = { 1_000_000L })
        val http = V4CoreHttpClient(mockClient, "https://127.0.0.1:4777/".toHttpUrl(), "0.1.0", clock)
        val sse = V4SseClient(mockClient, "https://127.0.0.1:4777/".toHttpUrl(), "0.1.0", clock)
        val engine = V4SyncEngine("srv-1", "main", "android-1", store, http, sse, bridge)

        // 1. Initial sync
        val first = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertEquals(7L, first.serverSeq)
        assertEquals(2, first.uploadedCount)
        assertEquals(1, first.appliedCount)
        assertFalse(first.wasNoOpReconnect)
        assertEquals(1, applied.size)

        // 2. Empty reconnect -> ONLY 1 HTTP call (/v4/changes) and wasNoOpReconnect = true!
        calls.clear()
        val second = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertTrue(second.wasNoOpReconnect)
        assertEquals(listOf("GET /v4/changes"), calls)
    }

    @Test
    fun `incremental sync applies canonical merges even when the local device wrote the record`() = runTest {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase())
        store.saveState(V4SyncCursorState("srv-1", "main", serverSeq = 6L, initialSyncCompleted = true))
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                assertEquals("/v4/changes", request.url.encodedPath)
                jsonResponse(request, 200, """
                    {"protocolVersion":4,"profileId":"main","serverSeq":7,"minReplayableSeq":0,
                    "nextSeq":7,"hasMore":false,"serverTimeMs":2000000,"changes":[
                    {"serverSeq":7,"domain":"comics","entityType":"comic.chapter",
                    "entityKey":"123:/manga/a|/ch/1","deleted":false,"originDeviceId":"android-1",
                    "hlc":{"tsMs":2000000,"counter":0,"deviceId":"android-1"},
                    "payload":{"isRead":true,"lastPageRead":18,"isBookmarked":true}}]}
                """.trimIndent())
            }
            .build()
        val applied = mutableListOf<V4WireRecord>()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(
                serverId: String,
                profileId: String,
                clock: V4HlcClock,
            ): List<V4OutgoingItem> = error("Unexpected full sync")

            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
                applied += records
            }
        }
        val endpoint = "https://127.0.0.1:4777/".toHttpUrl()
        val engine = V4SyncEngine(
            "srv-1", "main", "android-1", store,
            V4CoreHttpClient(client, endpoint, "0.1.0"),
            V4SseClient(client, endpoint, "0.1.0"),
            bridge,
        )

        val result = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertEquals(1, result.appliedCount)
        assertEquals(JsonPrimitive(true), (applied.single().payload as kotlinx.serialization.json.JsonObject)["isBookmarked"])
        assertEquals(7L, store.loadState("srv-1", "main").serverSeq)
    }

    @Test
    fun `outbox coalesces rapid edits and isolates per-item rejection without dropping valid neighbors`() = runTest {
        val db = createInMemoryDatabase()
        val store = SqlDelightV4SyncStore(db, wallClockMs = { 1_000_000L })
        store.saveState(
            V4SyncCursorState(
                serverId = "srv-1",
                profileId = "main",
                serverSeq = 10L,
                initialSyncCompleted = true,
            ),
        )

        val hlc1 = V4Hlc(1_000_001L, 0L, "android-1")
        val hlc2 = V4Hlc(1_000_002L, 0L, "android-1")
        val hlc3 = V4Hlc(1_000_003L, 0L, "android-1")

        // Two rapid page turns on the same chapter coalesce into 1 outbox entry.
        store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.chapter",
            entityKey = "src1:/w|/ch1",
            deleted = false,
            hlc = hlc1,
            payload = buildJsonObject { put("lastPageRead", JsonPrimitive(5)) },
            clientMutationId = "m-page-5",
        )
        store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "comics",
            entityType = "comic.chapter",
            entityKey = "src1:/w|/ch1",
            deleted = false,
            hlc = hlc2,
            payload = buildJsonObject { put("lastPageRead", JsonPrimitive(9)) },
            clientMutationId = "m-page-9",
        )
        // Second unrelated item that Core will reject.
        store.enqueueOutbox(
            serverId = "srv-1",
            profileId = "main",
            domain = "novels",
            entityType = "novel.chapter",
            entityKey = "bad",
            deleted = false,
            hlc = hlc3,
            payload = buildJsonObject {},
            clientMutationId = "m-bad",
        )
        assertEquals(2L, store.countPendingOutbox("srv-1", "main"))

        val mockClient = OkHttpClient.Builder()
            .addInterceptor(Interceptor { chain ->
                val req = chain.request()
                when (req.url.encodedPath) {
                    "/v4/deltas" -> jsonResponse(
                        req,
                        200,
                        """{"serverSeq":11,"serverTimeMs":2000000,"acceptedCount":1,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[{"index":1,"clientMutationId":"m-bad","entityType":"novel.chapter","entityKey":"bad","code":"INVALID_ENTITY_KEY","message":"bad key"}]}""",
                    )
                    "/v4/changes" -> jsonResponse(
                        req,
                        200,
                        """{"protocolVersion":4,"profileId":"main","serverSeq":11,"minReplayableSeq":0,"nextSeq":11,"hasMore":false,"serverTimeMs":2000000,"changes":[]}""",
                    )
                    else -> error("Unexpected ${req.url.encodedPath}")
                }
            })
            .build()

        val noopBridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = emptyList<V4OutgoingItem>()
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) = Unit
        }
        val http = V4CoreHttpClient(mockClient, "https://127.0.0.1:4777/".toHttpUrl(), "0.1.0")
        val sse = V4SseClient(mockClient, "https://127.0.0.1:4777/".toHttpUrl(), "0.1.0")
        val engine = V4SyncEngine("srv-1", "main", "android-1", store, http, sse, noopBridge)

        val result = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertEquals(1, result.uploadedCount)
        // Valid mutation m-page-9 was acknowledged and removed; ONLY m-bad remains pending with backoff!
        assertEquals(1L, result.pendingOutboxCount)
        assertEquals(1L, store.countPendingOutbox("srv-1", "main"))
    }

    @Test
    fun `outbox keeps independent chapter patches`() {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase(), wallClockMs = { 1_000_000L })
        store.enqueueOutbox("srv", "main", "comics", "comic.chapter", "1:/work|/ch",
            false, V4Hlc(1, 0, "phone"), buildJsonObject { put("isBookmarked", JsonPrimitive(true)) })
        store.enqueueOutbox("srv", "main", "comics", "comic.chapter", "1:/work|/ch",
            false, V4Hlc(2, 0, "phone"), buildJsonObject { put("lastPageRead", JsonPrimitive(5)) })
        assertEquals(2L, store.countPendingOutbox("srv", "main"))
    }

    @Test
    fun `a rejected bulk item leaves initial sync incomplete`() = runTest {
        val (store, engine) = fullMergeScenario(
            initialState = V4SyncCursorState("srv-1", "main"),
            bulkResponse = """{"serverSeq":7,"serverTimeMs":2000000,"acceptedCount":0,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[{"index":0,"entityType":"comic.work","entityKey":"src1:/manga/local","code":"INVALID_ENTITY_KEY","message":"invalid key"}]}""",
        )

        assertTrue(engine.syncOnce("tok-1") is V4SyncRunResult.Failed)
        val state = store.loadState("srv-1", "main")
        assertFalse(state.initialSyncCompleted)
        assertEquals(0L, state.serverSeq)
    }

    @Test
    fun `a confirmed seed into an empty Core does not redownload its own library`() = runTest {
        val (store, engine) = fullMergeScenario(
            initialState = V4SyncCursorState("srv-1", "main"),
            snapshotStatus = 503,
            initialCoreSequence = 0,
            conditionalBulk = true,
        )
        val result = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertEquals(7L, result.serverSeq)
        assertEquals(1, result.uploadedCount)
        assertEquals(0, result.appliedCount)
        assertTrue(store.loadState("srv-1", "main").initialSyncCompleted)
    }

    @Test
    fun `a failed recovery snapshot keeps the previous applied cursor`() = runTest {
        val (store, engine) = fullMergeScenario(
            initialState = V4SyncCursorState("srv-1", "main", serverSeq = 1, initialSyncCompleted = true),
            snapshotStatus = 503,
        )

        assertTrue(engine.syncOnce("tok-1") is V4SyncRunResult.Failed)
        assertEquals(1L, store.loadState("srv-1", "main").serverSeq)
    }

    @Test
    fun `a recovery snapshot replaces a cursor from before the Core was rewound`() = runTest {
        val (store, engine) = fullMergeScenario(
            initialState = V4SyncCursorState("srv-1", "main", serverSeq = 10, initialSyncCompleted = true),
        )

        val result = engine.syncOnce("tok-1") as V4SyncRunResult.Synced
        assertEquals(7L, result.serverSeq)
        assertEquals(7L, store.loadState("srv-1", "main").serverSeq)
    }

    private fun fullMergeScenario(
        initialState: V4SyncCursorState,
        bulkResponse: String = """{"serverSeq":7,"serverTimeMs":2000000,"acceptedCount":1,"mergedCount":0,"deduplicatedCount":0,"noopCount":0,"rejected":[]}""",
        snapshotStatus: Int = 200,
        initialCoreSequence: Long = 6L,
        conditionalBulk: Boolean = false,
    ): Pair<SqlDelightV4SyncStore, V4SyncEngine> {
        val store = SqlDelightV4SyncStore(createInMemoryDatabase(), wallClockMs = { 1_000_000L })
        store.saveState(initialState)
        val client = OkHttpClient.Builder()
            .addInterceptor { chain ->
                val request = chain.request()
                when (request.url.encodedPath) {
                    "/v4/capabilities" -> jsonResponse(
                        request,
                        200,
                        """{"profileId":"main","deviceId":"android-1","serverSeq":$initialCoreSequence,"minReplayableSeq":0,
                            "serverTimeMs":2000000,"supportsConditionalBulk":$conditionalBulk}""",
                    )
                    "/v4/changes" -> jsonResponse(request, 410, "")
                    "/v4/sync/bulk" -> jsonResponse(request, 200, bulkResponse)
                    "/v4/snapshot" -> jsonResponse(
                        request,
                        snapshotStatus,
                        """{"profileId":"main","serverSeq":7,"minReplayableSeq":0,"serverTimeMs":2000000,"recordCount":0,"records":[]}""",
                    )
                    else -> error("Unexpected call: ${request.url.encodedPath}")
                }
            }
            .build()
        val bridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock): List<V4OutgoingItem> {
                assertFalse(initialState.initialSyncCompleted, "Replay recovery must not publish old local state as new edits")
                return listOf(V4OutgoingItem(domain = "comics", entityType = "comic.work", entityKey = "src1:/manga/local", hlc = clock.next()))
            }

            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) = Unit
        }
        val url = "https://127.0.0.1:4777/".toHttpUrl()
        return store to V4SyncEngine(
            "srv-1",
            "main",
            "android-1",
            store,
            V4CoreHttpClient(client, url, "0.1.0"),
            V4SseClient(client, url, "0.1.0"),
            bridge,
        )
    }
}
