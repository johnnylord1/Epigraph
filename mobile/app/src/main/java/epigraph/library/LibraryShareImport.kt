package epigraph.library

import epigraph.sync.core.extensions.ExtensionParityResolver
import eu.kanade.tachiyomi.data.database.models.Category
import eu.kanade.tachiyomi.data.database.models.MangaImpl
import eu.kanade.tachiyomi.data.library.LibraryUpdateJob
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.extension.model.InstallStep
import eu.kanade.tachiyomi.smartsearch.TitleMatcher
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.model.SManga
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import yokai.data.DatabaseHandler
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories
import yokai.domain.category.interactor.SetMangaCategories
import yokai.domain.extension.repo.interactor.CreateExtensionRepo
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.domain.manga.interactor.UpdateManga
import yokai.domain.manga.models.MangaCover
import yokai.domain.manga.models.MangaUpdate
import yokai.domain.manga.models.cover

enum class ShareImportExtensionStatus {
    INSTALLED,
    AVAILABLE,
    NEEDS_REPO,
    UNAVAILABLE,
}

data class ShareImportExtensionItem(
    val sourceId: Long,
    val sourceName: String,
    val lang: String?,
    val pkgName: String?,
    val extensionName: String?,
    val repoUrl: String?,
    val repoLabel: String?,
    val status: ShareImportExtensionStatus,
    val workCount: Int,
)

data class ShareImportAlternativeMatch(
    val sourceId: Long,
    val sourceName: String,
    val url: String,
    val title: String,
    val thumbnailUrl: String?,
    val similarity: Double,
)

data class ShareImportLibraryEntry(
    val sourceId: Long,
    val sourceName: String,
    val url: String,
    val title: String,
    val cover: MangaCover? = null,
)

data class ShareImportOwnedOtherSource(
    val sourceName: String,
    val title: String,
    val cover: MangaCover? = null,
)

data class ShareImportWorkRow(
    val key: String,
    val title: String,
    val sourceId: Long?,
    val sourceName: String,
    val url: String,
    val cover: MangaCover? = null,
    val isLocal: Boolean,
    val alreadyInLibrary: Boolean,
    val ownedInOtherSource: ShareImportOwnedOtherSource? = null,
    val extensionStatus: ShareImportExtensionStatus,
    val selected: Boolean,
    val searching: Boolean = false,
    val searchDone: Boolean = false,
    val candidates: List<ShareImportAlternativeMatch> = emptyList(),
    val chosenAlternative: ShareImportAlternativeMatch? = null,
) {
    val isReady: Boolean
        get() = !isLocal && !alreadyInLibrary &&
            (extensionStatus == ShareImportExtensionStatus.INSTALLED || chosenAlternative != null)
}

data class ShareImportPlan(
    val manifest: ShareManifest,
    val works: List<ShareImportWorkRow>,
    val extensions: List<ShareImportExtensionItem>,
    val installedCatalogueSources: List<CatalogueSource>,
    val categories: List<Category>,
)

object LibraryShareImportPlanner {
    private const val STRONG_TITLE_MATCH_SCORE = 0.9

    fun workKey(sourceId: Long, url: String): String = "$sourceId|$url"

    private fun findOwnedInOtherSource(
        title: String,
        sourceId: Long,
        entries: List<ShareImportLibraryEntry>,
    ): ShareImportOwnedOtherSource? {
        if (title.isBlank() || entries.isEmpty()) return null
        var bestEntry: ShareImportLibraryEntry? = null
        var bestScore = 0.0
        for (entry in entries) {
            if (entry.sourceId == sourceId) continue
            val score = TitleMatcher.bestScore(title, entry.title)
            if (score >= STRONG_TITLE_MATCH_SCORE && score > bestScore) {
                bestScore = score
                bestEntry = entry
                if (score >= 1.0) break
            }
        }
        return bestEntry?.let {
            ShareImportOwnedOtherSource(
                sourceName = it.sourceName,
                title = it.title,
                cover = it.cover,
            )
        }
    }

    fun buildPlan(
        manifest: ShareManifest,
        favoriteKeys: Set<String>,
        installedSourceIds: Set<Long>,
        availableExtensions: List<Extension.Available>,
        installedCatalogueSources: List<CatalogueSource>,
        categories: List<Category>,
        libraryEntries: List<ShareImportLibraryEntry> = emptyList(),
    ): ShareImportPlan {
        val availableByPkg = availableExtensions.associateBy { it.pkgName }
        val availableBySourceId = mutableMapOf<Long, Extension.Available>()
        for (ext in availableExtensions) {
            for (src in ext.sources) {
                availableBySourceId.putIfAbsent(src.id, ext)
            }
        }

        val workCountBySourceId = manifest.works
            .mapNotNull { it.sourceId }
            .groupingBy { it }
            .eachCount()

        val sourceById = manifest.sources.associateBy { it.sourceId }
        val statusBySourceId = mutableMapOf<Long, ShareImportExtensionStatus>()
        val extensions = manifest.sources.map { source ->
            val available = source.pkgName?.let { availableByPkg[it] } ?: availableBySourceId[source.sourceId]
            val repoUrl = LibraryShareLink.sanitizePublicRepoUrl(source.repoUrl)
            val status = when {
                source.sourceId in installedSourceIds -> ShareImportExtensionStatus.INSTALLED
                available != null -> ShareImportExtensionStatus.AVAILABLE
                repoUrl != null -> ShareImportExtensionStatus.NEEDS_REPO
                else -> ShareImportExtensionStatus.UNAVAILABLE
            }
            statusBySourceId[source.sourceId] = status
            ShareImportExtensionItem(
                sourceId = source.sourceId,
                sourceName = source.name,
                lang = source.lang,
                pkgName = available?.pkgName ?: source.pkgName,
                extensionName = available?.name ?: source.name,
                repoUrl = repoUrl,
                repoLabel = LibraryShareLink.formatRepoLabel(repoUrl),
                status = status,
                workCount = workCountBySourceId[source.sourceId] ?: 0,
            )
        }

        val libraryEntryByKey = libraryEntries.associateBy { workKey(it.sourceId, it.url) }
        val works = manifest.works.mapIndexed { index, work ->
            val workSourceId = work.sourceId
            val isLocal = workSourceId == null || work.url.isEmpty()
            val exactEntry = if (!isLocal) libraryEntryByKey[workKey(workSourceId, work.url)] else null
            val alreadyInLibrary = !isLocal && workKey(workSourceId, work.url) in favoriteKeys
            val ownedInOtherSource = if (!isLocal && !alreadyInLibrary) {
                findOwnedInOtherSource(work.title, workSourceId, libraryEntries)
            } else {
                null
            }
            val extStatus = if (isLocal) {
                ShareImportExtensionStatus.UNAVAILABLE
            } else {
                statusBySourceId[workSourceId] ?: ShareImportExtensionStatus.UNAVAILABLE
            }
            val sourceName = if (isLocal) {
                "Local"
            } else {
                sourceById[workSourceId]?.name ?: "Source $workSourceId"
            }
            ShareImportWorkRow(
                key = "$index:${work.sourceId ?: 0}:${work.url}:${work.title}",
                title = work.title,
                sourceId = work.sourceId,
                sourceName = sourceName,
                url = work.url,
                cover = exactEntry?.cover,
                isLocal = isLocal,
                alreadyInLibrary = alreadyInLibrary,
                ownedInOtherSource = ownedInOtherSource,
                extensionStatus = extStatus,
                selected = !isLocal && !alreadyInLibrary && ownedInOtherSource == null &&
                    extStatus == ShareImportExtensionStatus.INSTALLED,
            )
        }

        return ShareImportPlan(
            manifest = manifest,
            works = works,
            extensions = extensions,
            installedCatalogueSources = installedCatalogueSources,
            categories = categories,
        )
    }
}

class LibraryShareImportCoordinator(
    private val extensionManager: ExtensionManager,
    private val sourceManager: SourceManager,
    private val createExtensionRepo: CreateExtensionRepo,
    private val getManga: GetManga,
    private val insertManga: InsertManga,
    private val updateManga: UpdateManga,
    private val getCategories: GetCategories,
    private val setMangaCategories: SetMangaCategories,
    private val databaseHandler: DatabaseHandler,
) {
    suspend fun analyze(manifest: ShareManifest): ShareImportPlan = withContext(Dispatchers.IO) {
        extensionManager.isInitialized.first { it }
        if (extensionManager.availableExtensionsFlow.value.isEmpty()) {
            runCatching { extensionManager.findAvailableExtensions() }
        }
        val favorites = getManga.awaitFavorites()
        val favoriteKeys = favorites.mapTo(mutableSetOf()) { LibraryShareImportPlanner.workKey(it.source, it.url) }
        val installedSourceNameById = mutableMapOf<Long, String>()
        val installedSourceIds = extensionManager.installedExtensionsFlow.value
            .flatMapTo(mutableSetOf()) { ext ->
                ext.sources.map { src ->
                    installedSourceNameById[src.id] = src.name
                    src.id
                }
            }
        val installedCatalogueSources = sourceManager.getCatalogueSources()
            .filter { it.id != 0L }
            .sortedBy { it.name.lowercase() }
        for (src in installedCatalogueSources) {
            installedSourceIds += src.id
            installedSourceNameById[src.id] = src.name
        }
        val libraryEntries = favorites.map { fav ->
            val resolvedName = sourceManager.get(fav.source)?.name
                ?: installedSourceNameById[fav.source]
                ?: if (fav.source == 0L) "Local" else "Source ${fav.source}"
            ShareImportLibraryEntry(
                sourceId = fav.source,
                sourceName = resolvedName,
                url = fav.url,
                title = fav.title,
                cover = fav.cover(),
            )
        }
        val categories = getCategories.await(CategoryLibrary.COMICS).filter { (it.id ?: 0) > 0 }

        LibraryShareImportPlanner.buildPlan(
            manifest = manifest,
            favoriteKeys = favoriteKeys,
            installedSourceIds = installedSourceIds,
            availableExtensions = extensionManager.availableExtensionsFlow.value,
            installedCatalogueSources = installedCatalogueSources,
            categories = categories,
            libraryEntries = libraryEntries,
        )
    }

    /**
     * Installs a missing extension, automatically adding its repository first when the share
     * manifest provided one (`NEEDS_REPO`).
     */
    suspend fun installExtension(ext: ShareImportExtensionItem, useSilentBatchInstaller: Boolean = false): Boolean =
        withContext(Dispatchers.IO) {
            extensionManager.isInitialized.first { it }
            if (ext.status == ShareImportExtensionStatus.NEEDS_REPO && ext.repoUrl != null) {
                val indexUrl = ExtensionParityResolver.repositoryIndexUrl(ext.repoUrl)
                runCatching { createExtensionRepo.await(indexUrl) }
                runCatching { extensionManager.findAvailableExtensions() }
            } else if (extensionManager.availableExtensionsFlow.value.isEmpty()) {
                runCatching { extensionManager.findAvailableExtensions() }
            }

            val available = extensionManager.availableExtensionsFlow.value
                .filter { candidate ->
                    (ext.pkgName != null && candidate.pkgName == ext.pkgName) ||
                        candidate.sources.any { it.id == ext.sourceId }
                }
                .maxByOrNull { it.versionCode }
                ?: return@withContext false

            val alreadyInstalled = extensionManager.installedExtensionsFlow.value
                .any { it.pkgName == available.pkgName }
            if (alreadyInstalled) return@withContext true

            val installerJob = SupervisorJob()
            val installerScope = CoroutineScope(Dispatchers.IO + installerJob)
            try {
                val info = ExtensionManager.ExtensionInfo(available)
                val flow = if (useSilentBatchInstaller) {
                    extensionManager.installExtensionWithoutPrompt(info, installerScope)
                } else {
                    extensionManager.installExtension(info, installerScope)
                }
                val finalStep = withTimeoutOrNull(90_000L) {
                    flow.first { it.first.isCompleted() }.first
                }
                finalStep == InstallStep.Installed ||
                    extensionManager.installedExtensionsFlow.value.any { it.pkgName == available.pkgName }
            } finally {
                installerJob.cancel()
            }
        }

    /** Lazily loads a cover thumbnail for a shared work whose source is installed locally. */
    suspend fun fetchCoverForInstalledWork(
        sourceId: Long,
        url: String,
        title: String,
    ): MangaCover? = withContext(Dispatchers.IO) {
        val existing = runCatching { getManga.awaitByUrlAndSource(url, sourceId) }.getOrNull()
        if (existing != null && !existing.thumbnail_url.isNullOrBlank()) {
            return@withContext existing.cover()
        }
        val source = sourceManager.get(sourceId) ?: return@withContext null
        val thumb = withTimeoutOrNull(6_000L) {
            val smanga = SManga.create().apply {
                this.url = url
                this.title = title
            }
            runCatching { source.getMangaDetails(smanga).thumbnail_url }.getOrNull()
                ?.takeIf { it.isNotBlank() }
        }
        if (thumb != null) {
            MangaCover(
                mangaId = existing?.id,
                sourceId = sourceId,
                url = thumb,
                lastModified = 0L,
                inLibrary = false,
            )
        } else {
            null
        }
    }

    /** Searches installed catalogue sources for a single shared work, ranked via [TitleMatcher]. */
    suspend fun searchInInstalledSources(
        title: String,
        sources: List<CatalogueSource>,
    ): List<ShareImportAlternativeMatch> = withContext(Dispatchers.IO) {
        if (title.isBlank() || sources.isEmpty()) return@withContext emptyList()
        val permits = Semaphore(4)
        val queries = TitleMatcher.searchQueries(title).take(2)
        val matches = coroutineScope {
            sources.map { source ->
                async {
                    permits.withPermit {
                        withTimeoutOrNull(10_000L) {
                            val found = mutableListOf<ShareImportAlternativeMatch>()
                            for (query in queries) {
                                val page = runCatching {
                                    source.getSearchManga(1, query, source.getFilterList())
                                }.getOrNull() ?: continue
                                for (manga in page.mangas) {
                                    val score = TitleMatcher.bestScore(title, manga.title)
                                    if (score >= TitleMatcher.MIN_MATCH_SCORE) {
                                        found += ShareImportAlternativeMatch(
                                            sourceId = source.id,
                                            sourceName = source.name,
                                            url = manga.url,
                                            title = manga.title,
                                            thumbnailUrl = manga.thumbnail_url,
                                            similarity = score,
                                        )
                                    }
                                }
                                if (found.any { it.similarity >= 0.9 }) break
                            }
                            found
                        }.orEmpty()
                    }
                }
            }.awaitAll().flatten()
        }
        matches
            .distinctBy { "${it.sourceId}|${it.url}" }
            .sortedByDescending { it.similarity }
            .take(12)
            .filter { getManga.awaitByUrlAndSource(it.url, it.sourceId)?.favorite != true }
    }

    /** Adds all selected works to the local library (within a DB transaction) and notifies observers. */
    suspend fun importSelectedWorks(
        works: List<ShareImportWorkRow>,
        defaultCategoryId: Int,
        extraCategoryIds: Set<Int>,
    ): Int = withContext(Dispatchers.IO) {
        val chosen = works.filter { it.selected && it.isReady }
        if (chosen.isEmpty()) return@withContext 0
        val now = System.currentTimeMillis()
        val addedIds = mutableListOf<Long>()

        databaseHandler.await(inTransaction = true) {
            val categoryIds = if (defaultCategoryId > 0 || extraCategoryIds.isNotEmpty()) {
                getCategories.await(CategoryLibrary.COMICS).mapNotNull { category ->
                    category.id?.takeIf { it > 0 && (it == defaultCategoryId || it in extraCategoryIds) }?.toLong()
                }
            } else {
                emptyList()
            }

            for (work in chosen) {
                val alt = work.chosenAlternative
                val sourceId = alt?.sourceId ?: work.sourceId ?: continue
                val url = alt?.url ?: work.url
                val title = alt?.title ?: work.title
                val thumbnailUrl = alt?.thumbnailUrl

                val existing = getManga.awaitByUrlAndSource(url, sourceId)
                if (existing?.favorite == true) continue
                val mangaId = if (existing == null) {
                    val newManga = MangaImpl().apply {
                        this.source = sourceId
                        this.url = url
                        this.title = title
                        this.thumbnail_url = thumbnailUrl
                        this.favorite = true
                        this.date_added = now
                        this.initialized = false
                    }
                    insertManga.await(newManga)
                } else {
                    updateManga.await(
                        MangaUpdate(
                            id = existing.id!!,
                            favorite = true,
                            dateAdded = if (existing.date_added == 0L) now else existing.date_added,
                        ),
                    )
                    existing.id
                }
                if (mangaId != null) {
                    if (categoryIds.isNotEmpty()) {
                        val existingCategoryIds = if (existing != null) {
                            getCategories.awaitByMangaId(mangaId).mapNotNull { it.id?.toLong() }
                        } else {
                            emptyList()
                        }
                        setMangaCategories.await(mangaId, (existingCategoryIds + categoryIds).distinct())
                    }
                    addedIds += mangaId
                }
            }
        }

        addedIds.forEach { LibraryUpdateJob.updateMutableFlow.tryEmit(it) }
        addedIds.size
    }
}
