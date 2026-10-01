package eu.kanade.tachiyomi.data.backup.restore

import android.content.Context
import android.net.Uri
import epigraph.ui.moment.MomentEvents
import eu.kanade.tachiyomi.data.backup.BackupNotifier
import eu.kanade.tachiyomi.data.backup.restore.restorers.CategoriesBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.LocalBookBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.MangaBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.PreferenceBackupRestorer
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.BackupUtil
import eu.kanade.tachiyomi.util.system.createFileInCacheDir
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import yokai.i18n.MR
import yokai.util.koin.get
import yokai.util.lang.getString
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class BackupRestorer(
    val context: Context,
    val notifier: BackupNotifier,
    private val categoriesBackupRestorer: CategoriesBackupRestorer = CategoriesBackupRestorer(),
    private val mangaBackupRestorer: MangaBackupRestorer = MangaBackupRestorer(),
    private val localBookBackupRestorer: LocalBookBackupRestorer = LocalBookBackupRestorer(),
    private val preferenceBackupRestorer: PreferenceBackupRestorer = PreferenceBackupRestorer(context),
    private val sourceManager: SourceManager = get(),
) {
    private var restoreAmount = 0
    private var restoreProgress = 0

    /**
     * Mapping of source ID to source name from backup data
     */
    private var sourceMapping: Map<Long, String> = emptyMap()

    private val errors = mutableListOf<Pair<Date, String>>()

    suspend fun restore(uri: Uri) {
        val startTime = System.currentTimeMillis()
        restoreProgress = 0
        errors.clear()

        performRestore(uri)

        val endTime = System.currentTimeMillis()
        val time = endTime - startTime

        val logFile = writeErrorLog()

        notifier.showRestoreComplete(time, errors.size, logFile.parent, logFile.name)
        // A restore with errors is reported by the notification and its log, not celebrated.
        if (errors.isEmpty()) MomentEvents.post(MomentEvents.Event.RestoreDone(restoreAmount - 3))
    }

    private suspend fun performRestore(uri: Uri) {
        val backup = BackupUtil.decodeBackup(context, uri)

        restoreAmount = backup.backupManga.size + backup.backupLocalBooks.size + 3 // +3 for categories, app prefs, source prefs

        sourceMapping = backup.backupSources.associate { it.sourceId to it.name }
        sourceManager.rememberSourceNames(sourceMapping)
        sourceManager.rememberNovelSources(backup.backupSources.filter { it.isNovel }.map { it.sourceId })

        coroutineScope {
            // Restore categories
            if (backup.backupCategories.isNotEmpty()) {
                ensureActive()
                categoriesBackupRestorer.restoreCategories(backup.backupCategories) {
                    restoreProgress += 1
                    showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.categories))
                }
            }

            ensureActive()
            preferenceBackupRestorer.restoreAppPreferences(backup.backupPreferences) {
                restoreProgress += 1
                showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.app_settings))
            }
            ensureActive()
            preferenceBackupRestorer.restoreSourcePreferences(backup.backupSourcePreferences) {
                restoreProgress += 1
                showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.source_settings))
            }

            // Restore individual manga
            backup.backupManga.forEach {
                ensureActive()
                mangaBackupRestorer.restoreManga(
                    it,
                    backup.backupCategories,
                    onComplete = { manga ->
                        restoreProgress += 1
                        showRestoreProgress(restoreProgress, restoreAmount, manga.title)
                    },
                    onError = { manga, e ->
                        val sourceName = sourceMapping[manga.source] ?: manga.source.toString()
                        errors.add(Date() to "${manga.title} [$sourceName]: ${e.message}")
                    },
                )
            }

            // Restore local EPUB/PDF metadata and reader state. Their private bytes are not part
            // of the backup, so a restored entry remains visibly relinkable until the user picks
            // the original file again.
            backup.backupLocalBooks.forEach { localBook ->
                ensureActive()
                runCatching { localBookBackupRestorer.restore(localBook) }
                    .onSuccess {
                        restoreProgress += 1
                        showRestoreProgress(restoreProgress, restoreAmount, localBook.displayName)
                    }
                    .onFailure { error ->
                        errors.add(Date() to "${localBook.displayName} [local book]: ${error.message}")
                    }
            }
        }
        // TODO: optionally trigger online library + tracker update
    }

    /**
     * Called to update dialog in [BackupConst]
     *
     * @param progress restore progress
     * @param amount total restoreAmount of manga
     * @param title title of restored manga
     */
    private fun showRestoreProgress(
        progress: Int,
        amount: Int,
        title: String,
    ) {
        notifier.showRestoreProgress(title, progress, amount)
    }

    internal fun writeErrorLog(): File {
        try {
            if (errors.isNotEmpty()) {
                val file = context.createFileInCacheDir("epigraph_restore.txt")
                val sdf = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.getDefault())

                file.bufferedWriter().use { out ->
                    errors.forEach { (date, message) ->
                        out.write("[${sdf.format(date)}] $message\n")
                    }
                }
                return file
            }
        } catch (e: Exception) {
            // Empty
        }
        return File("")
    }
}
