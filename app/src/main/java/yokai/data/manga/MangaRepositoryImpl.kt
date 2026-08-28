package yokai.data.manga

import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationOrigin
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.LibraryMembershipMutation
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.data.database.models.LibraryManga
import eu.kanade.tachiyomi.data.database.models.MangaCategory
import eu.kanade.tachiyomi.data.database.models.mapper
import eu.kanade.tachiyomi.domain.manga.models.Manga
import kotlinx.coroutines.flow.Flow
import eu.kanade.tachiyomi.source.SourceManager
import hayai.novel.source.NovelSource
import yokai.data.DatabaseHandler
import yokai.data.memoColumnAdapter
import yokai.data.updateStrategyAdapter
import yokai.domain.manga.MangaRepository
import yokai.domain.manga.models.MangaUpdate

class MangaRepositoryImpl(
    private val handler: DatabaseHandler,
    private val epigraphLibraryRouter: EpigraphLibraryMutationRouter? = null,
    private val sourceManager: SourceManager? = null,
    private val syncScopeProvider: EpigraphSyncScopeProvider? = null,
) : MangaRepository {
    override suspend fun getMangaList(): List<Manga> =
        handler.awaitList { mangasQueries.findAll(Manga::mapper) }

    override suspend fun getMangaByUrlAndSource(url: String, source: Long): Manga? =
        handler.awaitFirstOrNull { mangasQueries.findByUrlAndSource(url, source, Manga::mapper) }

    override suspend fun getMangaById(id: Long): Manga? =
        handler.awaitOneOrNull { mangasQueries.findById(id, Manga::mapper) }

    override suspend fun getFavorites(): List<Manga> =
        handler.awaitList { mangasQueries.findFavorites(Manga::mapper) }

    override fun getUpcoming(statuses: Set<Long>, now: Long): Flow<List<Manga>> =
        handler.subscribeToList { mangasQueries.findUpcoming(now, statuses, Manga::mapper) }

    override suspend fun getReadNotFavorites(): List<Manga> =
        handler.awaitList { mangasQueries.findReadNotFavorites(Manga::mapper) }

    override fun getMangaListAsFlow(): Flow<List<Manga>> =
        handler.subscribeToList { mangasQueries.findAll(Manga::mapper) }

    override fun getMangaByUrlAndSourceAsFlow(url: String, source: Long): Flow<Manga?> =
        handler.subscribeToFirstOrNull { mangasQueries.findByUrlAndSource(url, source, Manga::mapper) }

    override suspend fun getLibraryManga(): List<LibraryManga> =
        handler.awaitList { library_viewQueries.findAll(LibraryManga::mapper) }

    override fun getLibraryMangaAsFlow(): Flow<List<LibraryManga>> =
        handler.subscribeToList { library_viewQueries.findAll(LibraryManga::mapper) }

    override suspend fun getDuplicateFavorite(title: String, source: Long): Manga? =
        handler.awaitFirstOrNull { mangasQueries.findDuplicateFavorite(title.lowercase(), source, Manga::mapper) }

    override suspend fun update(update: MangaUpdate): Boolean {
        return try {
            val routed = routeFavoriteChange(update)
            partialUpdate(if (routed) update.copy(favorite = null) else update)
            true
        } catch (e: Exception) {
            Logger.e { "Failed to update manga with id '${update.id}'" }
            false
        }
    }

    override suspend fun updateAll(updates: List<MangaUpdate>): Boolean {
        return try {
            val routedUpdates = updates.map { update ->
                if (routeFavoriteChange(update)) update.copy(favorite = null) else update
            }
            partialUpdate(*routedUpdates.toTypedArray())
            true
        } catch (e: Exception) {
            Logger.e(e) { "Failed to bulk update manga" }
            false
        }
    }

    private suspend fun partialUpdate(vararg updates: MangaUpdate) {
        handler.await(inTransaction = true) {
            updates.forEach { update ->
                mangasQueries.update(
                    source = update.source,
                    url = update.url,
                    artist = update.artist,
                    author = update.author,
                    description = update.description,
                    genre = update.genres?.joinToString(),
                    title = update.title,
                    status = update.status?.toLong(),
                    thumbnailUrl = update.thumbnailUrl,
                    favorite = update.favorite,
                    lastUpdate = update.lastUpdate,
                    initialized = update.initialized,
                    viewer = update.viewerFlags?.toLong(),
                    hideTitle = update.hideTitle,
                    chapterFlags = update.chapterFlags?.toLong(),
                    dateAdded = update.dateAdded,
                    filteredScanlators = update.filteredScanlators,
                    updateStrategy = update.updateStrategy?.let(updateStrategyAdapter::encode),
                    coverLastModified = update.coverLastModified,
                    nextUpdate = update.nextUpdate,
                    fetchInterval = update.fetchInterval?.toLong(),
                    memo = update.memo?.let(memoColumnAdapter::encode),
                    mangaId = update.id,
                )
            }
        }
    }

    /**
     * Routes a favorite toggle for a row that already has an Epigraph identity. The router owns the
     * local favorite/category write and records the outbox mutation in the same SQL transaction.
     * Rows without an identity still use Epigraph's original local-only behavior until bootstrap has
     * materialized their binding.
     */
    private suspend fun routeFavoriteChange(update: MangaUpdate): Boolean {
        val favorite = update.favorite ?: return false
        val router = epigraphLibraryRouter ?: return false
        // Favorite changes remain local before pairing. Once credentials exist, the normal
        // worker repair pass publishes any LNReader favorites that still lack an identity.
        val scopes = syncScopeProvider ?: return false
        if (runCatching { scopes.current() }.isFailure) return false
        val portableWorkRef = if (hasEpigraphIdentity(update.id)) null else portableNovelRef(update.id)
        if (portableWorkRef == null && !hasEpigraphIdentity(update.id)) return false
        val categoryIds = handler.await {
            categoriesQueries.findAllByMangaId(update.id).executeAsList().map { it._id }.toSet()
        }
        router.setMembership(
            mutation = LibraryMembershipMutation(
                localMangaId = update.id,
                inLibrary = favorite,
                categoryIds = categoryIds,
                origin = EpigraphMutationOrigin.LOCAL_USER,
                portableWorkRef = portableWorkRef,
            ),
            createdAtEpochMillis = System.currentTimeMillis(),
        )
        return true
    }

    private suspend fun hasEpigraphIdentity(mangaId: Long): Boolean = handler.await {
        sequenceOf("NOVEL", "MANGA")
            .any { contentType ->
                aethon_syncQueries
                    .selectIdentityByLocalReference(contentType, mangaId.toString())
                    .executeAsOneOrNull() != null
            }
    }

    /** Returns the exact LNReader-owned identity for a row created locally by a novel plugin. */
    private suspend fun portableNovelRef(mangaId: Long): PortableWorkRef.Novel? {
        val manager = sourceManager ?: return null
        val manga = handler.await { mangasQueries.findById(mangaId).executeAsOneOrNull() } ?: return null
        val source = manager.get(manga.source) as? NovelSource ?: return null
        return runCatching {
            PortableWorkRef.Novel(
                pluginId = source.pluginId,
                novelKey = ProviderOwnedKey(manga.url),
            )
        }.getOrNull()
    }

    private suspend fun currentFavorite(mangaId: Long): Boolean? = handler.await {
        mangasQueries.findById(mangaId).executeAsOneOrNull()?.favorite
    }

    private suspend fun routeCategoryChange(mangaId: Long, categoryIds: Set<Long>): Boolean {
        val router = epigraphLibraryRouter ?: return false
        if (!hasEpigraphIdentity(mangaId)) return false
        val favorite = currentFavorite(mangaId) ?: return false
        router.setMembership(
            mutation = LibraryMembershipMutation(
                localMangaId = mangaId,
                inLibrary = favorite,
                categoryIds = categoryIds,
                origin = EpigraphMutationOrigin.LOCAL_USER,
            ),
            createdAtEpochMillis = System.currentTimeMillis(),
        )
        return true
    }

    override suspend fun insert(manga: Manga) =
        handler.awaitOneOrNullExecutable(inTransaction = true) {
            mangasQueries.insert(
                source = manga.source,
                url = manga.url,
                artist = manga.artist,
                author = manga.author,
                description = manga.description,
                genre = manga.genre,
                title = manga.title,
                status = manga.status.toLong(),
                thumbnailUrl = manga.thumbnail_url,
                favorite = manga.favorite,
                lastUpdate = manga.last_update,
                initialized = manga.initialized,
                viewer = manga.viewer_flags.toLong(),
                hideTitle = manga.hide_title,
                chapterFlags = manga.chapter_flags.toLong(),
                dateAdded = manga.date_added,
                filteredScanlators = manga.filtered_scanlators,
                updateStrategy = manga.update_strategy.let(updateStrategyAdapter::encode),
                coverLastModified = manga.cover_last_modified,
                nextUpdate = manga.next_update,
                fetchInterval = manga.fetch_interval.toLong(),
                memo = manga.memo,
            )
            mangasQueries.selectLastInsertedRowId()
        }

    override suspend fun setCategories(mangaId: Long, categoryIds: List<Long>) {
        if (routeCategoryChange(mangaId, categoryIds.toSet())) return
        handler.await(inTransaction = true) {
            mangas_categoriesQueries.delete(mangaId)
            categoryIds.forEach { id ->
                mangas_categoriesQueries.insert(mangaId, id)
            }
        }
    }

    override suspend fun setMultipleMangaCategories(mangaIds: List<Long>, mangaCategories: List<MangaCategory>) {
        val categoriesByManga = mangaCategories
            .groupBy { it.manga_id }
            .mapValues { (_, rows) -> rows.map { it.category_id.toLong() }.toSet() }
        val routedMangaIds = mangaIds.filter { mangaId ->
            routeCategoryChange(mangaId, categoriesByManga[mangaId].orEmpty())
        }.toSet()
        val localOnlyMangaIds = mangaIds.filterNot(routedMangaIds::contains)
        if (localOnlyMangaIds.isEmpty()) return
        handler.await(inTransaction = true) {
            mangas_categoriesQueries.deleteBulk(localOnlyMangaIds)
            mangaCategories
                .filter { it.manga_id in localOnlyMangaIds }
                .forEach {
                    mangas_categoriesQueries.insert(it.manga_id, it.category_id.toLong())
                }
        }
    }
}
