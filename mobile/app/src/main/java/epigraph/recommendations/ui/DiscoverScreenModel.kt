package epigraph.recommendations.ui
import android.app.Application
import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.DiscoverPool
import epigraph.recommendations.DiscoverRecommendationLoader
import epigraph.recommendations.DiscoverResult
import epigraph.recommendations.RecommendationItem
import epigraph.recommendations.RecommendationSectionKey
import epigraph.recommendations.SEARCH_RECOMMENDATION_BASE_LIMIT
import epigraph.recommendations.SEARCH_RECOMMENDATION_LIMIT_STEP
import epigraph.recommendations.SEARCH_RECOMMENDATION_MAX_LIMIT
import epigraph.recommendations.SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS
import epigraph.recommendations.nextVisibleLimit
import eu.kanade.tachiyomi.data.database.models.create
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.model.SManga
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.util.koin.get

class DiscoverScreenModel(
    initialMode: DiscoverMode,
    private val loader: DiscoverRecommendationLoader = DiscoverRecommendationLoader(get<Application>()),
    private val sourceManager: SourceManager = get(),
    private val getManga: GetManga = get(),
    private val insertManga: InsertManga = get(),
    private val preferences: PreferencesHelper = get(),
) : StateScreenModel<DiscoverScreenModel.State>(State(mode = initialMode, includeNsfw = preferences.showNsfwSources().get())) {

    @Immutable
    data class State(
        val mode: DiscoverMode,
        val loading: Boolean = true,
        val result: DiscoverResult? = null,
        val error: String? = null,
        val includeLibrary: Boolean = false,
        val includeNsfw: Boolean = false,
        val visibleLimits: Map<RecommendationSectionKey, Int> = emptyMap(),
    )

    private var loadJob: Job? = null
    private val moreTriggeredAt = HashMap<RecommendationSectionKey, Long>()
    private val moreLoading = java.util.concurrent.ConcurrentHashMap.newKeySet<RecommendationSectionKey>()

    init {
        load(force = false)
    }

    fun setMode(mode: DiscoverMode) {
        if (mode == state.value.mode) return
        mutableState.update { it.copy(mode = mode) }
        load(force = false)
    }

    fun load(force: Boolean) {
        val mode = state.value.mode
        val cached = cachedPool(mode)
        if (!force && cached != null) {
            mutableState.update { it.copy(loading = false, result = rank(cached), error = null, visibleLimits = emptyMap()) }
            return
        }
        loadJob?.cancel()
        mutableState.update { it.copy(loading = true, result = if (force) it.result else null, error = null, visibleLimits = emptyMap()) }
        loadJob = screenModelScope.launch(Dispatchers.IO) {
            try {
                val pool = loader.gather(mode)
                cache[mode] = CachedPool(pool, System.currentTimeMillis())
                val result = rank(pool)
                mutableState.update { if (it.mode == mode) it.copy(loading = false, result = result, visibleLimits = emptyMap()) else it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutableState.update { if (it.mode == mode) it.copy(loading = false, error = e.message.orEmpty()) else it }
            }
        }
    }

    /** Re-ranks the cached pool; no network. No-op until the first successful load. */
    fun setIncludeLibrary(value: Boolean) {
        if (value == state.value.includeLibrary) return
        mutableState.update { it.copy(includeLibrary = value) }
        val cached = cachedPool(state.value.mode) ?: return
        mutableState.update { it.copy(result = rank(cached), visibleLimits = emptyMap()) }
    }

    /** Flips the global "show NSFW" setting; source selection depends on it, so reload. */
    fun setIncludeNsfw(value: Boolean) {
        if (value == state.value.includeNsfw) return
        preferences.showNsfwSources().set(value)
        mutableState.update { it.copy(includeNsfw = value) }
        load(force = true)
    }

    /** Grows one rail by a step when the user scrolls near its end; fetches more pages when it ran out (desktop parity). */
    fun showMore(key: RecommendationSectionKey) {
        if (key in moreLoading) return
        val now = System.currentTimeMillis()
        if (now - (moreTriggeredAt[key] ?: 0L) < SEARCH_RECOMMENDATION_SCROLL_THROTTLE_MS) return
        moreTriggeredAt[key] = now
        val section = state.value.result?.sections?.firstOrNull { it.key == key } ?: return
        val current = state.value.visibleLimits[key] ?: SEARCH_RECOMMENDATION_BASE_LIMIT
        val next = nextVisibleLimit(current, section.items.size)
        if (next != null) {
            mutableState.update { it.copy(visibleLimits = it.visibleLimits + (key to next)) }
            return
        }
        if (current >= SEARCH_RECOMMENDATION_MAX_LIMIT) return
        val mode = state.value.mode
        val cached = cache[mode] ?: return
        if (!moreLoading.add(key)) return
        screenModelScope.launch(Dispatchers.IO) {
            try {
                val more = loader.loadMore(cached.pool, key, state.value.includeNsfw) { pool ->
                    rank(pool).sections.firstOrNull { it.key == key }?.items?.size ?: 0
                }
                // A reload replaced the pool meanwhile; drop this page.
                if (cache[mode] !== cached) return@launch
                // Keep the original load time: more pages do not make the whole pool fresh.
                cache[mode] = CachedPool(more.pool, cached.loadedAt)
                val result = rank(more.pool)
                val grown = minOf(SEARCH_RECOMMENDATION_MAX_LIMIT, current + SEARCH_RECOMMENDATION_LIMIT_STEP)
                mutableState.update { s ->
                    if (s.mode != mode) s
                    else s.copy(result = result, visibleLimits = if (more.grew) s.visibleLimits + (key to grown) else s.visibleLimits)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Load-more is best effort; the rail simply stops growing.
            } finally {
                moreLoading.remove(key)
            }
        }
    }

    private fun rank(pool: DiscoverPool): DiscoverResult =
        loader.rank(pool, state.value.includeLibrary, state.value.includeNsfw, System.currentTimeMillis())

    /**
     * The in-app entry for a recommendation: an installed source result is inserted like a Browse
     * result would be; tracker-only picks return null so the caller falls back to global search.
     */
    suspend fun resolveLocalManga(item: RecommendationItem): Manga? = withContext(Dispatchers.IO) {
        for (target in item.candidate.targets) {
            if (sourceManager.get(target.sourceId) !is CatalogueSource) continue
            val existing = getManga.awaitByUrlAndSource(target.url, target.sourceId)
            if (existing != null) return@withContext existing
            val sManga = SManga.create().apply {
                url = target.url
                title = target.title
                thumbnail_url = item.candidate.cover?.url
            }
            val manga = Manga.create(target.url, target.title, target.sourceId)
            manga.copyFrom(sManga)
            manga.id = insertManga.await(manga)
            return@withContext manga
        }
        null
    }

    private class CachedPool(val pool: DiscoverPool, val loadedAt: Long)

    companion object {
        /**
         * Results are kept per mode for the whole process, so switching modes or reopening For you
         * from Recents or Browse does not hit every source again; refresh forces a new load.
         */
        private val cache = java.util.concurrent.ConcurrentHashMap<DiscoverMode, CachedPool>()
        private const val CACHE_TTL_MS = 30 * 60 * 1000L

        private fun cachedPool(mode: DiscoverMode): DiscoverPool? =
            cache[mode]?.takeIf { System.currentTimeMillis() - it.loadedAt < CACHE_TTL_MS }?.pool
    }
}
