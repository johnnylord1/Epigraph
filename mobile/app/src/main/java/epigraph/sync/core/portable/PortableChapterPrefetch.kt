package epigraph.sync.core.portable

import android.content.Context
import epigraph.contract.ChapterResolution
import epigraph.contract.PortableChapterRef
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
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
import yokai.domain.manga.MangaRepository

/** A bound comic whose local row lacks chapters another device has state for. */
data class ChapterPrefetchTarget(val localMangaId: Long, val sourceId: Long)

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
 * Lists chapters for titles whose desktop progress is waiting on them, through the same extension
 * call and chapter sync the library update uses. Each run is bounded: a few titles, at most two
 * sources at once and one title at a time per source, so a large first sync spreads over runs.
 */
class PortableChapterPrefetcher(
    private val targets: ChapterPrefetchTargets,
    private val fetcher: ChapterListFetcher,
    private val cooldown: ChapterPrefetchCooldown,
    private val clock: () -> Long = System::currentTimeMillis,
    private val titlesPerRun: Int = DEFAULT_TITLES_PER_RUN,
    private val sourceQueues: Int = DEFAULT_SOURCE_QUEUES,
    private val fetchTimeoutMillis: Long = DEFAULT_FETCH_TIMEOUT_MILLIS,
    private val runDeadlineMillis: Long = DEFAULT_RUN_DEADLINE_MILLIS,
) {
    suspend fun run(): ChapterPrefetchReport {
        val startedAt = clock()
        cooldown.prune(startedAt)
        val eligible = targets.awaiting(CANDIDATE_LIMIT)
            .filter { (cooldown.nextAllowedAt(it.localMangaId) ?: 0L) <= startedAt }
        val batch = eligible.take(titlesPerRun)
        if (batch.isEmpty()) return ChapterPrefetchReport(added = 0, failed = 0, remaining = false)

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
            added = outcomes.values.count { it == ChapterFetchOutcome.ADDED },
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
        private const val CANDIDATE_LIMIT = 500L
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
                ChapterPrefetchTarget(localMangaId = localId, sourceId = sourceId)
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

class SharedPreferencesChapterPrefetchCooldown(context: Context) : ChapterPrefetchCooldown {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

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

    private companion object {
        const val PREFERENCES = "epigraph_portable_chapter_prefetch"
    }
}
