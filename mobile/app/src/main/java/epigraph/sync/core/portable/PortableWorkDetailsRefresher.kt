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
import java.util.concurrent.ConcurrentHashMap
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
 * still carrying the desktop cover is retried on the next pass. Works with no chapters are fetched
 * here too (hydration leaves their chapters pending), then [onRefreshed] wakes the sync to bind them.
 */
class PortableWorkDetailsRefresher(
    private val sources: SourceManager,
    private val mangas: MangaRepository,
    private val chapters: ChapterRepository,
    private val onRefreshed: () -> Unit = {},
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val running = AtomicBoolean(false)
    private val requested = AtomicBoolean(false)
    // Works whose chapter list is present or was fetched once: skips re-reading every favorite's
    // chapters each pass, and a provider listing nothing can't wake the sync forever.
    private val chaptersChecked: MutableSet<Long> = ConcurrentHashMap.newKeySet()

    fun launch() {
        requested.set(true)
        if (!running.compareAndSet(false, true)) return
        scope.launch {
            try {
                // A launch during a pass runs one more: that pass listed the works before an
                // extension installed meanwhile existed, so its works waited for the next sync.
                while (requested.getAndSet(false)) {
                    if (refresh() > 0) onRefreshed()
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Log.w(LOG_TAG, "portable details refresh failed: ${error::class.simpleName}")
            } finally {
                running.set(false)
                if (requested.get()) launch()
            }
        }
    }

    suspend fun refresh(): Int {
        val favorites = mangas.getFavorites()
        // Novels first: one chapter list each, while the comic pass can take minutes.
        val pending = favorites.mapNotNull { manga ->
            val source = sources.get(manga.source) as? NovelSource ?: return@mapNotNull null
            source to suspend { refreshNovelChapters(manga, source) }
        } + favorites.mapNotNull { manga ->
            val source = nativeSource(manga.source) ?: return@mapNotNull null
            val details = manga.thumbnail_url.isDesktopCover()
            if (!details && !manga.lacksChapters()) return@mapNotNull null
            source to suspend { refresh(manga, source, details) }
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
        if (mangaId in chaptersChecked) return false
        if (!chapters.getChapters(mangaId, false).needSourceFetch()) {
            chaptersChecked += mangaId
            return false
        }
        syncChaptersWithSource(source.getChapterList(manga.copy()), manga, source)
        chaptersChecked += mangaId
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        false
    }

    private fun nativeSource(sourceId: Long): CatalogueSource? =
        (sources.get(sourceId) as? CatalogueSource)
            ?.takeIf { it.id != EpigraphCoreSource.ID && it !is NovelSource }

    private suspend fun Manga.lacksChapters(): Boolean {
        val mangaId = id ?: return false
        if (mangaId in chaptersChecked) return false
        return chapters.getChapters(mangaId, false).isEmpty().also { empty ->
            if (!empty) chaptersChecked += mangaId
        }
    }

    private suspend fun refresh(manga: Manga, source: CatalogueSource, details: Boolean): Boolean = try {
        val mangaId = manga.id ?: return false
        if (details) refreshDetails(mangaId, manga, source)
        // Works the desktop never fetched chapters for, or a backup restored without them, arrive
        // empty; a manual update fixed those too.
        if (chapters.getChapters(mangaId, false).isEmpty()) {
            syncChaptersWithSource(source.getChapterList(manga.copy()), manga, source)
        }
        chaptersChecked += mangaId
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Throwable) {
        false
    }

    private suspend fun refreshDetails(mangaId: Long, manga: Manga, source: CatalogueSource) {
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
