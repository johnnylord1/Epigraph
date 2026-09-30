package epigraph.recommendations.ui

import android.app.Application
import androidx.compose.runtime.Immutable
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.DiscoverRecommendationLoader
import epigraph.recommendations.DiscoverResult
import epigraph.recommendations.RecommendationItem
import eu.kanade.tachiyomi.data.database.models.create
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
) : StateScreenModel<DiscoverScreenModel.State>(State(mode = initialMode)) {

    @Immutable
    data class State(
        val mode: DiscoverMode,
        val loading: Boolean = true,
        val result: DiscoverResult? = null,
        val error: String? = null,
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
        val cached = cached(mode)
        if (!force && cached != null) {
            mutableState.update { it.copy(loading = false, result = cached, error = null) }
            return
        }
        loadJob?.cancel()
        mutableState.update { it.copy(loading = true, result = if (force) it.result else null, error = null) }
        loadJob = screenModelScope.launch(Dispatchers.IO) {
            try {
                val result = loader.load(mode)
                cache[mode] = CachedResult(result, System.currentTimeMillis())
                mutableState.update { if (it.mode == mode) it.copy(loading = false, result = result) else it }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutableState.update { if (it.mode == mode) it.copy(loading = false, error = e.message.orEmpty()) else it }
            }
        }
    }

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

    private class CachedResult(val result: DiscoverResult, val loadedAt: Long)

    companion object {
        /**
         * Results are kept per mode for the whole process, so switching modes or reopening For you
         * from Recents or Browse does not hit every source again; refresh forces a new load.
         */
        private val cache = java.util.concurrent.ConcurrentHashMap<DiscoverMode, CachedResult>()
        private const val CACHE_TTL_MS = 30 * 60 * 1000L

        private fun cached(mode: DiscoverMode): DiscoverResult? =
            cache[mode]?.takeIf { System.currentTimeMillis() - it.loadedAt < CACHE_TTL_MS }?.result
    }
}
