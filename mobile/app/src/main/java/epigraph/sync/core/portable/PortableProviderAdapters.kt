package epigraph.sync.core.portable

import epigraph.contract.ChapterResolution
import epigraph.contract.DependencyResolutionResult
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableContentProvider
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderDependency
import epigraph.contract.WorkResolution
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.source.NovelSource
import yokai.domain.chapter.ChapterRepository
import yokai.domain.manga.MangaRepository

interface ComicDependencyRegistry {
    fun isPackageInstalled(packageName: String): Boolean

    fun packageForSource(sourceId: Long): String?

    fun isSourceReady(sourceId: Long): Boolean
}

class MihonComicDependencyRegistry(
    private val extensions: ExtensionManager,
    private val sources: SourceManager,
) : ComicDependencyRegistry {
    override fun isPackageInstalled(packageName: String): Boolean =
        extensions.installedExtensionsFlow.value.any { it.pkgName == packageName }

    override fun packageForSource(sourceId: Long): String? = extensions.getPackageName(sourceId)

    override fun isSourceReady(sourceId: Long): Boolean = sources.get(sourceId) is CatalogueSource
}

interface NovelDependencyRegistry {
    suspend fun prepare()

    fun isPluginInstalled(pluginId: String): Boolean

    fun sourceId(pluginId: String): Long?
}

class LnReaderNovelDependencyRegistry(
    private val plugins: NovelPluginManager,
) : NovelDependencyRegistry {
    override suspend fun prepare() = plugins.ensureInstalledPluginsLoaded()

    override fun isPluginInstalled(pluginId: String): Boolean = plugins.isInstalled(pluginId)

    override fun sourceId(pluginId: String): Long? =
        plugins.installedSourcesFlow.value.firstOrNull { it.pluginId == pluginId }?.id
}

interface PortableLocalEntityLookup {
    suspend fun comicWork(sourceId: Long, mangaKey: String): String?

    suspend fun comicChapter(sourceId: Long, mangaKey: String, chapterKey: String): String?

    suspend fun novelWork(sourceId: Long, novelKey: String): String?

    suspend fun novelChapter(sourceId: Long, novelKey: String, chapterKey: String): String?
}

fun interface PortableWorkMaterializer {
    suspend fun materialize(ref: PortableWorkRef): WorkResolution
}

fun interface PortableChapterMaterializer {
    suspend fun materialize(ref: PortableChapterRef): ChapterResolution

    suspend fun materializeAll(refs: List<PortableChapterRef>): List<ChapterResolution> =
        refs.map { materialize(it) }
}

interface PortableChapterBatchResolver {
    suspend fun resolveChapters(refs: List<PortableChapterRef>): List<ChapterResolution>
}

class EpigraphPortableLocalEntityLookup(
    private val mangas: MangaRepository,
    private val chapters: ChapterRepository,
) : PortableLocalEntityLookup {
    override suspend fun comicWork(sourceId: Long, mangaKey: String): String? =
        mangas.getMangaByUrlAndSource(mangaKey, sourceId)?.id?.toString()

    override suspend fun comicChapter(sourceId: Long, mangaKey: String, chapterKey: String): String? {
        val manga = mangas.getMangaByUrlAndSource(mangaKey, sourceId) ?: return null
        val mangaId = manga.id ?: return null
        return chapters.getChapterByUrlAndMangaId(chapterKey, mangaId, false)?.id?.toString()
    }

    override suspend fun novelWork(sourceId: Long, novelKey: String): String? =
        mangas.getMangaByUrlAndSource(novelKey, sourceId)?.id?.toString()

    override suspend fun novelChapter(sourceId: Long, novelKey: String, chapterKey: String): String? {
        val manga = mangas.getMangaByUrlAndSource(novelKey, sourceId) ?: return null
        val mangaId = manga.id ?: return null
        return chapters.getChapterByUrlAndMangaId(chapterKey, mangaId, false)?.id?.toString()
    }
}

class MihonPortableProvider(
    private val registry: ComicDependencyRegistry,
    private val local: PortableLocalEntityLookup,
    private val materializer: PortableWorkMaterializer? = null,
    private val chapterMaterializer: PortableChapterMaterializer? = null,
) : PortableContentProvider, PortableChapterBatchResolver {
    override val ecosystem: PortableEcosystem = PortableEcosystem.SUWAYOMI

    override suspend fun inspectDependencies(
        dependencies: List<ProviderDependency>,
    ): DependencyResolutionResult = DependencyResolutionResult(
        dependencies.associateWith { providerDependency ->
            val dependency = (providerDependency as? ProviderDependency.Comic)?.dependency
                ?: return@associateWith conflict()
            val sourceIds = dependency.requiredSourceIds.map { it.toLong() }
            if (!registry.isPackageInstalled(dependency.pkgName)) {
                // Forks republish a source under another package with the same id (a "revived"
                // Manganato keeps the original id). The source id is what the works are keyed by,
                // so an installed extension already loading every one of them serves them, the
                // same as works whose manifest names no package at all.
                val servedElsewhere = sourceIds.isNotEmpty() && sourceIds.all {
                    registry.packageForSource(it) != null && registry.isSourceReady(it)
                }
                return@associateWith if (servedElsewhere) {
                    PortableResolution(PortableResolutionState.READY)
                } else {
                    PortableResolution(
                        PortableResolutionState.PENDING_DEPENDENCY,
                        PortableResolutionReason.EXTENSION_NOT_FOUND,
                    )
                }
            }
            when {
                sourceIds.any { registry.packageForSource(it) != dependency.pkgName } -> PortableResolution(
                    PortableResolutionState.REQUIRES_USER_ACTION,
                    PortableResolutionReason.SOURCE_NOT_FOUND,
                )
                sourceIds.any { !registry.isSourceReady(it) } -> PortableResolution(
                    PortableResolutionState.RETRYABLE_FAILURE,
                    PortableResolutionReason.SOURCE_NOT_LOADED,
                )
                else -> PortableResolution(PortableResolutionState.READY)
            }
        },
    )

    override suspend fun resolveWork(ref: PortableWorkRef): WorkResolution {
        val comic = ref as? PortableWorkRef.Comic
            ?: return WorkResolution(ref, conflict())
        resolveExistingWork(ref)?.let { return it }
        if (!registry.isSourceReady(comic.sourceId.toLong())) {
            return WorkResolution(
                ref,
                PortableResolution(
                    PortableResolutionState.RETRYABLE_FAILURE,
                    PortableResolutionReason.SOURCE_NOT_LOADED,
                ),
            )
        }
        return materializer?.materialize(ref) ?: unsupported(ref)
    }

    // The exact source id and provider key identify the local row; binding to it reads nothing
    // from the extension, so a restored title keeps syncing while its extension is not installed.
    override suspend fun resolveExistingWork(ref: PortableWorkRef): WorkResolution? {
        val comic = ref as? PortableWorkRef.Comic ?: return null
        val localId = local.comicWork(comic.sourceId.toLong(), comic.mangaKey.value) ?: return null
        return WorkResolution(ref, PortableResolution(PortableResolutionState.BOUND), localId)
    }

    override suspend fun resolveChapter(ref: PortableChapterRef): ChapterResolution =
        resolveChapters(listOf(ref)).single()

    override suspend fun resolveChapters(refs: List<PortableChapterRef>): List<ChapterResolution> {
        if (refs.isEmpty()) return emptyList()
        val resolved = LinkedHashMap<PortableChapterRef, ChapterResolution>(refs.size)
        val missing = ArrayList<PortableChapterRef>(refs.size)
        for (ref in refs) {
            val comic = ref as? PortableChapterRef.Comic
            if (comic == null) {
                resolved[ref] = ChapterResolution(ref, conflict())
                continue
            }
            val sourceId = comic.work.sourceId.toLong()
            val localId = local.comicChapter(sourceId, comic.work.mangaKey.value, comic.chapterKey.value)
            when {
                localId != null -> resolved[ref] =
                    ChapterResolution(ref, PortableResolution(PortableResolutionState.BOUND), localId)
                !registry.isSourceReady(sourceId) -> resolved[ref] = ChapterResolution(
                    ref,
                    PortableResolution(
                        PortableResolutionState.RETRYABLE_FAILURE,
                        PortableResolutionReason.SOURCE_NOT_LOADED,
                    ),
                )
                else -> missing += ref
            }
        }
        val materialized = chapterMaterializer?.materializeAll(missing)
            ?: missing.map(::unsupported)
        materialized.forEach { resolved[it.ref] = it }
        return refs.map { ref -> resolved[ref] ?: ChapterResolution(ref, conflict()) }
    }
}

class LnReaderPortableProvider(
    private val registry: NovelDependencyRegistry,
    private val local: PortableLocalEntityLookup,
    private val materializer: PortableWorkMaterializer? = null,
    private val chapterMaterializer: PortableChapterMaterializer? = null,
) : PortableContentProvider, PortableChapterBatchResolver {
    override val ecosystem: PortableEcosystem = PortableEcosystem.LNREADER

    override suspend fun inspectDependencies(
        dependencies: List<ProviderDependency>,
    ): DependencyResolutionResult {
        registry.prepare()
        return DependencyResolutionResult(
            dependencies.associateWith { providerDependency ->
                val dependency = (providerDependency as? ProviderDependency.Novel)?.dependency
                    ?: return@associateWith conflict()
                when {
                    !registry.isPluginInstalled(dependency.pluginId) -> PortableResolution(
                        PortableResolutionState.PENDING_DEPENDENCY,
                        PortableResolutionReason.PLUGIN_NOT_FOUND,
                    )
                    registry.sourceId(dependency.pluginId) == null -> PortableResolution(
                        PortableResolutionState.RETRYABLE_FAILURE,
                        PortableResolutionReason.SOURCE_NOT_LOADED,
                    )
                    else -> PortableResolution(PortableResolutionState.READY)
                }
            },
        )
    }

    override suspend fun resolveWork(ref: PortableWorkRef): WorkResolution {
        val novel = ref as? PortableWorkRef.Novel
            ?: return WorkResolution(ref, conflict())
        registry.prepare()
        if (!registry.isPluginInstalled(novel.pluginId)) {
            return WorkResolution(
                ref,
                PortableResolution(
                    PortableResolutionState.PENDING_DEPENDENCY,
                    PortableResolutionReason.PLUGIN_NOT_FOUND,
                ),
            )
        }
        val sourceId = registry.sourceId(novel.pluginId)
            ?: return WorkResolution(
                ref,
                PortableResolution(
                    PortableResolutionState.RETRYABLE_FAILURE,
                    PortableResolutionReason.SOURCE_NOT_LOADED,
                ),
            )
        val localId = local.novelWork(sourceId, novel.novelKey.value)
        return if (localId != null) {
            WorkResolution(ref, PortableResolution(PortableResolutionState.BOUND), localId)
        } else {
            materializer?.materialize(ref) ?: unsupported(ref)
        }
    }

    override suspend fun resolveChapter(ref: PortableChapterRef): ChapterResolution =
        resolveChapters(listOf(ref)).single()

    override suspend fun resolveChapters(refs: List<PortableChapterRef>): List<ChapterResolution> {
        if (refs.isEmpty()) return emptyList()
        registry.prepare()
        val resolved = LinkedHashMap<PortableChapterRef, ChapterResolution>(refs.size)
        val missing = ArrayList<PortableChapterRef>(refs.size)
        for (ref in refs) {
            val novel = ref as? PortableChapterRef.Novel
            if (novel == null) {
                resolved[ref] = ChapterResolution(ref, conflict())
                continue
            }
            if (!registry.isPluginInstalled(novel.work.pluginId)) {
                resolved[ref] = ChapterResolution(
                    ref,
                    PortableResolution(
                        PortableResolutionState.PENDING_DEPENDENCY,
                        PortableResolutionReason.PLUGIN_NOT_FOUND,
                    ),
                )
                continue
            }
            val sourceId = registry.sourceId(novel.work.pluginId)
            if (sourceId == null) {
                resolved[ref] = ChapterResolution(
                    ref,
                    PortableResolution(
                        PortableResolutionState.RETRYABLE_FAILURE,
                        PortableResolutionReason.SOURCE_NOT_LOADED,
                    ),
                )
                continue
            }
            val localId = local.novelChapter(
                sourceId,
                novel.work.novelKey.value,
                novel.chapterKey.value,
            )
            if (localId != null) {
                resolved[ref] = ChapterResolution(ref, PortableResolution(PortableResolutionState.BOUND), localId)
            } else {
                missing += ref
            }
        }
        val materialized = chapterMaterializer?.materializeAll(missing)
            ?: missing.map(::unsupported)
        materialized.forEach { resolved[it.ref] = it }
        return refs.map { ref -> resolved[ref] ?: ChapterResolution(ref, conflict()) }
    }
}

private fun conflict() = PortableResolution(PortableResolutionState.CONFLICT)

private fun unsupported(ref: PortableWorkRef) = WorkResolution(
    ref,
    PortableResolution(
        PortableResolutionState.PENDING_PROVIDER,
        PortableResolutionReason.WORK_RESOLUTION_UNSUPPORTED,
    ),
)

private fun unsupported(ref: PortableChapterRef) = ChapterResolution(
    ref,
    PortableResolution(
        PortableResolutionState.PENDING_PROVIDER,
        PortableResolutionReason.CHAPTER_RESOLUTION_FAILED,
    ),
)
