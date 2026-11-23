package epigraph.library

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import eu.kanade.tachiyomi.data.database.models.Category
import eu.kanade.tachiyomi.data.database.models.MangaImpl
import eu.kanade.tachiyomi.data.library.CustomMangaManager
import io.mockk.every
import io.mockk.mockk
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.koin.core.context.startKoin
import org.koin.core.context.stopKoin
import org.koin.dsl.module
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.category.CategoryRepositoryImpl
import yokai.data.manga.MangaRepositoryImpl
import yokai.data.memoColumnAdapter
import yokai.domain.category.interactor.GetCategories
import yokai.domain.category.interactor.SetMangaCategories
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.domain.manga.interactor.UpdateManga

class LibraryShareImportTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also { Database.Schema.create(it) }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver)
    private val mangaRepository = MangaRepositoryImpl(handler)
    private val categoryRepository = CategoryRepositoryImpl(handler)
    private val getCategories = GetCategories(categoryRepository)
    private val setMangaCategories = SetMangaCategories(mangaRepository)
    private val coordinator = LibraryShareImportCoordinator(
        extensionManager = mockk(),
        sourceManager = mockk(),
        createExtensionRepo = mockk(),
        getManga = GetManga(mangaRepository),
        insertManga = InsertManga(mangaRepository),
        updateManga = UpdateManga(mangaRepository, mockk()),
        getCategories = getCategories,
        setMangaCategories = setMangaCategories,
        databaseHandler = handler,
    )

    @BeforeEach
    fun provideCustomMangaManager() {
        val customMangaManager = mockk<CustomMangaManager>()
        every { customMangaManager.getManga(any()) } returns null
        startKoin {
            modules(module { single { customMangaManager } })
        }
    }

    @AfterEach
    fun closeDatabase() {
        stopKoin()
        driver.close()
    }

    @Test
    fun `imports into the configured default and all selected extra folders`() = runTest {
        val inbox = category("Inbox")
        val reading = category("Reading")
        val favorites = category("Favorites")
        val existingCategory = category("Existing")
        val existing = requireNotNull(mangaRepository.insert(MangaImpl().apply {
            source = 100L
            url = "/manga/existing"
            title = "Existing"
        }))
        setMangaCategories.await(existing, listOf(existingCategory.toLong()))

        val works = listOf(work("/manga/new"), work("/manga/existing"))
        val selectedFolders = setOf(reading, favorites, inbox, 0, Int.MAX_VALUE)
        assertEquals(2, coordinator.importSelectedWorks(works, inbox, selectedFolders))
        assertEquals(0, coordinator.importSelectedWorks(works, inbox, selectedFolders))

        val imported = requireNotNull(mangaRepository.getMangaByUrlAndSource("/manga/new", 100L))
        assertTrue(imported.favorite)
        assertTrue(requireNotNull(mangaRepository.getMangaById(existing)).favorite)
        assertEquals(setOf(inbox, reading, favorites), foldersOf(imported.id))
        assertEquals(setOf(inbox, reading, favorites, existingCategory), foldersOf(existing))
    }

    @Test
    fun `imports with just the configured default or leaves work unfiled when it is invalid`() = runTest {
        val inbox = category("Inbox")
        assertEquals(1, coordinator.importSelectedWorks(listOf(work("/manga/inbox")), inbox, emptySet()))
        assertEquals(1, coordinator.importSelectedWorks(listOf(work("/manga/unfiled")), Int.MAX_VALUE, emptySet()))

        val filed = requireNotNull(mangaRepository.getMangaByUrlAndSource("/manga/inbox", 100L))
        val unfiled = requireNotNull(mangaRepository.getMangaByUrlAndSource("/manga/unfiled", 100L))
        assertEquals(setOf(inbox), foldersOf(filed.id))
        assertTrue(unfiled.favorite)
        assertTrue(foldersOf(unfiled.id).isEmpty())
    }

    private suspend fun category(name: String): Int = requireNotNull(categoryRepository.insert(Category.create(name))).toInt()

    private suspend fun foldersOf(mangaId: Long?): Set<Int> =
        getCategories.awaitByMangaId(mangaId).mapNotNull { it.id }.toSet()

    private fun work(url: String) = ShareImportWorkRow(
        key = LibraryShareImportPlanner.workKey(100L, url),
        title = url.substringAfterLast('/'),
        sourceId = 100L,
        sourceName = "Test Source",
        url = url,
        isLocal = false,
        alreadyInLibrary = false,
        extensionStatus = ShareImportExtensionStatus.INSTALLED,
        selected = true,
    )
}
