package epigraph.sync.core.novels

import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationOrigin
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.LibraryMembershipMutation
import co.touchlab.kermit.Logger
import epigraph.novel.plugin.NovelPluginManager
import kotlinx.coroutines.CancellationException
import yokai.data.Database
import yokai.data.DatabaseHandler

/**
 * Repairs LNReader favorites created before their first paired Core publication.
 *
 * Older builds only routed favorites that had already arrived from Core, leaving a locally added
 * novel with no identity and no outbox row. This pass is deliberately idempotent: it considers
 * only favorite rows without a NOVEL identity, and the router provisions identity, portable
 * binding, library snapshot and category assignments atomically.
 */
class LocalNovelLibraryOutboxRepair(
    private val database: DatabaseHandler,
    private val plugins: NovelPluginManager,
    private val router: EpigraphLibraryMutationRouter,
    private val scopes: EpigraphSyncScopeProvider,
) {
    suspend fun repair(): Int {
        // Before pairing there is nowhere safe to address an outbox mutation. Keep the library row
        // local and retry on the next app-start/connectivity worker after pairing.
        runCatching { scopes.current() }.getOrElse { return 0 }
        plugins.ensureInstalledPluginsLoaded()
        val novelSources = plugins.installedSourcesFlow.value.associateBy { it.id }
        if (novelSources.isEmpty()) return 0
        repairSplitBindings(novelSources.mapValues { it.value.pluginId }.entries.associate { it.value to it.key })

        val candidates = database.await {
            mangasQueries.findFavorites().executeAsList().mapNotNull { manga ->
                if (novelSources[manga.source] == null) return@mapNotNull null
                val alreadyIdentified = aethon_syncQueries
                    .selectIdentityByLocalReference("NOVEL", manga._id.toString())
                    .executeAsOneOrNull() != null
                if (alreadyIdentified) return@mapNotNull null
                val categoryIds = categoriesQueries.findAllByMangaId(manga._id)
                    .executeAsList()
                    .mapTo(linkedSetOf()) { it._id }
                Candidate(manga._id, manga.source, manga.url, categoryIds)
            }
        }

        var emitted = 0
        candidates.forEach { candidate ->
            val source = novelSources[candidate.sourceId] ?: return@forEach
            try {
                val result = router.setMembership(
                    mutation = LibraryMembershipMutation(
                        localMangaId = candidate.mangaId,
                        inLibrary = true,
                        categoryIds = candidate.categoryIds,
                        origin = EpigraphMutationOrigin.LOCAL_USER,
                        portableWorkRef = PortableWorkRef.Novel(
                            pluginId = source.pluginId,
                            novelKey = ProviderOwnedKey(candidate.providerKey),
                        ),
                    ),
                    createdAtEpochMillis = System.currentTimeMillis(),
                )
                emitted += result.emittedCommandCount
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                Logger.w(failure) {
                    "Unable to repair local novel library binding for manga=${candidate.mangaId}"
                }
            }
        }
        return emitted
    }

    /**
     * Reconciles placeholders projected before an LNReader dependency was available with the
     * provider-native row created during hydration. This is intentionally a local replica repair:
     * it must not enqueue a user-authored library removal for the obsolete placeholder.
     */
    private suspend fun repairSplitBindings(sourceIdByPlugin: Map<String, Long>) {
        val repaired = database.await(inTransaction = true) {
            var repairedCount = 0
            aethon_syncQueries.selectBoundNovelWorkBindings().executeAsList().forEach { binding ->
                val pluginId = binding.plugin_id ?: return@forEach
                val expectedSourceId = sourceIdByPlugin[pluginId] ?: return@forEach
                val hydratedId = binding.local_reference.toLongOrNull()?.takeIf { it > 0 } ?: return@forEach
                val hydrated = mangasQueries.findById(hydratedId).executeAsOneOrNull()
                    ?.takeIf { it.source == expectedSourceId }
                    ?: return@forEach
                val identity = aethon_syncQueries.selectIdentityByEntityId(binding.portable_id)
                    .executeAsOneOrNull()
                    ?: return@forEach
                val placeholderId = identity.local_reference.toLongOrNull()?.takeIf { it > 0 }
                if (placeholderId == hydratedId) return@forEach
                val placeholder = placeholderId?.let {
                    mangasQueries.findById(it).executeAsOneOrNull()
                }
                val repairedTitle = hydrated.title.takeIf { it.isNotBlank() }
                    ?: placeholder?.title?.takeIf { it.isNotBlank() }
                    ?: binding.title_hint?.takeIf { it.isNotBlank() }

                if (placeholder != null) {
                    val assigned = categoriesQueries.findAllByMangaId(hydratedId)
                        .executeAsList()
                        .mapTo(HashSet()) { it._id }
                    categoriesQueries.findAllByMangaId(placeholder._id).executeAsList().forEach { category ->
                        if (category._id !in assigned) {
                            mangas_categoriesQueries.insert(hydratedId, category._id)
                        }
                    }
                    updateMangaReplicaFields(
                        mangaId = placeholder._id,
                        title = null,
                        favorite = false,
                    )
                }
                updateMangaReplicaFields(
                    mangaId = hydratedId,
                    title = repairedTitle?.takeIf { it != hydrated.title },
                    favorite = true,
                )
                aethon_syncQueries.upsertIdentity(
                    entityId = binding.portable_id,
                    contentType = "NOVEL",
                    localReference = hydratedId.toString(),
                    createdAt = identity.created_at,
                    updatedAt = System.currentTimeMillis(),
                )
                repairedCount++
            }
            aethon_syncQueries.selectBoundNovelWorkBindings().executeAsList().forEach { binding ->
                val ownerId = aethon_syncQueries.selectIdentityByEntityId(binding.portable_id)
                    .executeAsOneOrNull()
                    ?.local_reference
                    ?.toLongOrNull()
                    ?: return@forEach
                val owner = mangasQueries.findById(ownerId).executeAsOneOrNull() ?: return@forEach
                // A placeholder re-keyed to the plugin source id shares url/source with the
                // hydrated row; only the identity owner may stay visible in the library.
                mangasQueries.findByUrlAndSource(owner.url, owner.source).executeAsList()
                    .filter { twin ->
                        twin._id != ownerId && twin.favorite &&
                            aethon_syncQueries.selectIdentityByLocalReference("NOVEL", twin._id.toString())
                                .executeAsOneOrNull() == null
                    }
                    .forEach { twin ->
                        val assigned = categoriesQueries.findAllByMangaId(ownerId)
                            .executeAsList()
                            .mapTo(HashSet()) { it._id }
                        categoriesQueries.findAllByMangaId(twin._id).executeAsList().forEach { category ->
                            if (category._id !in assigned) mangas_categoriesQueries.insert(ownerId, category._id)
                        }
                        updateMangaReplicaFields(mangaId = twin._id, title = null, favorite = false)
                        repairedCount++
                    }
            }
            repairedCount
        }
        if (repaired > 0) {
            Logger.i { "Reconciled $repaired hydrated LNReader library binding(s)" }
        }
    }

    private fun Database.updateMangaReplicaFields(
        mangaId: Long,
        title: String?,
        favorite: Boolean,
    ) {
        mangasQueries.update(
            source = null,
            url = null,
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = title,
            status = null,
            thumbnailUrl = null,
            favorite = favorite,
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
            mangaId = mangaId,
        )
    }

    private data class Candidate(
        val mangaId: Long,
        val sourceId: Long,
        val providerKey: String,
        val categoryIds: Set<Long>,
    )
}
