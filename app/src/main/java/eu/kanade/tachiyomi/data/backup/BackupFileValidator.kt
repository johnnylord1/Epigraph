package eu.kanade.tachiyomi.data.backup

import yokai.util.koin.get
import android.content.Context
import android.net.Uri
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.repo.NovelRepoRepository
import epigraph.sync.core.novels.matchesDeclaredRepository
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.BackupUtil
import kotlinx.coroutines.runBlocking
import yokai.domain.extension.repo.ExtensionRepoRepository
import yokai.i18n.MR
import yokai.util.lang.getString

class BackupFileValidator(
    private val sourceManager: SourceManager = get(),
    private val trackManager: TrackManager = get(),
    private val extensionManager: ExtensionManager = get(),
    private val novelPluginManager: NovelPluginManager = get(),
    private val novelRepos: NovelRepoRepository = get(),
    private val extensionRepos: ExtensionRepoRepository = get(),
) {

    /**
     * Checks for critical backup file data.
     *
     * @throws Exception if manga cannot be found.
     * @return List of missing sources or missing trackers.
     */
    fun validate(context: Context, uri: Uri): Results {
        val backup = try {
            BackupUtil.decodeBackup(context, uri, novelPluginManager::knownPluginLangs)
        } catch (e: Exception) {
            throw IllegalStateException(e)
        }

        // Backups also list sources of removed/browsed titles; only library entries need an extension.
        val librarySourceIds = backup.backupManga.filter { it.favorite }.map { it.source }.toSet()
        val sources = backup.backupSources
            .filter { it.sourceId in librarySourceIds }
            .associate { it.sourceId to it.name }
        // Prefer the name the backup recorded, then the extension that provides the id in the repo
        // catalog: a stub only knows the id until its extension is installed. One extension may
        // provide several sources (one per language), so each name is listed once.
        val catalogNames = extensionManager.availableExtensionsFlow.value
            .flatMap { extension -> extension.sources.map { it.id to extension.name } }
            .toMap()
        val missingSources = librarySourceIds
            .filter { sourceManager.get(it) == null }
            .map { id ->
                sources[id]?.takeUnless { it.isBlank() || it == id.toString() }
                    ?: catalogNames[id]
                    ?: sourceManager.getOrStub(id).name.takeUnless { it.isBlank() || it == id.toString() }
                    ?: "${context.getString(MR.strings.source_not_found)} ($id)"
            }
            .distinct()
            .sorted()

        val trackers = backup.backupManga
            .flatMap { it.tracking }
            .map { it.syncId.toLong() }
            .distinct()
        val missingTrackers = trackers
            .mapNotNull { trackManager.getService(it) }
            .filter { !it.isLogged }
            .map { context.getString(it.nameRes()) }
            .sorted()

        // Repositories an LNReader backup used that the restore will add.
        val newRepositories = if (backup.novelRepositories.isEmpty()) {
            emptyList()
        } else {
            val configured = runBlocking { novelRepos.getAll() }
            backup.novelRepositories
                .filter { repository -> configured.none { it.baseUrl.matchesDeclaredRepository(repository.url) } }
                .map { "${it.name} (${it.url})" }
        }

        // Extension repositories (Epigraph, Mihon, J2K) the restore will add.
        val newExtensionRepositories = if (backup.backupExtensionRepos.isEmpty()) {
            emptyList()
        } else {
            val configured = runBlocking { extensionRepos.getAll() }
                .mapNotNull { ExtensionRepoBackup.key(it.baseUrl) }
                .toSet()
            backup.backupExtensionRepos
                .mapNotNull { repository -> ExtensionRepoBackup.baseUrl(repository.baseUrl)?.let { repository to it } }
                .filter { (_, baseUrl) -> ExtensionRepoBackup.key(baseUrl) !in configured }
                .map { (repository, baseUrl) ->
                    if (repository.name.isBlank()) baseUrl else "${repository.name} ($baseUrl)"
                }
        }

        return Results(missingSources, missingTrackers, newRepositories, newExtensionRepositories)
    }

    data class Results(
        val missingSources: List<String>,
        val missingTrackers: List<String>,
        val newRepositories: List<String> = emptyList(),
        val newExtensionRepositories: List<String> = emptyList(),
    )
}
