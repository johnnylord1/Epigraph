package eu.kanade.tachiyomi.ui.source.browse

import eu.kanade.tachiyomi.core.preference.InMemoryPreferenceStore
import eu.kanade.tachiyomi.data.cache.CoverCache
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.model.FilterList
import eu.kanade.tachiyomi.source.model.MangasPage
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
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import yokai.domain.ui.UiPreferences

@OptIn(ExperimentalCoroutinesApi::class)
class BrowseSourcePresenterTest {
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

    private fun createPresenter(sourceManager: SourceManager): BrowseSourcePresenter {
        val store = InMemoryPreferenceStore()
        val preferences = PreferencesHelper(mockk(relaxed = true), store)
        val uiPreferences = UiPreferences(store)
        return BrowseSourcePresenter(
            sourceId = 42L,
            sourceManager = sourceManager,
            uiPreferences = uiPreferences,
            preferences = preferences,
            coverCache = mockk(relaxed = true),
        )
    }

    @Test
    fun `retrySourceInitialization recovers from transient UNAVAILABLE state`() = runBlocking {
        val source: CatalogueSource = mockk(relaxed = true) {
            every { id } returns 42L
            every { getFilterList() } returns FilterList()
        }
        val sourceManager: SourceManager = mockk(relaxed = true)
        every { sourceManager.get(42L) } returns null
        coEvery { sourceManager.awaitCatalogueSource(42L) } returnsMany listOf(null, source)

        val presenter = createPresenter(sourceManager)
        try {
            presenter.onCreate()
            awaitUntil { presenter.sourceInitializationState == SourceInitializationState.UNAVAILABLE }
            assertEquals(SourceInitializationState.UNAVAILABLE, presenter.sourceInitializationState)

            presenter.retrySourceInitialization()
            awaitUntil { presenter.sourceInitializationState == SourceInitializationState.READY }
            assertEquals(SourceInitializationState.READY, presenter.sourceInitializationState)
            assertTrue(presenter.sourceIsInitialized)
        } finally {
            presenter.onDestroy()
        }
    }

    @Test
    fun `requestNext recovers after transient page error`() = runBlocking {
        val source: CatalogueSource = mockk(relaxed = true) {
            every { id } returns 42L
            every { getFilterList() } returns FilterList()
        }
        val sourceManager: SourceManager = mockk(relaxed = true)
        every { sourceManager.get(42L) } returns source

        var calls = 0
        val presenter = object : BrowseSourcePresenter(
            sourceId = 42L,
            sourceManager = sourceManager,
            uiPreferences = UiPreferences(InMemoryPreferenceStore()),
            preferences = PreferencesHelper(mockk(relaxed = true), InMemoryPreferenceStore()),
            coverCache = mockk(relaxed = true),
        ) {
            override fun createPager(query: String, filters: FilterList): Pager {
                return object : Pager() {
                    override suspend fun requestNextPage() {
                        calls++
                        if (calls == 1) throw RuntimeException("network error")
                        onPageReceived(MangasPage(emptyList(), false))
                    }
                }
            }
        }

        try {
            presenter.source = source
            presenter.restartPager("test", FilterList())
            awaitUntil { calls == 1 }
            assertEquals(1, calls)

            presenter.requestNext()
            awaitUntil { calls == 2 }
            assertEquals(2, calls)
        } finally {
            presenter.onDestroy()
        }
    }
}
