package epigraph.sync.core.portable

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogPage
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import epigraph.sync.core.suwayomi.CoreChapterNodes
import epigraph.sync.core.suwayomi.SuwayomiMutationGateway
import eu.kanade.tachiyomi.source.model.SChapter
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreChapterListStageTest {
    private class MemoryCooldown(val until: MutableMap<Long, Long> = mutableMapOf()) : ChapterPrefetchCooldown {
        override fun nextAllowedAt(localMangaId: Long): Long? = until[localMangaId]
        override fun record(localMangaId: Long, nextAllowedAt: Long) {
            until[localMangaId] = nextAllowedAt
        }
        override fun prune(now: Long) {
            until.entries.removeAll { it.value <= now }
        }
    }

    /** A desktop whose library maps "/m/<id>" on source 1 to Suwayomi ID 100 + id. */
    private class FakeCatalog(
        private val listed: Set<Long>?,
        private val failing: Set<Long> = emptySet(),
        private val libraryFails: Boolean = false,
    ) : CoreChapterCatalog {
        val asked = mutableListOf<Long>()

        override suspend fun <T> withReader(block: suspend (CoreChapterCatalogReader) -> T): T? {
            val listed = listed ?: return null
            return block(
                object : CoreChapterCatalogReader {
                    override suspend fun libraryIds(): Map<CoreWorkKey, Long> {
                        if (libraryFails) error("catalog unavailable")
                        return listed.associate { CoreWorkKey(1L, "/m/$it") to 100L + it }
                    }

                    override suspend fun chapters(suwayomiMangaId: Long): CoreChapterList {
                        val id = suwayomiMangaId - 100L
                        asked += id
                        if (id in failing) error("chapters unavailable")
                        return CoreChapterList(
                            listOf(chapter("/m/$id/1", 1f)),
                            CoreChapterNodes("server", "main", suwayomiMangaId, emptyList()),
                        )
                    }
                },
            )
        }
    }

    private fun target(id: Long) = ChapterPrefetchTarget(localMangaId = id, sourceId = 1L, key = "/m/$id")

    private fun stage(
        catalog: CoreChapterCatalog,
        cooldown: ChapterPrefetchCooldown = MemoryCooldown(),
        written: MutableList<Long> = mutableListOf(),
        outcome: (Long) -> ChapterFetchOutcome = { ChapterFetchOutcome.ADDED },
    ) = CoreChapterListStage(
        catalog = catalog,
        writer = { target, list ->
            assertTrue(list.chapters.isNotEmpty())
            assertEquals(100L + target.localMangaId, list.nodes.mangaId)
            written += target.localMangaId
            outcome(target.localMangaId)
        },
        cooldown = cooldown,
        clock = { NOW },
    )

    private fun prefetcher(
        targets: List<ChapterPrefetchTarget>,
        desktop: CoreChapterListStage,
        fetched: MutableList<Long>,
    ) = PortableChapterPrefetcher(
        targets = { limit -> targets.take(limit.toInt()) },
        fetcher = {
            fetched += it.localMangaId
            ChapterFetchOutcome.ADDED
        },
        cooldown = MemoryCooldown(),
        clock = { NOW },
        desktop = desktop,
    )

    @Test
    fun `the desktop lists every title it holds and the extension takes only the rest`() = runTest {
        val written = mutableListOf<Long>()
        val fetched = mutableListOf<Long>()
        val desktop = stage(FakeCatalog(listed = setOf(1, 2, 3)), written = written) { id ->
            if (id == 2L) ChapterFetchOutcome.UNCHANGED else ChapterFetchOutcome.ADDED
        }

        val report = prefetcher((1L..5L).map(::target), desktop, fetched).run()

        assertEquals(listOf(1L, 2L, 3L), written.sorted())
        assertEquals(listOf(4L, 5L), fetched)
        assertEquals(ChapterPrefetchReport(added = 4, failed = 0, remaining = false), report)
    }

    @Test
    fun `without a usable Core session every title goes to the extension`() = runTest {
        val fetched = mutableListOf<Long>()
        prefetcher((1L..3L).map(::target), stage(FakeCatalog(listed = null)), fetched).run()
        assertEquals(listOf(1L, 2L, 3L), fetched)

        fetched.clear()
        prefetcher((1L..3L).map(::target), stage(FakeCatalog(setOf(1), libraryFails = true)), fetched).run()
        assertEquals(listOf(1L, 2L, 3L), fetched)
    }

    @Test
    fun `a title the desktop fails to list falls back to the extension`() = runTest {
        val fetched = mutableListOf<Long>()
        val cooldown = MemoryCooldown()
        val desktop = stage(FakeCatalog(listed = setOf(1, 2), failing = setOf(2)), cooldown)

        prefetcher(listOf(target(1), target(2)), desktop, fetched).run()

        assertEquals(listOf(2L), fetched)
        assertEquals(NOW + CoreChapterListStage.COOLDOWN_MILLIS, cooldown.until[2L])
    }

    @Test
    fun `only unchanged and failed titles wait before the desktop is asked again`() = runTest {
        val cooldown = MemoryCooldown()
        val catalog = FakeCatalog(listed = setOf(1, 2, 3), failing = setOf(3))
        val stage = stage(catalog, cooldown) { id ->
            if (id == 2L) ChapterFetchOutcome.UNCHANGED else ChapterFetchOutcome.ADDED
        }

        val first = stage.run((1L..3L).map(::target)) { false }

        assertEquals(
            mapOf(1L to ChapterFetchOutcome.ADDED, 2L to ChapterFetchOutcome.UNCHANGED, 3L to ChapterFetchOutcome.FAILED),
            first,
        )
        assertNull(cooldown.until[1L])
        assertEquals(NOW + CoreChapterListStage.COOLDOWN_MILLIS, cooldown.until[2L])
        assertEquals(NOW + CoreChapterListStage.COOLDOWN_MILLIS, cooldown.until[3L])

        catalog.asked.clear()
        stage.run((1L..3L).map(::target)) { false }
        assertEquals(listOf(1L), catalog.asked)
    }

    @Test
    fun `the run deadline stops asking the desktop`() = runTest {
        val catalog = FakeCatalog(listed = setOf(1, 2, 3))
        val outcomes = stage(catalog).run((1L..3L).map(::target)) { true }

        assertEquals(emptyMap<Long, ChapterFetchOutcome>(), outcomes)
        assertTrue(catalog.asked.isEmpty())
    }

    @Test
    fun `chapters only this device stores are kept around the desktop list`() {
        val desktop = listOf(chapter("/c/3", 3f), chapter("/c/2", 2f))
        val stored = listOf(chapter("/c/1", 1f), chapter("/c/2", 2f), chapter("/c/4", 4f), chapter("/c/x", -1f))

        val merged = keepStoredChapters(desktop, stored)

        assertEquals(listOf("/c/4", "/c/3", "/c/2", "/c/1", "/c/x"), merged.map { it.url })
        assertTrue(keepStoredChapters(desktop, desktop.take(1)) === desktop)
    }

    @Test
    fun `the reader pages the desktop chapters and orders them newest first`() = runTest {
        val gateway = PagedGateway(
            listOf(
                chapterNode(1, "/c/1", uploadDate = JsonPrimitive("1700000000000")),
                chapterNode(3, "/c/3", uploadDate = JsonPrimitive("2024-01-02T03:04:05Z")),
                chapterNode(2, "/c/2", uploadDate = JsonPrimitive(5L)),
            ),
        )
        val list = GatewayCoreChapterCatalogReader(gateway, session()).chapters(7L)
        val chapters = list.chapters

        assertEquals(listOf(0L, 2L), gateway.offsets)
        assertEquals(3, list.nodes.nodes.size)
        assertEquals(listOf("server-1", "main", 7L), listOf(list.nodes.serverId, list.nodes.profileId, list.nodes.mangaId))
        assertEquals(listOf("/c/3", "/c/2", "/c/1"), chapters.map { it.url })
        assertEquals(listOf(3f, 2f, 1f), chapters.map { it.chapter_number })
        assertEquals(listOf(1_704_164_645_000L, 5L, 1_700_000_000_000L), chapters.map { it.date_upload })
        assertTrue(chapters.none { it.name.isBlank() })
    }

    @Test
    fun `a desktop that sends no chapter urls is not used`() = runTest {
        val gateway = PagedGateway(listOf(chapterNode(1, url = null)))
        val failure = runCatching { GatewayCoreChapterCatalogReader(gateway, session()).chapters(7L) }
        assertTrue(failure.exceptionOrNull() is CoreChapterCatalogException)
    }

    @Test
    fun `the reader maps the desktop library by exact source key`() = runTest {
        val node = buildJsonObject {
            put("id", 42)
            put("sourceId", "1234567890123")
            put("url", "/manga/a")
        }
        val gateway = PagedGateway(listOf(node), key = "mangas")

        val library = GatewayCoreChapterCatalogReader(gateway, session()).libraryIds()

        assertEquals(mapOf(CoreWorkKey(1_234_567_890_123L, "/manga/a") to 42L), library)
    }

    @Test
    fun `fetched desktop nodes serve only the same desktop work`() {
        val nodes = CoreChapterNodes("server-1", "main", 7L, emptyList())

        assertTrue(nodes.serves(SuwayomiCoreContentReference.Manga("server-1", "main", 7L)))
        // A legacy identity names no server; the session's own server answers for it.
        assertTrue(nodes.serves(SuwayomiCoreContentReference.Manga(null, "main", 7L)))
        assertFalse(nodes.serves(SuwayomiCoreContentReference.Manga("server-2", "main", 7L)))
        assertFalse(nodes.serves(SuwayomiCoreContentReference.Manga("server-1", "other", 7L)))
        assertFalse(nodes.serves(SuwayomiCoreContentReference.Manga("server-1", "main", 8L)))
    }

    /** Serves [nodes] two per page under [key]. */
    private class PagedGateway(private val nodes: List<JsonObject>, private val key: String = "chapters") :
        SuwayomiMutationGateway {
        val offsets = mutableListOf<Long>()

        override suspend fun catalog(
            session: CoreCredentialSession,
            operation: SuwayomiCatalogOperation,
            pageSize: Long,
            offset: Long,
            mangaId: Long?,
        ): CoreHttpResult<SuwayomiCatalogResponse> {
            offsets += offset
            val page = nodes.drop(offset.toInt()).take(2)
            return CoreHttpResult.Success(
                SuwayomiCatalogResponse(
                    schemaVersion = 1,
                    scopeId = "comics:profile:main",
                    operation = operation.wireName,
                    generatedAtMs = 1,
                    page = SuwayomiCatalogPage(
                        offset = offset,
                        pageSize = 2,
                        hasNextPage = offset + page.size < nodes.size,
                        totalCount = nodes.size.toLong(),
                    ),
                    data = buildJsonObject { put(key, buildJsonObject { put("nodes", buildJsonArray { page.forEach(::add) }) }) },
                ),
            )
        }

        override suspend fun command(
            session: CoreCredentialSession,
            request: SuwayomiCommandRequest,
        ): CoreHttpResult<SuwayomiCommandResponse> = error("not used")

        override suspend fun graphql(
            session: CoreCredentialSession,
            request: SuwayomiGraphqlRequest,
        ): CoreHttpResult<SuwayomiGraphqlResponse> = error("not used")
    }

    private companion object {
        const val NOW = 1_000_000L

        fun chapter(url: String, number: Float): SChapter = SChapter.create().apply {
            this.url = url
            name = url
            chapter_number = number
        }

        fun chapterNode(order: Long, url: String? = "/c/$order", uploadDate: JsonPrimitive = JsonPrimitive(0L)) =
            buildJsonObject {
                put("id", order)
                put("name", "Chapter $order")
                put("chapterNumber", order.toDouble())
                put("sourceOrder", order)
                put("isRead", true)
                if (url != null) put("url", url)
                put("uploadDate", uploadDate)
            }

        fun session() = CoreCredentialSession(
            origin = "https://127.0.0.1:4787",
            tlsCertSha256 = "b".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main"),
            serverId = "server-1",
            inactivityExpiresAtMs = Long.MAX_VALUE,
            accessTokenUtf8 = "token".toByteArray(),
        )
    }
}
