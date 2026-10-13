package eu.kanade.tachiyomi.data.backup.restore

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import co.touchlab.kermit.Logger
import epigraph.books.importing.LocalBookStreamSource
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.interactor.NovelRepoIndexValidation
import epigraph.novel.repo.interactor.NovelRepoIndexValidator
import epigraph.novel.repo.model.NovelRepo
import epigraph.sync.core.novels.matchesDeclaredRepository
import epigraph.ui.moment.MomentEvents
import eu.kanade.tachiyomi.data.backup.BackupContainer
import eu.kanade.tachiyomi.data.backup.BackupNotifier
import eu.kanade.tachiyomi.data.backup.CategoryPreferenceBackup
import eu.kanade.tachiyomi.data.backup.ExtensionRepoBackup
import eu.kanade.tachiyomi.data.backup.models.BackupExtensionRepo
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBook
import eu.kanade.tachiyomi.data.backup.models.BackupNovelRepository
import eu.kanade.tachiyomi.data.backup.restore.restorers.CategoriesBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.LocalBookBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.MangaBackupRestorer
import eu.kanade.tachiyomi.data.backup.restore.restorers.PreferenceBackupRestorer
import eu.kanade.tachiyomi.data.cache.CoverCache
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.BackupUtil
import eu.kanade.tachiyomi.util.OpenedBackup
import eu.kanade.tachiyomi.util.system.createFileInCacheDir
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import yokai.domain.extension.repo.ExtensionRepoRepository
import yokai.domain.extension.repo.interactor.CreateExtensionRepo
import yokai.i18n.MR
import yokai.util.koin.get
import yokai.util.lang.getString
import java.io.File
import java.io.IOException
import java.io.InputStream
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
    private val novelPluginManager: NovelPluginManager = get(),
    private val coverCache: CoverCache = get(),
    private val novelRepos: NovelRepoRepository = get(),
    private val novelRepoValidator: NovelRepoIndexValidator = get(),
    private val extensionRepos: ExtensionRepoRepository = get(),
    private val createExtensionRepo: CreateExtensionRepo = get(),
    private val extensionManager: ExtensionManager = get(),
) {
    private var restoreAmount = 0
    private var restoreProgress = 0
    private var lastProgressNotification = 0L

    /**
     * Mapping of source ID to source name from backup data
     */
    private var sourceMapping: Map<Long, String> = emptyMap()

    private val errors = mutableListOf<Pair<Date, String>>()

    private val journal = RestoreJournal(RestoreJournal.file(context.filesDir))

    suspend fun restore(uri: Uri) {
        val startTime = System.currentTimeMillis()
        restoreProgress = 0
        errors.clear()

        performRestore(uri)
        // Finished: a later restore of the same file starts over instead of resuming.
        journal.delete()

        val endTime = System.currentTimeMillis()
        val time = endTime - startTime

        val logFile = writeErrorLog()

        notifier.showRestoreComplete(time, errors.size, logFile.parent, logFile.name)
        // A restore with errors is reported by the notification and its log, not celebrated.
        if (errors.isEmpty()) MomentEvents.post(MomentEvents.Event.RestoreDone(restoreAmount - 3))
    }

    private suspend fun performRestore(uri: Uri) {
        // The journal is keyed by the backup's bytes, so a different file never skips anything.
        if (journal.open("$uri ${backupFingerprint(uri)}")) {
            Logger.i { "Resuming an interrupted restore (${journal.completed.size} steps already done)" }
            journal.recordedErrors.forEach { (time, message) -> errors.add(Date(time) to message) }
        }

        BackupUtil.openBackup(context, uri, novelPluginManager::knownPluginLangs, ::cacheBackupCover).use { opened ->
            restoreContents(opened)
        }
        // TODO: optionally trigger online library + tracker update
    }

    private suspend fun restoreContents(opened: OpenedBackup) {
        val backup = opened.backup
        restoreAmount = backup.backupManga.size + backup.backupLocalBooks.size + 3 // +3 for categories, app prefs, source prefs
        restoreProgress = journal.completed.count {
            it != RestoreJournal.REPOSITORIES && it != RestoreJournal.EXTENSION_REPOSITORIES
        }

        sourceMapping = backup.backupSources.associate { it.sourceId to it.name }
        sourceManager.rememberSourceNames(sourceMapping)
        sourceManager.rememberNovelSources(backup.backupSources.filter { it.isNovel }.map { it.sourceId })

        coroutineScope {
            // Restore categories
            if (backup.backupCategories.isNotEmpty() && !journal.isDone(RestoreJournal.CATEGORIES)) {
                ensureActive()
                categoriesBackupRestorer.restoreCategories(backup.backupCategories) {
                    restoreProgress += 1
                    showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.categories))
                }
                journal.markDone(RestoreJournal.CATEGORIES)
            }

            // Novel plugin repositories (LNReader) before the titles, so their plugins are listed.
            if (backup.novelRepositories.isNotEmpty() && !journal.isDone(RestoreJournal.REPOSITORIES)) {
                ensureActive()
                restoreNovelRepositories(backup.novelRepositories)
                journal.markDone(RestoreJournal.REPOSITORIES)
            }

            // Extension repositories (Epigraph, Mihon, J2K) before the titles, so the extensions
            // of the restored titles are listed and can be installed right away.
            if (backup.backupExtensionRepos.isNotEmpty() && !journal.isDone(RestoreJournal.EXTENSION_REPOSITORIES)) {
                ensureActive()
                restoreExtensionRepositories(backup.backupExtensionRepos)
                journal.markDone(RestoreJournal.EXTENSION_REPOSITORIES)
            }

            if (!journal.isDone(RestoreJournal.APP_PREFERENCES)) {
                ensureActive()
                val unresolved = preferenceBackupRestorer.restoreAppPreferences(
                    backup.backupPreferences,
                    backup.backupCategories,
                ) {
                    restoreProgress += 1
                    showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.app_settings))
                }
                unresolved.forEach { setting ->
                    addError(
                        context.getString(
                            when (setting) {
                                CategoryPreferenceBackup.Setting.AUTOMATIC_DOWNLOADS ->
                                    MR.strings.restore_download_categories_unresolved
                                CategoryPreferenceBackup.Setting.LIBRARY_UPDATES ->
                                    MR.strings.restore_update_categories_unresolved
                                CategoryPreferenceBackup.Setting.DEFAULT_CATEGORY ->
                                    MR.strings.restore_default_category_unresolved
                            },
                        ),
                    )
                }
                journal.markDone(RestoreJournal.APP_PREFERENCES)
            }
            if (!journal.isDone(RestoreJournal.SOURCE_PREFERENCES)) {
                ensureActive()
                preferenceBackupRestorer.restoreSourcePreferences(backup.backupSourcePreferences) {
                    restoreProgress += 1
                    showRestoreProgress(restoreProgress, restoreAmount, context.getString(MR.strings.source_settings))
                }
                journal.markDone(RestoreJournal.SOURCE_PREFERENCES)
            }

            // Restore individual manga. Each title commits in its own transaction and is then
            // journaled, failed ones included, so a resumed restore neither redoes nor re-reports it.
            backup.backupManga.forEachIndexed { index, backupManga ->
                val step = RestoreJournal.manga(index)
                if (journal.isDone(step)) return@forEachIndexed
                ensureActive()
                mangaBackupRestorer.restoreManga(
                    backupManga,
                    backup.backupCategories,
                    onComplete = { manga ->
                        restoreProgress += 1
                        showRestoreProgress(restoreProgress, restoreAmount, manga.title)
                    },
                    onError = { manga, e ->
                        val sourceName = sourceMapping[manga.source] ?: manga.source.toString()
                        addError("${manga.title} [$sourceName]: ${e.message}")
                    },
                )
                journal.markDone(step)
            }

            // Restore local EPUB/PDF metadata and reader state. A backup made with book files also
            // brings back each missing file once its SHA-256 matches; otherwise the entry remains
            // visibly relinkable until the user picks the original file again.
            backup.backupLocalBooks.forEachIndexed { index, localBook ->
                val step = RestoreJournal.localBook(index)
                if (journal.isDone(step)) return@forEachIndexed
                ensureActive()
                try {
                    localBookBackupRestorer.restore(localBook, storedBookFile(opened, localBook))
                    restoreProgress += 1
                    showRestoreProgress(restoreProgress, restoreAmount, localBook.displayName)
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Exception) {
                    addError("${localBook.displayName} [local book]: ${error.message}")
                }
                journal.markDone(step)
            }
        }
    }

    /** The book's file stored in the backup, when the backup was made with book files. */
    private fun storedBookFile(opened: OpenedBackup, localBook: BackupLocalBook): LocalBookStreamSource? {
        val path = runCatching { BackupContainer.localBookPath(localBook.sha256, localBook.contentType) }.getOrNull()
            ?: return null
        if (!opened.hasEntry(path)) return null
        return object : LocalBookStreamSource {
            override val displayName: String = localBook.displayName

            override fun openStream(): InputStream =
                opened.openEntry(path) ?: throw IOException("The backup no longer contains $path")
        }
    }

    private fun addError(message: String) {
        val now = Date()
        errors.add(now to message)
        runCatching { journal.recordError(now.time, message) }
    }

    /** SHA-256 of the backup's bytes; it tells a resumed restore that it reads the same file. */
    private fun backupFingerprint(uri: Uri): String =
        context.contentResolver.openInputStream(uri)?.use(BackupContainer::sha256)
            ?: throw IOException("Unable to open the backup")

    /** Adds each repository not configured yet, once its index proves to be a plugin repository. */
    private suspend fun restoreNovelRepositories(repositories: List<BackupNovelRepository>) {
        repositories.forEach { repository ->
            val existing = novelRepos.getAll()
            if (existing.any { it.baseUrl.matchesDeclaredRepository(repository.url) }) return@forEach
            val validation = runCatching { novelRepoValidator.validate(repository.url) }.getOrNull()
            if (validation !is NovelRepoIndexValidation.Valid) {
                addError("${repository.name} [${repository.url}]: ${context.getString(MR.strings.restore_repository_unavailable)}")
                return@forEach
            }
            if (existing.none { it.baseUrl == validation.indexUrl }) {
                novelRepos.insert(NovelRepo(validation.indexUrl, repository.name))
            }
        }
    }

    /**
     * Adds each extension repository not configured yet. The signing key comes from the
     * repository's own `repo.json`, never from the backup, so a backup cannot make an extension
     * trusted by itself.
     */
    private suspend fun restoreExtensionRepositories(repositories: List<BackupExtensionRepo>) {
        var added = false
        repositories.forEach { repository ->
            val baseUrl = ExtensionRepoBackup.baseUrl(repository.baseUrl)
            val label = when {
                repository.name.isBlank() -> baseUrl ?: repository.baseUrl
                else -> "${repository.name} [${baseUrl ?: repository.baseUrl}]"
            }
            val unavailable = "$label: ${context.getString(MR.strings.restore_extension_repository_unavailable)}"
            if (baseUrl == null) {
                addError(unavailable)
                return@forEach
            }
            if (extensionRepos.getAll().any { ExtensionRepoBackup.baseUrl(it.baseUrl) == baseUrl }) return@forEach
            when (createExtensionRepo.await("$baseUrl/index.min.json")) {
                CreateExtensionRepo.Result.Success -> added = true
                // Already listed, possibly under another address signed by the same key.
                CreateExtensionRepo.Result.RepoAlreadyExists, is CreateExtensionRepo.Result.DuplicateFingerprint -> Unit
                CreateExtensionRepo.Result.InvalidUrl, CreateExtensionRepo.Result.Error -> addError(unavailable)
            }
        }
        if (added) {
            // Installed extensions signed by a restored repository become trusted, and the
            // extensions of the restored titles show up as available.
            extensionManager.refreshTrust()
            extensionManager.findAvailableExtensions()
        }
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
        // A large library restores several titles per second; Android drops a notification
        // posted more often than that and logs each one, so post at most twice a second.
        val now = SystemClock.elapsedRealtime()
        if (progress < amount && now - lastProgressNotification < PROGRESS_NOTIFICATION_INTERVAL_MS) return
        lastProgressNotification = now
        notifier.showRestoreProgress(title, progress, amount)
    }

    /** Keeps a cover shipped in the backup (LNReader) unless that cover is already cached. */
    private fun cacheBackupCover(thumbnailUrl: String, image: ByteArray) {
        val file = coverCache.getCoverFile(thumbnailUrl) ?: return
        if (file.exists()) return
        val partial = File(file.parentFile, file.name + ".tmp")
        try {
            partial.writeBytes(image)
            if (!partial.renameTo(file)) partial.delete()
        } finally {
            if (partial.exists()) partial.delete()
        }
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

    private companion object {
        const val PROGRESS_NOTIFICATION_INTERVAL_MS = 500L
    }
}
