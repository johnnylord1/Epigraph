package yokai.presentation.library.update

import eu.kanade.tachiyomi.data.library.LibraryUpdateReport
import eu.kanade.tachiyomi.data.library.LibraryUpdateReportEntry
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.presentation.library.update.LibraryUpdateReportScreenModel.ReportTab

class LibraryUpdateReportMigrationTest {
    @Test
    fun `error migration includes only distinct current library entries from errors`() = runTest {
        val report = LibraryUpdateReport(
            errors = listOf(entry(10), entry(20), entry(10), entry(0), entry(-1), entry(30)),
            skipped = listOf(entry(40)),
        )
        val requested = mutableListOf<Long>()
        val ids = report.migrationMangaIds(ReportTab.ERRORS) { id ->
            requested += id
            id in setOf(10L, 30L, 40L)
        }
        assertEquals(listOf(10L, 30L), ids)
        assertEquals(listOf(10L, 20L, 30L), requested)
    }

    @Test
    fun `skipped migration does not include titles from the error tab`() = runTest {
        val report = LibraryUpdateReport(errors = listOf(entry(10)), skipped = listOf(entry(40), entry(50)))
        assertEquals(listOf(40L, 50L), report.migrationMangaIds(ReportTab.SKIPPED) { true })
    }

    @Test
    fun `legacy text logs and removed titles cannot start a migration`() = runTest {
        val report = LibraryUpdateReport(errors = listOf(entry(0), entry(10)))
        assertEquals(emptyList<Long>(), report.migrationMangaIds(ReportTab.ERRORS) { false })
        assertEquals(emptyList<Long>(), LibraryUpdateReport().migrationMangaIds(ReportTab.SKIPPED) { true })
    }

    private fun entry(id: Long) = LibraryUpdateReportEntry(mangaId = id, mangaTitle = "Title $id")
}
