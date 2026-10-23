package epigraph.sync.core.portable

import android.content.Context
import epigraph.contract.ChapterResolution
import epigraph.contract.PortableChapterRef
import epigraph.sync.core.suwayomi.CoreBridgedChapterReadState
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.model.SChapter
import eu.kanade.tachiyomi.util.chapter.refreshChapterList
import eu.kanade.tachiyomi.util.chapter.syncChaptersWithSource
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import yokai.data.DatabaseHandler
import yokai.domain.chapter.interactor.GetChapter
import yokai.domain.manga.MangaRepository

/** A bound comic whose local row lacks chapters another device has state for. */
data class ChapterPrefetchTarget(val localMangaId: Long, val sourceId: Long, val key: String)

fun interface ChapterPrefetchTargets {
    /** Most recently read first. */
    suspend fun awaiting(limit: Long): List<ChapterPrefetchTarget>
}

enum class ChapterFetchOutcome { ADDED, UNCHANGED, SKIPPED, FAILED }

fun interface ChapterListFetcher {
    suspend fun fetch(target: ChapterPrefetchTarget): ChapterFetchOutcome
}

/** When each title may be fetched again, so a run never hammers a source. */
interface ChapterPrefetchCooldown {
    fun nextAllowedAt(localMangaId: Long): Long?
    fun record(localMangaId: Long, nextAllowedAt: Long)
    fun prune(now: Long)
}

data class ChapterPrefetchReport(val added: Int, val failed: Int, val remaining: Boolean)

/**
 * Lists chapters for titles whose desktop progress is waiting on them. The paired desktop's
 * Suwayomi already holds those lists, so [desktop] reads them from the Core first, every title in
 * one run. Titles the desktop cannot serve fall back to the same extension call and chapter sync
 * the library update uses, bounded per run: a few titles, at most two sources at once and one
 * title at a time per source, so a large first sync spreads over runs.
 */
class PortableChapterPrefetcher(
    private val targets: ChapterPrefetchTargets,
    private val fetcher: ChapterListFetcher,
    private val cooldown: ChapterPrefetchCooldown,
    private val desktop: CoreChapterListStage? = null,
    private val clock: () -> Long = System::currentTimeMillis,
    private val titlesPerRun: Int = DEFAULT_TITLES_PER_RUN,
    private val sourceQueues: Int = DEFAULT_SOURCE_QUEUES,
    private val fetchTimeoutMillis: Long = DEFAULT_FETCH_TIMEOUT_MILLIS,
    private val runDeadlineMillis: Long = DEFAULT_RUN_DEADLINE_MILLIS,
) {
    suspend fun run(): ChapterPrefetchReport {
        val startedAt = clock()
        cooldown.prune(startedAt)
        val awaiting = targets.awaiting(CANDIDATE_LIMIT)
        val fromDesktop = desktop?.run(awaiting) { clock() - startedAt >= runDeadlineMillis }.orEmpty()
        val desktopAdded = fromDesktop.values.count { it == ChapterFetchOutcome.ADDED }
        val eligible = awaiting
            .filter { fromDesktop[it.localMangaId]?.listed != true }
            .filter { (cooldown.nextAllowedAt(it.localMangaId) ?: 0L) <= startedAt }
        val batch = eligible.take(titlesPerRun)
        if (batch.isEmpty()) return ChapterPrefetchReport(added = desktopAdded, failed = 0, remaining = false)

        val outcomes = java.util.concurrent.ConcurrentHashMap<Long, ChapterFetchOutcome>()
        val queues = Channel<List<ChapterPrefetchTarget>>(Channel.UNLIMITED)
        batch.groupBy(ChapterPrefetchTarget::sourceId).values.forEach(queues::trySend)
        queues.close()
        coroutineScope {
            repeat(sourceQueues.coerceAtLeast(1)) {
                launch {
                    for (queue in queues) {
                        for (target in queue) {
                            // Checked between titles, so a run never stops a chapter write midway.
                            if (clock() - startedAt >= runDeadlineMillis) break
                            val outcome = fetchOne(target)
                            outcomes[target.localMangaId] = outcome
                            val wait = if (outcome == ChapterFetchOutcome.ADDED ||
                                outcome == ChapterFetchOutcome.UNCHANGED
                            ) {
                                COOLDOWN_AFTER_FETCH_MILLIS
                            } else {
                                COOLDOWN_AFTER_FAILURE_MILLIS
                            }
                            cooldown.record(target.localMangaId, clock() + wait)
                        }
                    }
                }
            }
        }
        return ChapterPrefetchReport(
            added = desktopAdded + outcomes.values.count { it == ChapterFetchOutcome.ADDED },
            failed = outcomes.values.count { it == ChapterFetchOutcome.FAILED },
            remaining = eligible.size > outcomes.size,
        )
    }

    private suspend fun fetchOne(target: ChapterPrefetchTarget): ChapterFetchOutcome = try {
        withTimeoutOrNull(fetchTimeoutMillis) { fetcher.fetch(target) } ?: ChapterFetchOutcome.FAILED
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ChapterFetchOutcome.FAILED
    }

    companion object {
        const val DEFAULT_TITLES_PER_RUN = 30
        const val DEFAULT_SOURCE_QUEUES = 2
        const val DEFAULT_FETCH_TIMEOUT_MILLIS = 45_000L
        const val DEFAULT_RUN_DEADLINE_MILLIS = 8 * 60 * 1_000L
        const val COOLDOWN_AFTER_FETCH_MILLIS = 12 * 60 * 60 * 1_000L
        const val COOLDOWN_AFTER_FAILURE_MILLIS = 60 * 60 * 1_000L
        private const val CANDIDATE_LIMIT = 2_000L
    }
}

private val ChapterFetchOutcome.listed: Boolean
    get() = this == ChapterFetchOutcome.ADDED || this == ChapterFetchOutcome.UNCHANGED

/**
 * Reads the awaiting titles' chapter lists from the paired desktop in one Core session, a few at
 * a time, and writes each with [writer]. Returns null when no Core session is usable, and an
 * outcome only for titles the desktop library holds; the rest stay for the extension.
 *
 * A title whose desktop list added chapters may be asked again at once: it binds on the next sync
 * pass, and if its chapter is still missing the list comes back unchanged. Unchanged and failed
 * titles wait [COOLDOWN_MILLIS] before the desktop is asked again.
 */
class CoreChapterListStage(
    private val catalog: CoreChapterCatalog,
    private val writer: ChapterListWriter,
    private val cooldown: ChapterPrefetchCooldown,
    private val clock: () -> Long = System::currentTimeMillis,
    private val readers: Int = DEFAULT_READERS,
    private val titleTimeoutMillis: Long = DEFAULT_TITLE_TIMEOUT_MILLIS,
) {
    suspend fun run(
        targets: List<ChapterPrefetchTarget>,
        pastDeadline: () -> Boolean,
    ): Map<Long, ChapterFetchOutcome>? {
        val now = clock()
        cooldown.prune(now)
        val due = targets.filter { (cooldown.nextAllowedAt(it.localMangaId) ?: 0L) <= now }
        if (due.isEmpty()) return emptyMap()
        return try {
            catalog.withReader { reader ->
                val library = reader.libraryIds()
                val known = due.mapNotNull { target ->
                    library[CoreWorkKey(target.sourceId, target.key)]?.let { target to it }
                }
                val outcomes = java.util.concurrent.ConcurrentHashMap<Long, ChapterFetchOutcome>()
                val queue = Channel<Pair<ChapterPrefetchTarget, Long>>(Channel.UNLIMITED)
                known.forEach(queue::trySend)
                queue.close()
                coroutineScope {
                    repeat(readers.coerceAtLeast(1)) {
                        launch {
                            for ((target, suwayomiId) in queue) {
                                if (pastDeadline()) break
                                val outcome = readOne(reader, target, suwayomiId)
                                outcomes[target.localMangaId] = outcome
                                if (outcome != ChapterFetchOutcome.ADDED) {
                                    cooldown.record(target.localMangaId, clock() + COOLDOWN_MILLIS)
                                }
                            }
                        }
                    }
                }
                outcomes
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The desktop library could not be read: every title stays for the extension.
            null
        }
    }

    private suspend fun readOne(
        reader: CoreChapterCatalogReader,
        target: ChapterPrefetchTarget,
        suwayomiId: Long,
    ): ChapterFetchOutcome = try {
        withTimeoutOrNull(titleTimeoutMillis) {
            val list = reader.chapters(suwayomiId)
            if (list.chapters.isEmpty()) ChapterFetchOutcome.FAILED else writer.write(target, list)
        } ?: ChapterFetchOutcome.FAILED
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        ChapterFetchOutcome.FAILED
    }

    companion object {
        const val DEFAULT_READERS = 4
        const val DEFAULT_TITLE_TIMEOUT_MILLIS = 30_000L
        const val COOLDOWN_MILLIS = 10 * 60 * 1_000L
    }
}

/**
 * The sync pass never calls an extension: it asks for a background chapter fetch and leaves the
 * chapter pending, so it binds, with its desktop state, on the sync that follows the fetch.
 */
class DeferredComicChapterMaterializer(
    private val requestPrefetch: () -> Unit,
) : PortableChapterMaterializer {
    override suspend fun materialize(ref: PortableChapterRef): ChapterResolution =
        materializeAll(listOf(ref)).single()

    override suspend fun materializeAll(refs: List<PortableChapterRef>): List<ChapterResolution> {
        if (refs.isNotEmpty()) requestPrefetch()
        return refs.map(::chapterNotListedYet)
    }
}

class SqlDelightChapterPrefetchTargets(
    private val database: DatabaseHandler,
) : ChapterPrefetchTargets {
    override suspend fun awaiting(limit: Long): List<ChapterPrefetchTarget> =
        database.awaitList { aethon_syncQueries.selectComicWorksAwaitingChapterList(limit) }
            .mapNotNull { row ->
                val sourceId = row.source_id?.toLongOrNull() ?: return@mapNotNull null
                val localId = row.local_reference?.toLongOrNull() ?: return@mapNotNull null
                ChapterPrefetchTarget(localMangaId = localId, sourceId = sourceId, key = row.provider_key)
            }
}

/** The library update's own chapter path: extension list, then [syncChaptersWithSource]. */
class SourceChapterListFetcher(
    private val sources: SourceManager,
    private val mangas: MangaRepository,
) : ChapterListFetcher {
    override suspend fun fetch(target: ChapterPrefetchTarget): ChapterFetchOutcome {
        val source = sources.get(target.sourceId) as? CatalogueSource ?: return ChapterFetchOutcome.SKIPPED
        val manga = mangas.getMangaById(target.localMangaId) ?: return ChapterFetchOutcome.SKIPPED
        if (manga.source != target.sourceId) return ChapterFetchOutcome.SKIPPED
        val fetched = withContext(Dispatchers.IO) { source.refreshChapterList(manga) }
        // An empty list is a source hiccup here, not a title without chapters: keep what is stored.
        if (fetched.isEmpty()) return ChapterFetchOutcome.FAILED
        val (added, _) = withContext(NonCancellable + Dispatchers.IO) {
            syncChaptersWithSource(fetched, manga, source)
        }
        return if (added.isEmpty()) ChapterFetchOutcome.UNCHANGED else ChapterFetchOutcome.ADDED
    }
}

fun interface ChapterListWriter {
    /** Writes [list] into the title without removing a chapter it stores. */
    suspend fun write(target: ChapterPrefetchTarget, list: CoreChapterList): ChapterFetchOutcome
}

/**
 * Writes a desktop chapter list through the library update's own [syncChaptersWithSource]. The
 * desktop read state it folds in comes from the same list, not from a second Core request.
 */
class SourceChapterListWriter(
    private val sources: SourceManager,
    private val mangas: MangaRepository,
    private val getChapter: GetChapter,
    private val readState: CoreBridgedChapterReadState,
) : ChapterListWriter {
    override suspend fun write(target: ChapterPrefetchTarget, list: CoreChapterList): ChapterFetchOutcome {
        val source = sources.get(target.sourceId) ?: return ChapterFetchOutcome.SKIPPED
        val manga = mangas.getMangaById(target.localMangaId) ?: return ChapterFetchOutcome.SKIPPED
        if (manga.source != target.sourceId || manga.url != target.key) return ChapterFetchOutcome.SKIPPED
        val (added, _) = withContext(NonCancellable + Dispatchers.IO) {
            val stored = getChapter.awaitAll(manga, false)
                .sortedBy { it.source_order }
                .map { chapter -> SChapter.create().apply { copyFrom(chapter) } }
            syncChaptersWithSource(
                keepStoredChapters(list.chapters, stored),
                manga,
                source,
                bridgedReadState = { mangaId, hasNew -> readState.chapters(mangaId, hasNew, list.nodes) },
            )
        }
        return if (added.isEmpty()) ChapterFetchOutcome.UNCHANGED else ChapterFetchOutcome.ADDED
    }
}

/**
 * The desktop list plus the chapters this device stores that the desktop does not list, so a
 * desktop that has not refreshed the title never removes a chapter (or its read state) here.
 * Stored chapters numbered past the desktop's newest go first; the others after its oldest.
 */
internal fun keepStoredChapters(desktop: List<SChapter>, stored: List<SChapter>): List<SChapter> {
    val listed = desktop.mapTo(HashSet()) { it.url }
    val extra = stored.filter { it.url !in listed }
    if (extra.isEmpty()) return desktop
    val newestListed = desktop.maxOfOrNull { it.chapter_number } ?: -1f
    val (newer, older) = extra.partition { it.chapter_number >= 0f && it.chapter_number > newestListed }
    return newer + desktop + older
}

class SharedPreferencesChapterPrefetchCooldown(
    context: Context,
    name: String = PREFERENCES,
) : ChapterPrefetchCooldown {
    private val preferences = context.applicationContext
        .getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun nextAllowedAt(localMangaId: Long): Long? =
        preferences.getLong(localMangaId.toString(), 0L).takeIf { it > 0L }

    override fun record(localMangaId: Long, nextAllowedAt: Long) {
        preferences.edit().putLong(localMangaId.toString(), nextAllowedAt).apply()
    }

    override fun prune(now: Long) {
        val expired = preferences.all.filter { (_, value) -> (value as? Long ?: 0L) <= now }.keys
        if (expired.isEmpty()) return
        preferences.edit().apply { expired.forEach(::remove) }.apply()
    }

    companion object {
        private const val PREFERENCES = "epigraph_portable_chapter_prefetch"
        const val DESKTOP_PREFERENCES = "epigraph_portable_chapter_prefetch_core"
    }
}
