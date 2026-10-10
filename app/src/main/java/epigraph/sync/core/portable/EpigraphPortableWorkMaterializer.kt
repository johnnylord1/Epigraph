package epigraph.sync.core.portable

import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.WorkResolution
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import eu.kanade.tachiyomi.data.database.models.create
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import epigraph.novel.source.NovelSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import yokai.data.DatabaseHandler
import yokai.domain.manga.MangaRepository
import yokai.domain.manga.models.MangaUpdate

/**
 * Binds a desktop work to the extension installed on this device.
 *
 * Like a Mihon or LNReader backup restore, it only writes rows and never calls the extension: a
 * work missing on the device is created from the key and title the desktop knows, not initialized,
 * so opening it fetches its details and chapters from the extension.
 */
class EpigraphPortableWorkMaterializer(
    private val sources: SourceManager,
    private val mangas: MangaRepository,
    private val database: DatabaseHandler,
) : PortableWorkMaterializer {
    private val comicMaterializationMutex = Mutex()
    private val novelMaterializationMutex = Mutex()

    override suspend fun materialize(ref: PortableWorkRef): WorkResolution = when (ref) {
        is PortableWorkRef.Comic -> comicMaterializationMutex.withLock { materializeUnlocked(ref) }
        is PortableWorkRef.Novel -> novelMaterializationMutex.withLock { materializeUnlocked(ref) }
    }

    private suspend fun materializeUnlocked(ref: PortableWorkRef): WorkResolution {
        val sourceId = when (ref) {
            is PortableWorkRef.Comic -> ref.sourceId.toLong()
            is PortableWorkRef.Novel -> sources.getCatalogueSources()
                .filterIsInstance<NovelSource>()
                .firstOrNull { it.pluginId == ref.pluginId }
                ?.id
                ?: return failure(
                    ref,
                    PortableResolutionState.PENDING_DEPENDENCY,
                    PortableResolutionReason.PLUGIN_NOT_FOUND,
                )
        }
        val source = sources.get(sourceId) as? CatalogueSource
            ?: return failure(
                ref,
                PortableResolutionState.RETRYABLE_FAILURE,
                PortableResolutionReason.SOURCE_NOT_LOADED,
            )
        if ((ref is PortableWorkRef.Novel) != (source is NovelSource)) {
            return WorkResolution(ref, PortableResolution(PortableResolutionState.CONFLICT))
        }
        val providerKey = when (ref) {
            is PortableWorkRef.Comic -> ref.mangaKey.value
            is PortableWorkRef.Novel -> ref.novelKey.value
        }
        return try {
            val priorComicBinding = (ref as? PortableWorkRef.Comic)?.let { comic ->
                database.awaitOneOrNull {
                    aethon_syncQueries.selectPortableWorkBindingByComicRef(
                        sourceId = comic.sourceId.value,
                        providerKey = comic.mangaKey.value,
                    )
                }
            }
            val priorNovelBinding = (ref as? PortableWorkRef.Novel)?.let { novel ->
                database.awaitOneOrNull {
                    aethon_syncQueries.selectPortableWorkBindingByNovelRef(
                        pluginId = novel.pluginId,
                        providerKey = novel.novelKey.value,
                    )
                }
            }
            val priorComicId = priorComicBinding?.local_reference?.toLongOrNull()?.takeIf { it > 0 }
            val priorNovelId = priorNovelBinding?.local_reference?.toLongOrNull()?.takeIf { it > 0 }
            // A placeholder re-keyed to the plugin source id can share url/source with the row
            // hydration created; keep the bound row so the binding cannot flip between twins.
            val exactNative = priorNovelId
                ?.let { mangas.getMangaById(it) }
                ?.takeIf { it.url == providerKey && it.source == sourceId }
                ?: mangas.getMangaByUrlAndSource(providerKey, sourceId)
            if (exactNative != null) {
                if (ref is PortableWorkRef.Novel) {
                    reconcileNovelBinding(
                        ref = ref,
                        exactNative = exactNative,
                        priorLocalId = priorNovelId,
                        titleHint = priorNovelBinding?.title_hint,
                    )
                }
                return bound(ref, exactNative.id)
            }

            if (ref is PortableWorkRef.Comic) {
                // The portable binding is the canonical owner of the local row. Old pairings can
                // leave several non-favorite EpigraphCoreSource placeholders with the same immutable
                // source/key binding; counting all of them as candidates turns a deterministic
                // relink into a permanent conflict. Prefer the exact row already recorded by this
                // portable identity, but only while it is still a Core bridge placeholder.
                val boundCoreCandidate = priorComicId
                    ?.let { localId -> mangas.getMangaById(localId) }
                    ?.takeIf { manga -> manga.source == EpigraphCoreSource.ID }
                    ?.id
                if (boundCoreCandidate != null) {
                    return relinkCoreCandidate(ref, boundCoreCandidate, sourceId, providerKey)
                }
                val coreCandidates = database.awaitList {
                    aethon_syncQueries.selectAethonCoreMangaBySourceBinding(
                        sourceId = sourceId.toString(),
                        providerKey = providerKey,
                        coreSourceId = EpigraphCoreSource.ID,
                    )
                }
                when (coreCandidates.size) {
                    0 -> Unit
                    1 -> return relinkCoreCandidate(ref, coreCandidates.single(), sourceId, providerKey)
                    else -> {
                        // Existing ambiguity is safer than adding another local favorite. The
                        // user-facing resolver can surface this as a conflict for review.
                        return WorkResolution(
                            ref,
                            PortableResolution(PortableResolutionState.CONFLICT),
                        )
                    }
                }
            }

            // Like a backup restore, the row is written from what the desktop knows, without
            // calling the extension: it fetches the details when the work is opened.
            val resolvedTitle = (priorComicBinding?.title_hint ?: priorNovelBinding?.title_hint)
                ?.takeIf { it.isNotBlank() }
                ?: providerKey.substringAfterLast('/').ifBlank { providerKey }
            if (ref is PortableWorkRef.Novel && priorNovelId != null && mangas.getMangaById(priorNovelId) != null) {
                val updated = mangas.update(
                    MangaUpdate(
                        id = priorNovelId,
                        url = providerKey,
                        title = resolvedTitle,
                        initialized = false,
                        source = sourceId,
                    ),
                )
                if (!updated) {
                    return failure(
                        ref,
                        PortableResolutionState.RETRYABLE_FAILURE,
                        PortableResolutionReason.WORK_RESOLUTION_FAILED,
                    )
                }
                val local = mangas.getMangaById(priorNovelId)
                    ?: return failure(
                        ref,
                        PortableResolutionState.RETRYABLE_FAILURE,
                        PortableResolutionReason.WORK_RESOLUTION_FAILED,
                    )
                return bound(ref, local.id)
            }
            val entity = Manga.create(providerKey, resolvedTitle, sourceId).apply {
                initialized = false
            }
            mangas.insert(entity)
            val local = mangas.getMangaByUrlAndSource(providerKey, sourceId)
                ?: return failure(
                    ref,
                    PortableResolutionState.RETRYABLE_FAILURE,
                    PortableResolutionReason.WORK_RESOLUTION_FAILED,
                )
            if (local.source != sourceId || local.url != providerKey) {
                return WorkResolution(ref, PortableResolution(PortableResolutionState.CONFLICT))
            }
            bound(ref, local.id)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            failure(
                ref,
                PortableResolutionState.RETRYABLE_FAILURE,
                PortableResolutionReason.WORK_RESOLUTION_FAILED,
            )
        }
    }

    private suspend fun relinkCoreCandidate(
        ref: PortableWorkRef.Comic,
        localId: Long,
        sourceId: Long,
        providerKey: String,
    ): WorkResolution {
        if (!mangas.update(MangaUpdate(id = localId, url = providerKey, source = sourceId))) {
            return failure(
                ref,
                PortableResolutionState.RETRYABLE_FAILURE,
                PortableResolutionReason.WORK_RESOLUTION_FAILED,
            )
        }
        val relinked = mangas.getMangaById(localId)
            ?.takeIf { it.source == sourceId && it.url == providerKey }
        return bound(ref, relinked?.id)
    }

    /**
     * A desktop snapshot can create a placeholder before the matching LNReader plugin is loaded.
     * Plugin upgrades may also change Epigraph's numeric source id. When hydration later finds the
     * provider-native row, make it the single visible owner and preserve the placeholder's title,
     * categories, and Epigraph identity instead of leaving an empty duplicate in the library.
     */
    private suspend fun reconcileNovelBinding(
        ref: PortableWorkRef.Novel,
        exactNative: Manga,
        priorLocalId: Long?,
        titleHint: String?,
    ) {
        val exactId = exactNative.id ?: return
        val prior = priorLocalId
            ?.takeIf { it != exactId }
            ?.let { mangas.getMangaById(it) }
        val repairedTitle = exactNative.title.takeIf { it.isNotBlank() }
            ?: prior?.title?.takeIf { it.isNotBlank() }
            ?: titleHint?.takeIf { it.isNotBlank() }
        if (repairedTitle != null && repairedTitle != exactNative.title) {
            mangas.update(MangaUpdate(id = exactId, title = repairedTitle))
        }

        database.await(inTransaction = true) {
            if (prior != null) {
                val existingCategories = categoriesQueries.findAllByMangaId(exactId)
                    .executeAsList()
                    .mapTo(HashSet()) { it._id }
                categoriesQueries.findAllByMangaId(requireNotNull(prior.id)).executeAsList().forEach { category ->
                    if (category._id !in existingCategories) {
                        mangas_categoriesQueries.insert(exactId, category._id)
                    }
                }
                // This is replica reconciliation, not a user library mutation. Write directly so
                // hiding the obsolete placeholder cannot echo a delete back into the Core.
                mangasQueries.update(
                    source = null,
                    url = null,
                    artist = null,
                    author = null,
                    description = null,
                    genre = null,
                    title = null,
                    status = null,
                    thumbnailUrl = null,
                    favorite = false,
                    lastUpdate = null,
                    initialized = null,
                    viewer = null,
                    hideTitle = null,
                    chapterFlags = null,
                    dateAdded = null,
                    filteredScanlators = null,
                    updateStrategy = null,
                    coverLastModified = null,
                    nextUpdate = null,
                    fetchInterval = null,
                    memo = null,
                    mangaId = requireNotNull(prior.id),
                )
            }
            val now = System.currentTimeMillis()
            aethon_syncQueries.upsertIdentity(
                entityId = PortableIdentityV3.workId(ref),
                contentType = "NOVEL",
                localReference = exactId.toString(),
                createdAt = now,
                updatedAt = now,
            )
        }
    }

    private fun bound(ref: PortableWorkRef, localId: Long?): WorkResolution =
        WorkResolution(
            ref,
            PortableResolution(PortableResolutionState.BOUND),
            localId?.toString(),
        ).takeIf { it.localId != null }
            ?: failure(
                ref,
                PortableResolutionState.RETRYABLE_FAILURE,
                PortableResolutionReason.WORK_RESOLUTION_FAILED,
            )

    private fun failure(
        ref: PortableWorkRef,
        state: PortableResolutionState,
        reason: PortableResolutionReason,
    ) = WorkResolution(ref, PortableResolution(state, reason))
}
