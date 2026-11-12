package eu.kanade.tachiyomi.smartsearch

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.CancellationException
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test

class SmartSearchEngineTest {

    private val wanted = "A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right"
    private val listedNames = "Story text.\n\n**Alternative Names**:\n" +
        "- A Pig-Slaughtering Knife Cutting Through All Realms - Makes Sense, Right?\n- Pig Slayer\n\n**Year**: 2025"

    @Test
    fun `strict keyword catalogues are searched with a shorter query`() = runBlocking {
        val source = FakeSource(search = { _, query ->
            MangasPage(if (query == "pig slaughtering") listOf(manga("/knife", wanted)) else emptyList(), false)
        })
        assertEquals("/knife", SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, wanted)?.url)
    }

    @Test
    fun `exact Bleach match on the next page beats a spin off`() = runBlocking {
        val source = FakeSource(search = { page, _ ->
            if (page == 1) MangasPage(listOf(manga("/spinoff", "Bleach Special")), true)
            else MangasPage(listOf(manga("/bleach", "Bleach")), false)
        })
        assertEquals("/bleach", SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, "Bleach")?.url)
    }

    @Test
    fun `a temporary failure does not hide a simple title`() = runBlocking {
        var attempts = 0
        val source = FakeSource(search = { _, _ ->
            if (attempts++ == 0) throw java.io.IOException("HTTP 429")
            MangasPage(listOf(manga("/bleach", "Bleach")), false)
        })
        assertEquals("/bleach", SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, "Bleach")?.url)
    }

    @Test
    fun `cancellation is propagated rather than retried`() {
        val source = FakeSource(search = { _, _ -> throw CancellationException("cancelled") })
        assertThrows<CancellationException> {
            runBlocking { SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, "Bleach") }
        }
    }

    @Test
    fun `an unrelated title is left for manual selection`() = runBlocking {
        assertNull(SmartSearchEngine(EmptyCoroutineContext).normalSearch(
            FakeSource(results = listOf(manga("/naruto", "Naruto"))), "Bleach",
        ))
    }

    @Test
    fun `blank extra parameters do not change a simple query`() = runBlocking {
        val source = FakeSource(search = { _, query ->
            MangasPage(if (query == "Bleach") listOf(manga("/bleach", "Bleach")) else emptyList(), false)
        })
        assertEquals("/bleach", SmartSearchEngine(EmptyCoroutineContext, "  ").normalSearch(source, "Bleach")?.url)
    }

    @Test
    fun `bulk searches do not overlap requests within the same catalogue`() = runTest {
        var active = 0
        var peak = 0
        val source = FakeSource(search = { _, query ->
            active++
            peak = maxOf(peak, active)
            delay(10)
            active--
            MangasPage(listOf(manga("/$query", query)), false)
        })
        val engine = SmartSearchEngine(EmptyCoroutineContext)
        val results = listOf("Bleach", "Naruto").map { title -> async { engine.normalSearch(source, title)?.title } }.awaitAll()
        assertEquals(listOf("Bleach", "Naruto"), results)
        assertEquals(1, peak)
    }

    @Test
    fun `keyword fallback leaves a different series for manual selection`() = runTest {
        val source = FakeSource(search = { _, query ->
            MangasPage(if (query == "trigger") listOf(manga("/trigger", "Trigger")) else emptyList(), false)
        })
        val result = SmartSearchEngine(EmptyCoroutineContext).search(source, "World Trigger")
        assertNull(result.match)
        assertEquals(listOf("/trigger"), result.candidates.map { it.url })
    }

    @Test
    fun `manual search preserves candidates when a later page fails`() = runTest {
        val source = FakeSource(search = { page, _ ->
            if (page > 1) throw java.io.IOException("HTTP 503")
            MangasPage(listOf(manga("/unknown", "Unknown series")), true)
        })
        val result = SmartSearchEngine(EmptyCoroutineContext).search(source, "Bleach")
        assertNull(result.match)
        assertEquals(listOf("/unknown"), result.candidates.map { it.url })
        assertNotNull(result.failure)
    }

    @Test
    fun `manual search preserves candidates when a later page times out`() = runTest {
        val source = FakeSource(search = { page, _ ->
            if (page > 1) delay(61_000)
            MangasPage(listOf(manga("/unknown", "Unknown series")), true)
        })
        val result = SmartSearchEngine(EmptyCoroutineContext).search(source, "Bleach")
        assertNull(result.match)
        assertEquals(listOf("/unknown"), result.candidates.map { it.url })
        assertNotNull(result.failure)
    }

    @Test
    fun `automatic search reports an incomplete search as failure rather than not found`() {
        val source = FakeSource(search = { page, _ ->
            if (page > 1) throw java.io.IOException("HTTP 503")
            MangasPage(listOf(manga("/unknown", "Unknown series")), true)
        })
        assertThrows<java.io.IOException> {
            runTest { SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, "Bleach") }
        }
    }

    @Test
    fun `pagination is bounded even when a catalogue keeps advertising another page`() = runTest {
        val pages = mutableListOf<Int>()
        val source = FakeSource(search = { page, _ ->
            pages += page
            MangasPage(listOf(manga("/other$page", "Unknown series $page")), true)
        })
        assertNull(SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, "Bleach"))
        assertEquals(listOf(1, 2, 3), pages)
    }

    @Test
    fun `a result is found by the other names its details list`() = runBlocking {
        val source = FakeSource(
            results = listOf(manga("/knife", "Almighty Pig Slaughtering Knife"), manga("/other", "Butcher Diaries")),
            descriptions = mapOf("/knife" to listedNames),
        )
        val found = SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, wanted)
        assertEquals("/knife", found?.url)
        assertEquals(listOf("/knife"), source.detailsLoaded)
    }

    @Test
    fun `a result whose listed names differ is not taken`() = runBlocking {
        val source = FakeSource(
            results = listOf(manga("/knife", "Almighty Pig Slaughtering Knife")),
            descriptions = mapOf("/knife" to "**Alternative Names**:\n- Pig Slayer\n- The Butcher Blade"),
        )
        assertNull(SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, wanted))
    }

    @Test
    fun `the other names of the series match a result by its title`() = runBlocking {
        val source = FakeSource(results = listOf(manga("/knife", "Almighty Pig Slaughtering Knife")))
        val found = SmartSearchEngine(EmptyCoroutineContext)
            .normalSearch(source, "Yi Ba Sha Zhu Dao", listOf("Almighty Pig-Slaughtering Knife"))
        assertEquals("/knife", found?.url)
    }

    @Test
    fun `a close title needs no details`() = runBlocking {
        val source = FakeSource(results = listOf(manga("/same", "A pig-slaughtering knife cutting through all realms — makes sense, right?")))
        assertEquals("/same", SmartSearchEngine(EmptyCoroutineContext).normalSearch(source, wanted)?.url)
        assertEquals(emptyList<String>(), source.detailsLoaded)
    }

    private fun manga(url: String, title: String) = SManga.create().also {
        it.url = url
        it.title = title
    }

    private class FakeSource(
        private val results: List<SManga> = emptyList(),
        private val descriptions: Map<String, String> = emptyMap(),
        private val search: (suspend (Int, String) -> MangasPage)? = null,
    ) : CatalogueSource {
        val detailsLoaded = mutableListOf<String>()

        override val id: Long = 1
        override val name: String = "Fake"
        override val lang: String = "en"
        override val supportsLatest: Boolean get() = false

        override suspend fun getPopularManga(page: Int): MangasPage = error("unused")
        override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage =
            search?.invoke(page, query) ?: MangasPage(results, false)
        override suspend fun getLatestUpdates(page: Int): MangasPage = error("unused")
        override fun getFilterList(): FilterList = FilterList()
        override suspend fun getMangaDetails(manga: SManga): SManga {
            synchronized(detailsLoaded) { detailsLoaded += manga.url }
            return SManga.create().also {
                it.url = manga.url
                it.title = manga.title
                it.description = descriptions[manga.url]
            }
        }
        override suspend fun getChapterList(manga: SManga): List<SChapter> = error("unused")
    }
}
