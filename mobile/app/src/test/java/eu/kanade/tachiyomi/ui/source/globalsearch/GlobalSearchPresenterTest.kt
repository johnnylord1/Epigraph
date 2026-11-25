package eu.kanade.tachiyomi.ui.source.globalsearch

import eu.kanade.tachiyomi.core.preference.InMemoryPreferenceStore
import eu.kanade.tachiyomi.data.cache.CoverCache
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.source.model.SManga
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class GlobalSearchPresenterTest {
    private val mainDispatcher = UnconfinedTestDispatcher()

    @BeforeEach
    fun setUp() {
        Dispatchers.setMain(mainDispatcher)
    }

    @AfterEach
    fun tearDown() {
        Dispatchers.resetMain()
    }

    private suspend fun awaitUntil(timeoutMs: Long = 3_000L, predicate: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!predicate() && System.currentTimeMillis() < deadline) {
            delay(10)
        }
    }

    private fun createPreferences(): PreferencesHelper {
        val store = InMemoryPreferenceStore()
        return PreferencesHelper(mockk(relaxed = true), store)
    }

    private fun fakeSource(id: Long, name: String): CatalogueSource = mockk(relaxed = true) {
        every { this@mockk.id } returns id
        every { this@mockk.name } returns name
        every { lang } returns "en"
        every { getFilterList() } returns FilterList()
    }

    private class TestGlobalSearchPresenter(
        private val dynamicSources: () -> List<CatalogueSource>,
        private val onSearch: suspend (CatalogueSource, String) -> MangasPage,
        sourceManager: SourceManager,
        preferences: PreferencesHelper,
        coverCache: CoverCache,
    ) : GlobalSearchPresenter(
        initialQuery = "",
        initialExtensionFilter = null,
        sourcesToUse = null,
        sourceManager = sourceManager,
        preferences = preferences,
        coverCache = coverCache,
    ) {
        override fun getEnabledSources(): List<CatalogueSource> = dynamicSources()

        override suspend fun searchManga(source: CatalogueSource, query: String): MangasPage =
            onSearch(source, query)

        override suspend fun networkToLocalManga(sManga: SManga, sourceId: Long): Manga? = null
    }

    @Test
    fun `retrying same query re-runs failed sources without restarting presenter`() = runBlocking {
        val source1 = fakeSource(1L, "Source 1")
        var shouldFail = true
        var calls = 0

        val presenter = TestGlobalSearchPresenter(
            dynamicSources = { listOf(source1) },
            onSearch = { _, _ ->
                calls++
                if (shouldFail) throw RuntimeException("transient")
                MangasPage(emptyList(), false)
            },
            sourceManager = mockk(relaxed = true),
            preferences = createPreferences(),
            coverCache = mockk(relaxed = true),
        )

        try {
            presenter.search("naruto")
            awaitUntil { calls == 1 && presenter.items.singleOrNull()?.searchFailed == true }
            assertEquals(1, calls)
            assertTrue(presenter.items.single().searchFailed)

            shouldFail = false
            presenter.search("naruto")
            awaitUntil { calls == 2 && presenter.items.singleOrNull()?.let { it.results != null && !it.searchFailed } == true }
            assertEquals(2, calls)
            assertFalse(presenter.items.single().searchFailed)
        } finally {
            presenter.onDestroy()
        }
    }

    @Test
    fun `newly loaded sources are picked up on subsequent search`() = runBlocking {
        val source1 = fakeSource(1L, "Source 1")
        val source2 = fakeSource(2L, "Source 2")
        val availableSources = mutableListOf<CatalogueSource>()

        val presenter = TestGlobalSearchPresenter(
            dynamicSources = { availableSources.toList() },
            onSearch = { _, _ -> MangasPage(emptyList(), false) },
            sourceManager = mockk(relaxed = true),
            preferences = createPreferences(),
            coverCache = mockk(relaxed = true),
        )

        try {
            // Touch sources before extensions finish loading
            assertTrue(presenter.sources.isEmpty())

            availableSources.add(source1)
            presenter.search("bleach")
            awaitUntil { presenter.items.size == 1 && presenter.items.all { it.results != null } }
            assertEquals(listOf(1L), presenter.items.map { it.source.id })

            availableSources.add(source2)
            presenter.search("bleach")
            awaitUntil { presenter.items.size == 2 && presenter.items.all { it.results != null } }
            assertEquals(setOf(1L, 2L), presenter.items.map { it.source.id }.toSet())
        } finally {
            presenter.onDestroy()
        }
    }
}
