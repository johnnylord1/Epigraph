package epigraph.sync.core.portable

import android.util.Log
import epigraph.novel.source.NovelSource
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import eu.kanade.tachiyomi.data.database.models.Chapter
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.chapter.syncChaptersWithSource
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import yokai.domain.chapter.ChapterRepository
import yokai.domain.manga.MangaRepository
import yokai.domain.manga.models.MangaUpdate

/**
 * A portable binding relinks a synced work to the extension installed on this device, but the row
 * keeps the desktop catalog's cover and lacks the extension's own details (description, genres,
 * status) until a manual library update. Refresh those from the installed source so the library is
 * complete on its own instead of depending on the paired desktop.
 *
 * Runs detached from the sync pass so pairing never waits on hundreds of provider requests; a row
 * still carrying the desktop cover is retried on the next pass.
 */
class PortableWorkDetailsRefresher(
    private val sources: SourceManager,
    private val mangas: MangaRepository,
    private val chapters: ChapterRepository,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)

    fun launch() {
        if (!running.compareAndSet(false, true)) return
        scope.launch {
            try {
                refresh()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Log.w(LOG_TAG, "portable details refresh failed: ${error::class.simpleName}")
            } finally {
                running.set(false)
            }
        }
    }

    suspend fun refresh(): Int {
        val favorites = mangas.getFavorites()
        val pending = favorites.mapNotNull { manga ->
            val source = manga.takeIf { it.thumbnail_url.isDesktopCover() }
                ?.let { nativeSource(it.source) }
                ?: return@mapNotNull null
            source to suspend { refresh(manga, source) }
        } + favorites.mapNotNull { manga ->
            val source = sources.get(manga.source) as? NovelSource ?: return@mapNotNull null
            source to suspend { refreshNovelChapters(manga, source) }
        }
        if (pending.isEmpty()) return 0
        val permits = Semaphore(MAX_PARALLEL_SOURCES)
        return coroutineScope {
            pending.groupBy { (source, _) -> source.id }.values.map { works ->
                async { permits.withPermit { works.count { (_, refresh) -> refresh() } } }
            }.awaitAll().sum()
        }
    }

    /**
     * The desktop only publishes the novel chapters already read, all at source order 0, so a
     * synced novel shows a partial, unordered list. Fetch the full list from the installed plugin;
     * matching chapters keep their read state.
     */
    private suspend fun refreshNovelChapters(manga: Manga, source: NovelSource): Boolean = try {
        val mangaId = manga.id ?: return false
        if (!chapters.getChapters(mangaId, false).needSourceFetch()) return false
        syncChaptersWithSource(source.getChapterList(manga.copy()), manga, source)
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        false
    }

    private fun nativeSource(sourceId: Long): CatalogueSource? =
        (sources.get(sourceId) as? CatalogueSource)
            ?.takeIf { it.id != EpigraphCoreSource.ID && it !is NovelSource }

    private suspend fun refresh(manga: Manga, source: CatalogueSource): Boolean = try {
        val mangaId = manga.id ?: return false
        manga.copyFrom(source.getMangaDetails(manga.copy()))
        // Only the provider's fields: the snapshot is from before the network call, so writing the
        // whole row could undo a reading mode or favorite changed meanwhile.
        mangas.update(
            MangaUpdate(
                id = mangaId,
                artist = manga.artist,
                author = manga.author,
                description = manga.description,
                genres = manga.getGenres(),
                status = manga.status,
                thumbnailUrl = manga.thumbnail_url,
                initialized = true,
            ),
        )
        // Works the desktop never fetched chapters for arrive empty; a manual update fixed those too.
        if (chapters.getChapters(mangaId, false).isEmpty()) {
            syncChaptersWithSource(source.getChapterList(manga.copy()), manga, source)
        }
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        false
    }

    private fun String?.isDesktopCover(): Boolean =
        this?.let(SuwayomiCoreThumbnailReference::parse) != null

    companion object {
        /** Empty, or only chapters projected from the desktop: a source fetch numbers them 0..n-1. */
        fun List<Chapter>.needSourceFetch(): Boolean = isEmpty() || all { it.source_order == 0 }

        private const val MAX_PARALLEL_SOURCES = 3
        private const val LOG_TAG = "EpigraphCoreSync"
    }
}
