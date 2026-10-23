package epigraph.sync.core.portable

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class PortableChapterPrefetcherTest {
    private class MemoryCooldown(val until: MutableMap<Long, Long> = mutableMapOf()) : ChapterPrefetchCooldown {
        override fun nextAllowedAt(localMangaId: Long): Long? = until[localMangaId]
        override fun record(localMangaId: Long, nextAllowedAt: Long) {
            until[localMangaId] = nextAllowedAt
        }
        override fun prune(now: Long) {
            until.entries.removeAll { it.value <= now }
        }
    }

    private fun target(id: Long, source: Long = 1L) =
        ChapterPrefetchTarget(localMangaId = id, sourceId = source, key = "/m/$id")

    private fun prefetcher(
        targets: List<ChapterPrefetchTarget>,
        cooldown: ChapterPrefetchCooldown = MemoryCooldown(),
        clock: () -> Long = { NOW },
        titlesPerRun: Int = 30,
        sourceQueues: Int = 1,
        desktop: CoreChapterListStage? = null,
        fetch: suspend (ChapterPrefetchTarget) -> ChapterFetchOutcome,
    ) = PortableChapterPrefetcher(
        targets = { limit -> targets.take(limit.toInt()) },
        fetcher = { fetch(it) },
        cooldown = cooldown,
        clock = clock,
        titlesPerRun = titlesPerRun,
        sourceQueues = sourceQueues,
        desktop = desktop,
    )

    @Test
    fun `a run fetches the most recently read titles first and reports the rest`() = runTest {
        val fetched = mutableListOf<Long>()
        val report = prefetcher(listOf(target(1), target(2), target(3)), titlesPerRun = 2) {
            fetched += it.localMangaId
            ChapterFetchOutcome.ADDED
        }.run()

        assertEquals(listOf(1L, 2L), fetched)
        assertEquals(ChapterPrefetchReport(added = 2, failed = 0, remaining = true), report)
    }

    @Test
    fun `titles in cooldown wait and each outcome sets how long`() = runTest {
        val cooldown = MemoryCooldown(mutableMapOf(1L to NOW + 1))
        val fetched = mutableListOf<Long>()
        val report = prefetcher(listOf(target(1), target(2), target(3), target(4)), cooldown) {
            fetched += it.localMangaId
            when (it.localMangaId) {
                2L -> ChapterFetchOutcome.UNCHANGED
                3L -> ChapterFetchOutcome.SKIPPED
                else -> throw IllegalStateException("source error")
            }
        }.run()

        assertEquals(listOf(2L, 3L, 4L), fetched)
        assertEquals(ChapterPrefetchReport(added = 0, failed = 1, remaining = false), report)
        assertEquals(NOW + 1, cooldown.until[1L])
        assertEquals(NOW + PortableChapterPrefetcher.COOLDOWN_AFTER_FETCH_MILLIS, cooldown.until[2L])
        assertEquals(NOW + PortableChapterPrefetcher.COOLDOWN_AFTER_FAILURE_MILLIS, cooldown.until[3L])
        assertEquals(NOW + PortableChapterPrefetcher.COOLDOWN_AFTER_FAILURE_MILLIS, cooldown.until[4L])
    }

    @Test
    fun `a stalled source times out as a failure and the run moves on`() = runTest {
        val cooldown = MemoryCooldown()
        val report = prefetcher(listOf(target(1), target(2)), cooldown) {
            if (it.localMangaId == 1L) awaitCancellation()
            ChapterFetchOutcome.ADDED
        }.run()

        assertEquals(ChapterPrefetchReport(added = 1, failed = 1, remaining = false), report)
        assertEquals(NOW + PortableChapterPrefetcher.COOLDOWN_AFTER_FAILURE_MILLIS, cooldown.until[1L])
    }

    @Test
    fun `stopping the worker cancels the run instead of counting a failure`() = runTest {
        val cooldown = MemoryCooldown()
        val started = CompletableDeferred<Unit>()
        val run = launch {
            prefetcher(listOf(target(1), target(2)), cooldown) {
                started.complete(Unit)
                awaitCancellation()
            }.run()
        }
        started.await()
        run.cancelAndJoin()

        assertTrue(run.isCancelled)
        assertTrue(cooldown.until.isEmpty())
    }

    @Test
    fun `at most two sources run at once and each source one title at a time`() = runTest {
        val active = mutableMapOf<Long, Int>()
        var peakTotal = 0
        var peakPerSource = 0
        val targets = (1L..6L).map { target(it, source = it % 3) }
        prefetcher(targets, sourceQueues = 2) {
            active[it.sourceId] = (active[it.sourceId] ?: 0) + 1
            peakTotal = maxOf(peakTotal, active.values.sum())
            peakPerSource = maxOf(peakPerSource, active.values.max())
            delay(1_000)
            active[it.sourceId] = active.getValue(it.sourceId) - 1
            ChapterFetchOutcome.UNCHANGED
        }.run()

        assertEquals(2, peakTotal)
        assertEquals(1, peakPerSource)
    }

    @Test
    fun `the run deadline leaves later titles for the next run`() = runTest {
        var now = NOW
        val fetched = mutableListOf<Long>()
        val report = prefetcher(listOf(target(1), target(2)), clock = { now }) {
            fetched += it.localMangaId
            now += PortableChapterPrefetcher.DEFAULT_RUN_DEADLINE_MILLIS
            ChapterFetchOutcome.ADDED
        }.run()

        assertEquals(listOf(1L), fetched)
        assertEquals(ChapterPrefetchReport(added = 1, failed = 0, remaining = true), report)
    }

    @Test
    fun `the sync pass asks for a fetch and leaves the chapters pending`() = runTest {
        var requests = 0
        val materializer = DeferredComicChapterMaterializer { requests += 1 }
        val work = PortableWorkRef.Comic(DecimalSourceId("10"), ProviderOwnedKey("/manga/1"))
        val refs = listOf(
            PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/1")),
            PortableChapterRef.Comic(work, ProviderOwnedKey("/chapter/2")),
        )

        assertTrue(materializer.materializeAll(emptyList()).isEmpty())
        assertEquals(0, requests)
        val resolved = materializer.materializeAll(refs)

        assertEquals(1, requests)
        assertEquals(refs, resolved.map { it.ref })
        resolved.forEach {
            assertEquals(PortableResolutionState.PENDING_PROVIDER, it.resolution.state)
            assertEquals(PortableResolutionReason.CHAPTER_NOT_FOUND, it.resolution.reason)
        }
    }

    @Test
    fun `targets are bound comics missing a pending chapter, most recently read first`() = runTest {
        val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
        try {
            val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
            val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
            fun manga(url: String): Long {
                database.mangasQueries.insert(
                    source = 10, url = url, artist = null, author = null, description = null, genre = null,
                    title = url, status = 0, thumbnailUrl = null, favorite = true, lastUpdate = null,
                    initialized = false, viewer = 0, hideTitle = false, chapterFlags = 0, dateAdded = null,
                    filteredScanlators = null, updateStrategy = 0, coverLastModified = 0, nextUpdate = 0,
                    fetchInterval = 0, memo = JsonObject(emptyMap()),
                )
                return database.mangasQueries.selectLastInsertedRowId().executeAsOne()
            }
            fun work(id: String, localId: Long, state: String = "BOUND") = driver.execute(
                null,
                "INSERT INTO aethon_portable_work_binding(portable_id, ecosystem, source_id, provider_key, " +
                    "local_reference, resolution_state, updated_at) VALUES ('$id', 'SUWAYOMI', '10', '$id', " +
                    "${if (state == "BOUND") "'$localId'" else "NULL"}, '$state', 1)",
                0,
            )
            fun chapter(workId: String, key: String, state: String = "PENDING_PROVIDER", reason: String? = "CHAPTER_NOT_FOUND") =
                driver.execute(
                    null,
                    "INSERT INTO aethon_portable_chapter_binding(portable_chapter_id, portable_work_id, provider_key, " +
                        "local_reference, resolution_state, resolution_reason, updated_at) VALUES " +
                        "('$workId#$key', '$workId', '$key', ${if (state == "BOUND") "'1'" else "NULL"}, '$state', " +
                        "${reason?.let { "'$it'" } ?: "NULL"}, 1)",
                    0,
                )
            fun progress(workId: String, at: Long) {
                driver.execute(
                    null,
                    "INSERT INTO aethon_content_identity VALUES ('$workId', 'MANGA', '$workId', 1, 1)",
                    0,
                )
                driver.execute(
                    null,
                    "INSERT INTO aethon_reader_progress(entity_id, locator_json, progression, updated_at) " +
                        "VALUES ('$workId', '{}', 0.5, $at)",
                    0,
                )
            }

            val readLongAgo = manga("/a")
            val readRecently = manga("/b")
            val neverRead = manga("/c")
            val alreadyListed = manga("/d")
            val boundChapter = manga("/e")
            val sourceMissing = manga("/f")
            work("a", readLongAgo).also { chapter("a", "/a/1"); progress("a", 200) }
            work("b", readRecently).also { chapter("b", "/b/1"); progress("b", 500) }
            work("c", neverRead).also { chapter("c", "/c/1") }
            work("d", alreadyListed).also { chapter("d", "/d/1") }
            database.chaptersQueries.insert(
                mangaId = alreadyListed, url = "/d/1", name = "1", scanlator = null, read = false, bookmark = false,
                lastPageRead = 0, pagesLeft = 0, chapterNumber = 1.0, sourceOrder = 0, dateFetch = 0, dateUpload = 0,
                memo = JsonObject(emptyMap()),
            )
            work("e", boundChapter).also { chapter("e", "/e/1", state = "BOUND", reason = null) }
            work("f", sourceMissing).also {
                chapter("f", "/f/1", state = "RETRYABLE_FAILURE", reason = "SOURCE_NOT_LOADED")
            }
            work("g", 0, state = "PENDING_PROVIDER").also { chapter("g", "/g/1") }

            val targets = SqlDelightChapterPrefetchTargets(handler).awaiting(limit = 10)

            assertEquals(listOf(readRecently, readLongAgo, neverRead), targets.map { it.localMangaId })
            assertTrue(targets.all { it.sourceId == 10L })
            assertEquals(listOf("b", "a", "c"), targets.map { it.key })
            assertFalse(SqlDelightChapterPrefetchTargets(handler).awaiting(limit = 1).size > 1)
        } finally {
            driver.close()
        }
    }

    private companion object {
        const val NOW = 1_000_000L
    }
}
