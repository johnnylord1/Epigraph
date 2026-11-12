package yokai.presentation.library.update

import eu.kanade.tachiyomi.data.library.LibraryUpdateReport
import yokai.presentation.library.update.LibraryUpdateReportScreenModel.ReportTab

internal suspend fun LibraryUpdateReport.migrationMangaIds(
    tab: ReportTab,
    isInLibrary: suspend (Long) -> Boolean,
): List<Long> {
    val entries = when (tab) {
        ReportTab.ERRORS -> errors
        ReportTab.SKIPPED -> skipped
    }
    return entries.map { it.mangaId }
        .filter { it > 0L }
        .distinct()
        .filter { isInLibrary(it) }
}
