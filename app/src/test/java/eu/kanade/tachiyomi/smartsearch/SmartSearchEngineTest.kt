package eu.kanade.tachiyomi.smartsearch

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.source.model.SManga
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SmartSearchEngineTest {

    private val wanted = "A Pig-Slaughtering Knife Cutting Through All Realms — Makes Sense, Right"
    private val listedNames = "Story text.\n\n**Alternative Names**:\n" +
        "- A Pig-Slaughtering Knife Cutting Through All Realms - Makes Sense, Right?\n- Pig Slayer\n\n**Year**: 2025"

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
        private val results: List<SManga>,
        private val descriptions: Map<String, String> = emptyMap(),
    ) : CatalogueSource {
        val detailsLoaded = mutableListOf<String>()

        override val id: Long = 1
        override val name: String = "Fake"
        override val lang: String = "en"
        override val supportsLatest: Boolean get() = false

        override suspend fun getPopularManga(page: Int): MangasPage = error("unused")
        override suspend fun getSearchManga(page: Int, query: String, filters: FilterList): MangasPage =
            MangasPage(results, false)
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
