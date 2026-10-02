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
    )

    private var loadJob: Job? = null

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
            mutableState.update { it.copy(loading = false, result = rank(cached), error = null) }
            return
        }
        loadJob?.cancel()
        mutableState.update { it.copy(loading = true, result = if (force) it.result else null, error = null) }
        loadJob = screenModelScope.launch(Dispatchers.IO) {
            try {
                val pool = loader.gather(mode)
                cache[mode] = CachedPool(pool, System.currentTimeMillis())
                val result = rank(pool)
                mutableState.update { if (it.mode == mode) it.copy(loading = false, result = result) else it }
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
        mutableState.update { it.copy(result = rank(cached)) }
    }

    /** Flips the global "show NSFW" setting; source selection depends on it, so reload. */
    fun setIncludeNsfw(value: Boolean) {
        if (value == state.value.includeNsfw) return
        preferences.showNsfwSources().set(value)
        mutableState.update { it.copy(includeNsfw = value) }
        load(force = true)
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
