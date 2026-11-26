package yokai.data.manga

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncScopeId
import epigraph.sync.ClientMutationIdFactory
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import eu.kanade.tachiyomi.data.database.models.MangaImpl
import eu.kanade.tachiyomi.data.library.CustomMangaManager
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.koin.core.context.startKoin
import org.koin.core.context.stopKoin
import org.koin.dsl.module
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter
import yokai.domain.manga.models.MangaUpdate

/** A work a paired desktop sent has no Epigraph identity here, yet its library edits must sync. */
class MangaRepositorySyncWakeTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also { Database.Schema.create(it) }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private var wakes = 0
    private var mutationCounter = 0
    private val router = EpigraphLibraryMutationRouter(
        coordinator = EpigraphMutationCoordinator(handler, onLocalMutationEnqueued = { wakes++ }),
        deviceId = DeviceId("phone"),
        scopeId = SyncScopeId("comics:profile:main"),
        mutationIds = ClientMutationIdFactory { ClientMutationId("m-${++mutationCounter}") },
    )
    private val paired = EpigraphSyncScopeProvider {
        EpigraphSyncScopes(SyncScopeId("novels:profile:main"), SyncScopeId("comics:profile:main"))
    }
    private val unpaired = EpigraphSyncScopeProvider { error("not paired") }

    @BeforeEach
    fun provideCustomMangaManager() {
        val customMangaManager = mockk<CustomMangaManager>()
        every { customMangaManager.getManga(any()) } returns null
        startKoin { modules(module { single { customMangaManager } }) }
    }

    @AfterEach
    fun closeDriver() {
        stopKoin()
        driver.close()
    }

    @Test
    fun `leaving the library or changing folders without an identity starts a sync while paired`() = runTest {
        val repository = MangaRepositoryImpl(handler, router, syncScopeProvider = paired)
        val id = desktopWork(repository)

        repository.update(MangaUpdate(id, favorite = false))
        assertFalse(requireNotNull(repository.getMangaById(id)).favorite)
        assertEquals(1, wakes)

        repository.updateAll(listOf(MangaUpdate(id, favorite = true)))
        assertEquals(2, wakes)

        repository.setCategories(id, emptyList())
        assertEquals(3, wakes)

        // Edits that leave the library alone, such as a refresh, do not start one.
        repository.update(MangaUpdate(id, title = "Renamed"))
        repository.updateAll(listOf(MangaUpdate(id, lastUpdate = 5)))
        assertEquals(3, wakes)
    }

    @Test
    fun `library edits stay local before pairing`() = runTest {
        val repository = MangaRepositoryImpl(handler, router, syncScopeProvider = unpaired)
        val id = desktopWork(repository)

        repository.update(MangaUpdate(id, favorite = false))
        repository.setCategories(id, emptyList())

        assertFalse(requireNotNull(repository.getMangaById(id)).favorite)
        assertEquals(0, wakes)
    }

    private suspend fun desktopWork(repository: MangaRepositoryImpl): Long =
        requireNotNull(
            repository.insert(
                MangaImpl().apply {
                    source = 100001L
                    url = "/manga/desktop-comic-3"
                    title = "Desktop Comic 3"
                    favorite = true
                },
            ),
        )
}
