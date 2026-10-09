package eu.kanade.tachiyomi.source.online

import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.Page
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import eu.kanade.tachiyomi.source.model.SMangaUpdate
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.Request
import okhttp3.Response
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class HttpSourceMangaUpdateLockTest {

    @Test
    fun `details and chapters requested together both reach a lib 1_6 source`() = runBlocking(Dispatchers.Default) {
        val source = GuardedLib16Source()
        val manga = SManga.create().apply { url = "/titles/100020"; title = "One Piece" }

        val (details, chapters) = listOf(
            async { source.getMangaDetails(manga) },
            async { source.getChapterList(manga) },
        ).awaitAll()

        assertEquals("One Piece (updated)", (details as SManga).title)
        assertEquals(listOf("/chapters/1"), (chapters as List<*>).map { (it as SChapter).url })
        assertEquals(2, source.calls)
    }

    @Test
    fun `different manga are not queued behind each other`() = runBlocking(Dispatchers.Default) {
        val source = GuardedLib16Source()
        val first = SManga.create().apply { url = "/titles/1"; title = "A" }
        val second = SManga.create().apply { url = "/titles/2"; title = "B" }

        listOf(
            async { source.getChapterList(first) },
            async { source.getChapterList(second) },
        ).awaitAll()

        assertEquals(2, source.maxInFlight)
    }

    /** Mirrors the keiyoushi lib 1.6 base: overlapping calls for one manga url throw. */
    private class GuardedLib16Source : HttpSource() {
        override val name = "Guarded"
        override val lang = "en"
        override val baseUrl = "https://example.invalid"
        override val supportsLatest = false

        private val inFlight = ConcurrentHashMap<String, Boolean>()
        private val active = java.util.concurrent.atomic.AtomicInteger()
        @Volatile var calls = 0
        @Volatile var maxInFlight = 0

        override suspend fun getMangaUpdate(
            manga: SManga,
            chapters: List<SChapter>,
            fetchDetails: Boolean,
            fetchChapters: Boolean,
        ): SMangaUpdate {
            check(inFlight.putIfAbsent(manga.url, true) == null) {
                "getMangaUpdate must not be called concurrently for same manga"
            }
            try {
                val now = active.incrementAndGet()
                synchronized(this) {
                    calls++
                    maxInFlight = maxOf(maxInFlight, now)
                }
                delay(50)
                val updated = SManga.create().apply {
                    url = manga.url
                    title = if (fetchDetails) "${manga.title} (updated)" else manga.title
                }
                val list = if (fetchChapters) {
                    listOf(SChapter.create().apply { url = "/chapters/1"; name = "Chapter 1" })
                } else {
                    chapters
                }
                return SMangaUpdate(updated, list)
            } finally {
                active.decrementAndGet()
                inFlight.remove(manga.url)
            }
        }

        override fun popularMangaRequest(page: Int): Request = error("unused")
        override fun popularMangaParse(response: Response): MangasPage = error("unused")
        override fun searchMangaRequest(page: Int, query: String, filters: eu.kanade.tachiyomi.source.model.FilterList): Request = error("unused")
        override fun searchMangaParse(response: Response): MangasPage = error("unused")
        override fun latestUpdatesRequest(page: Int): Request = error("unused")
        override fun latestUpdatesParse(response: Response): MangasPage = error("unused")
        override fun mangaDetailsParse(response: Response): SManga = error("unused")
        override fun chapterListParse(response: Response): List<SChapter> = error("unused")
        override fun chapterPageParse(response: Response): SChapter = error("unused")
        override fun pageListParse(response: Response): List<Page> = error("unused")
        override fun imageUrlParse(response: Response): String = error("unused")
    }
}
