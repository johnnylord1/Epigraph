package epigraph.books.ui

import android.app.Application
import android.content.Intent
import android.os.Bundle
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ApplicationProvider
import epigraph.books.local.LocalBookRepository
import epigraph.books.reader.BookReaderPreferences
import epigraph.books.reader.BookReaderRouter
import epigraph.sync.core.assets.BookAssetCoordinator
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.util.system.Themes
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.awaitCancellation
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.koin.core.context.startKoin
import org.koin.core.context.stopKoin
import org.koin.dsl.module
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import yokai.domain.ui.settings.ReaderPreferences

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34])
@ConscryptMode(ConscryptMode.Mode.OFF)
class LocalBookReaderRestoreTest {

    @Before
    fun setUp() {
        stopKoin()
        startKoin {
            modules(
                module {
                    single<LocalBookRepository> {
                        mockk(relaxUnitFun = true) {
                            coEvery { find(any()) } coAnswers { awaitCancellation() }
                        }
                    }
                    single<BookAssetCoordinator> { mockk(relaxUnitFun = true) }
                    single<BookReaderRouter> { mockk(relaxUnitFun = true) }
                    single<BookReaderPreferences> { mockk(relaxUnitFun = true) }
                    single<PreferencesHelper> {
                        mockk(relaxUnitFun = true) {
                            every { context } returns ApplicationProvider.getApplicationContext()
                            every { nightMode() } returns mockk { every { get() } returns 0 }
                            every { lightTheme() } returns mockk { every { get() } returns Themes.DEFAULT }
                            every { darkTheme() } returns mockk { every { get() } returns Themes.DEFAULT }
                        }
                    }
                    single<ReaderPreferences> { mockk(relaxUnitFun = true) }
                },
            )
        }
    }

    @After
    fun tearDown() {
        stopKoin()
    }

    @Test
    fun `restoring LocalBookReaderActivity after process death removes dummy navigator before onResume`() {
        val intent = Intent(
            ApplicationProvider.getApplicationContext(),
            LocalBookReaderActivity::class.java,
        ).putExtra(LocalBookReaderActivity.EXTRA_BOOK_ID, "test-book-id")

        val firstController = Robolectric.buildActivity(LocalBookReaderActivity::class.java, intent)
            .create()
        val savedState = Bundle()
        try {
            val firstActivity = firstController.get()
            val dummyFragment = EpubNavigatorFragment.createDummyFactory()
                .instantiate(firstActivity.classLoader, EpubNavigatorFragment::class.java.name)
            firstActivity.supportFragmentManager.beginTransaction()
                .add(android.R.id.content, dummyFragment, "epigraph.readium.epub.navigator")
                .commitNow()

            firstController.saveInstanceState(savedState)
        } finally {
            firstController.destroy()
        }

        val restoredController = Robolectric.buildActivity(LocalBookReaderActivity::class.java, intent)
            .create(savedState)
            .start()
            .resume()
        try {
            val restoredActivity = restoredController.get()

            assertEquals(Lifecycle.State.RESUMED, restoredActivity.lifecycle.currentState)
            assertFalse(restoredActivity.isFinishing)
            assertNull(restoredActivity.supportFragmentManager.findFragmentByTag("epigraph.readium.epub.navigator"))
        } finally {
            restoredController.destroy()
        }
    }
}
