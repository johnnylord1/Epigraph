package epigraph.recommendations.ui
import android.app.Application
import androidx.compose.runtime.Immutable
import androidx.lifecycle.ProcessLifecycleOwner
import androidx.lifecycle.lifecycleScope
import cafe.adriel.voyager.core.model.StateScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import co.touchlab.kermit.Logger
import epigraph.recommendations.DiscoverCatalogEntry
import epigraph.recommendations.DiscoverGenreSearch
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.DiscoverPool
import epigraph.recommendations.DiscoverPoolStore
import epigraph.recommendations.DiscoverRecommendationLoader
import epigraph.recommendations.DiscoverResult
import epigraph.recommendations.RecommendationCandidate
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
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.util.koin.get
import java.io.File

/** Discover's two sub-tabs: library-based picks, and everything the installed extensions list. */
enum class DiscoverSection { FOR_YOU, CATALOG }

class DiscoverScreenModel(
    initialMode: DiscoverMode,
    private val loader: DiscoverRecommendationLoader = DiscoverRecommendationLoader(get<Application>()),
    private val sourceManager: SourceManager = get(),
    private val getManga: GetManga = get(),
    private val insertManga: InsertManga = get(),
    private val preferences: PreferencesHelper = get(),
) : StateScreenModel<DiscoverScreenModel.State>(
    State(
        mode = initialMode,
        includeNsfw = preferences.showNsfwSources().get(),
        gridSize = preferences.discoverGridSize().get(),
        genreOptions = loader.genreOptions(preferences.showNsfwSources().get()),
    ),
) {

    @Immutable
    data class State(
        val mode: DiscoverMode,
        val loading: Boolean = true,
        val result: DiscoverResult? = null,
        val error: String? = null,
        val includeLibrary: Boolean = false,
        val includeNsfw: Boolean = false,
        val visibleLimits: Map<RecommendationSectionKey, Int> = emptyMap(),
        val section: DiscoverSection = DiscoverSection.FOR_YOU,
        val catalog: List<DiscoverCatalogEntry> = emptyList(),
        val catalogLoadingMore: Boolean = false,
        val catalogExhausted: Boolean = false,
        /** Card size on the library grid scale: 1 is the default, each step is 1.5x larger. */
        val gridSize: Float = 1f,
        /** Catalog genre filter; every selected genre must match. */
        val genres: List<String> = emptyList(),
        val genreOptions: List<String> = emptyList(),
    )

    private var loadJob: Job? = null
    private var catalogJob: Job? = null
    private var genreSearch: DiscoverGenreSearch? = null
    private val moreTriggeredAt = HashMap<RecommendationSectionKey, Long>()
    private val moreLoading = java.util.concurrent.ConcurrentHashMap.newKeySet<RecommendationSectionKey>()

    init {
        load(force = false)
    }

    fun setSection(section: DiscoverSection) {
        if (section == state.value.section) return
        mutableState.update { it.copy(section = section) }
    }

    fun setMode(mode: DiscoverMode) {
        if (mode == state.value.mode) return
        mutableState.update { it.copy(mode = mode) }
        load(force = false)
    }

    fun setGridSize(value: Float) {
        preferences.discoverGridSize().set(value)
        mutableState.update { it.copy(gridSize = value) }
    }

    /** Re-filters the gathered works at once, then searches the sources for the genres. */
    fun setGenres(genres: List<String>) {
        if (genres == state.value.genres) return
        catalogJob?.cancel()
        genreSearch = null
        mutableState.update { it.copy(genres = genres, catalogLoadingMore = false, catalogExhausted = false) }
        // A pool past its TTL is reloaded, and the load searches the genres once it is in;
        // returning here left the Catalog spinning with nothing asking the sources.
        val cached = lastPool(state.value.mode) ?: return reloadExpiredPool()
        mutableState.update { it.copy(catalog = catalog(cached)) }
        if (cachedPool(state.value.mode) == null) return reloadExpiredPool()
        loadMoreCatalog()
    }

    fun load(force: Boolean) {
        val mode = state.value.mode
        val cached = cachedPool(mode)
        if (!force && cached != null) {
            catalogJob?.cancel()
            genreSearch = null
            mutableState.update {
                it.copy(
                    loading = false,
                    result = rank(cached),
                    catalog = catalog(cached),
                    catalogExhausted = false,
                    error = null,
                    visibleLimits = emptyMap(),
                    catalogLoadingMore = false,
                )
            }
            if (state.value.genres.isNotEmpty()) loadMoreCatalog()
            reloadIfLibraryChanged(mode, cached)
            return
        }
        loadJob?.cancel()
        catalogJob?.cancel()
        genreSearch = null
        // The last pool, past its TTL, stays on screen while a new one loads behind it.
        val stale = if (force) null else lastPool(mode)
        mutableState.update {
            it.copy(
                loading = true,
                result = if (force) it.result else stale?.let(::rank),
                catalog = if (force) it.catalog else stale?.let(::catalog).orEmpty(),
                catalogLoadingMore = false,
                catalogExhausted = false,
                error = null,
                visibleLimits = emptyMap(),
            )
        }
        loadJob = screenModelScope.launch(Dispatchers.IO) {
            try {
                // A new run of the app starts from the pool the last one saved, usually already
                // read by the time the tab opens.
                if (!force && stale == null) {
                    preload(mode).await()
                    val saved = lastPool(mode)
                    if (saved != null) {
                        if (cachedPool(mode) != null) {
                            withContext(Dispatchers.Main) { if (state.value.mode == mode) load(force = false) }
                            return@launch
                        }
                        mutableState.update {
                            if (it.mode == mode && it.result == null) it.copy(result = rank(saved), catalog = catalog(saved)) else it
                        }
                    }
                }
                // Every step has its own budget; this only stops one that ignores cancellation
                // from leaving the screen spinning. Awaiting apart from the work lets it give up.
                val gathering = screenModelScope.async(Dispatchers.IO) { loader.gather(mode) }
                val pool = try {
                    withTimeoutOrNull(GATHER_LIMIT_MS) { gathering.await() }
                } finally {
                    if (!gathering.isCompleted) gathering.cancel()
                } ?: throw IllegalStateException("")
                cache[mode] = CachedPool(pool, System.currentTimeMillis())
                // Saving waits for nothing on screen.
                launch { runCatching { store.write(pool) } }
                val result = rank(pool)
                val catalogEntries = catalog(pool)
                mutableState.update {
                    if (it.mode == mode) it.copy(loading = false, result = result, catalog = catalogEntries, visibleLimits = emptyMap()) else it
                }
                if (state.value.mode == mode && state.value.genres.isNotEmpty()) {
                    withContext(Dispatchers.Main) { loadMoreCatalog() }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutableState.update { if (it.mode == mode) it.copy(loading = false, error = e.message.orEmpty()) else it }
            }
        }
    }

    /** Re-ranks the cached pool; no network unless it expired. */
    fun setIncludeLibrary(value: Boolean) {
        if (value == state.value.includeLibrary) return
        mutableState.update { it.copy(includeLibrary = value) }
        val cached = lastPool(state.value.mode) ?: return reloadExpiredPool()
        mutableState.update { it.copy(result = rank(cached), catalog = catalog(cached), visibleLimits = emptyMap()) }
        if (cachedPool(state.value.mode) == null) reloadExpiredPool()
    }

    /** Flips the global "show NSFW" setting; source selection depends on it, so reload. */
    fun setIncludeNsfw(value: Boolean) {
        if (value == state.value.includeNsfw) return
        preferences.showNsfwSources().set(value)
        val options = loader.genreOptions(value)
        mutableState.update { it.copy(includeNsfw = value, genreOptions = options, genres = it.genres.filter { genre -> genre in options }) }
        // The shown pool takes the new filter at once; turning NSFW off must not leave it on screen while the reload runs.
        lastPool(state.value.mode)?.let { pool ->
            mutableState.update { it.copy(result = rank(pool), catalog = catalog(pool), visibleLimits = emptyMap()) }
        }
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
                val catalogEntries = catalog(more.pool)
                val grown = minOf(SEARCH_RECOMMENDATION_MAX_LIMIT, current + SEARCH_RECOMMENDATION_LIMIT_STEP)
                mutableState.update { s ->
                    if (s.mode != mode) s
                    else s.copy(
                        result = result,
                        catalog = catalogEntries,
                        visibleLimits = if (more.grew) s.visibleLimits + (key to grown) else s.visibleLimits,
                    )
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

    /**
     * Catalog infinite scroll: fetches the next popular page of the installed sources (plus tracker
     * scores for comics) into the shared pool. Stops once a page brings nothing new.
     */
    fun loadMoreCatalog() {
        val current = state.value
        if (current.loading || current.catalogLoadingMore || current.catalogExhausted) return
        if (catalogJob?.isActive == true) return
        val mode = current.mode
        val cached = cache[mode] ?: return
        if (current.genres.isNotEmpty()) {
            loadMoreGenreCatalog(mode, cached, current.genres)
            return
        }
        mutableState.update { it.copy(catalogLoadingMore = true) }
        val job = screenModelScope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            try {
                val key = RecommendationSectionKey.HIGH_CONFIDENCE
                val more = loader.loadMore(cached.pool, key, state.value.includeNsfw) { it.candidates.size }
                // A reload replaced the pool meanwhile; drop this page.
                if (cache[mode] !== cached) return@launch
                cache[mode] = CachedPool(more.pool, cached.loadedAt)
                val exhausted = key in more.pool.exhausted || (!more.grew && more.pool === cached.pool)
                val result = rank(more.pool)
                val catalogEntries = catalog(more.pool)
                mutableState.update { s ->
                    if (s.mode != mode) s else s.copy(result = result, catalog = catalogEntries, catalogExhausted = exhausted)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                // Best effort, like the For you rails: the catalog simply stops growing.
                mutableState.update { s -> if (s.mode != mode) s else s.copy(catalogExhausted = true) }
            } finally {
                if (catalogJob === coroutineContext.job) mutableState.update { it.copy(catalogLoadingMore = false) }
            }
        }
        catalogJob = job
        job.start()
    }

    /** Catalog infinite scroll with genres: the next page of the genre search of every source. */
    private fun loadMoreGenreCatalog(mode: DiscoverMode, cached: CachedPool, genres: List<String>) {
        val search = genreSearch?.takeIf { it.mode == mode && it.genres == genres } ?: DiscoverGenreSearch(mode, genres)
        if (search.exhausted) {
            mutableState.update { it.copy(catalogExhausted = true) }
            return
        }
        mutableState.update { it.copy(catalogLoadingMore = true) }
        val job = screenModelScope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            try {
                val next = loader.searchGenre(cached.pool, search, state.value.includeNsfw)
                if (state.value.mode != mode || state.value.genres != genres) return@launch
                genreSearch = next
                val catalogEntries = catalog(cache[mode]?.pool ?: cached.pool)
                mutableState.update { s ->
                    if (s.mode != mode || s.genres != genres) s else s.copy(catalog = catalogEntries, catalogExhausted = next.exhausted)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                mutableState.update { s -> if (s.mode != mode) s else s.copy(catalogExhausted = true) }
            } finally {
                if (catalogJob === coroutineContext.job) mutableState.update { it.copy(catalogLoadingMore = false) }
            }
        }
        catalogJob = job
        job.start()
    }

    /** Back on the screen (or the app): a pool past its TTL, or built from another library, loads again behind the one shown. */
    fun refreshIfExpired() {
        val mode = state.value.mode
        val cached = cachedPool(mode) ?: return reloadExpiredPool()
        if (!state.value.loading) reloadIfLibraryChanged(mode, cached)
    }

    /**
     * The library may have changed since (a sync, or a work added from a pick): the picks would
     * still be built from the old one and suggest what is now in it. A few works only read the
     * library again; more gather the pool again.
     */
    private fun reloadIfLibraryChanged(mode: DiscoverMode, cached: DiscoverPool) {
        screenModelScope.launch(Dispatchers.IO) {
            val current = runCatching { loader.librarySignature() }.getOrNull() ?: return@launch
            if (current == cached.librarySignature) return@launch
            val reread = runCatching { loader.withLibraryReadAgain(cached) }.getOrNull()
            withContext(Dispatchers.Main) {
                val entry = cache[mode]
                if (state.value.mode != mode || state.value.loading || entry?.pool !== cached) return@withContext
                if (reread == null) return@withContext load(force = true)
                if (!cache.replace(mode, entry, CachedPool(reread, entry.loadedAt))) return@withContext
                mutableState.update { if (it.mode == mode) it.copy(result = rank(reread), catalog = catalog(reread)) else it }
                launch(Dispatchers.IO) { runCatching { store.write(reread) } }
            }
        }
    }

    /** The pool expired: load it again. A load already running applies the new filters when it lands. */
    private fun reloadExpiredPool() {
        if (!state.value.loading) load(force = false)
    }

    private fun rank(pool: DiscoverPool): DiscoverResult =
        loader.rank(pool, state.value.includeLibrary, state.value.includeNsfw, System.currentTimeMillis())

    private fun catalog(pool: DiscoverPool): List<DiscoverCatalogEntry> {
        val s = state.value
        val now = System.currentTimeMillis()
        if (s.genres.isEmpty()) return loader.catalog(pool, s.includeLibrary, s.includeNsfw, now)
        val search = genreSearch?.takeIf { it.mode == pool.mode && it.genres == s.genres } ?: DiscoverGenreSearch(pool.mode, s.genres)
        return loader.genreCatalog(pool, search, s.includeLibrary, s.includeNsfw, now)
    }

    /**
     * The in-app entry for a recommendation: an installed source result is inserted like a Browse
     * result would be; tracker-only picks return null so the caller falls back to global search.
     */
    suspend fun resolveLocalManga(candidate: RecommendationCandidate): Manga? = withContext(Dispatchers.IO) {
        for (target in candidate.targets) {
            if (sourceManager.get(target.sourceId) !is CatalogueSource) continue
            val existing = getManga.awaitByUrlAndSource(target.url, target.sourceId)
            if (existing != null) return@withContext existing
            val sManga = SManga.create().apply {
                url = target.url
                title = target.title
                thumbnail_url = candidate.cover?.url
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
         * Results are kept per mode for the whole process, so switching modes or returning to the
         * Discover tab does not hit every source again; refresh forces a new load.
         */
        private val cache = java.util.concurrent.ConcurrentHashMap<DiscoverMode, CachedPool>()
        private const val CACHE_TTL_MS = 30 * 60 * 1000L
        private const val GATHER_LIMIT_MS = 150_000L

        /** The last pool of [mode], however old; ranking it again needs no network. */
        private fun lastPool(mode: DiscoverMode): DiscoverPool? = cache[mode]?.pool

        private fun cachedPool(mode: DiscoverMode): DiscoverPool? =
            cache[mode]?.takeIf { System.currentTimeMillis() - it.loadedAt < CACHE_TTL_MS }?.pool

        private val store by lazy { DiscoverPoolStore(File(get<Application>().cacheDir, "discover")) }
        private val restorer by lazy { DiscoverRecommendationLoader(get<Application>()) }
        private val restoring = java.util.concurrent.ConcurrentHashMap<DiscoverMode, Deferred<Unit>>()

        /**
         * Reads the pool the last run saved into memory, once per run. The app starts it early so
         * the tab opens on it at once; a screen opened before it is done waits for the same read.
         */
        fun preload(mode: DiscoverMode): Deferred<Unit> = restoring.computeIfAbsent(mode) {
            ProcessLifecycleOwner.get().lifecycleScope.async(Dispatchers.IO) {
                if (cache[mode] != null) return@async
                val started = System.currentTimeMillis()
                val saved = runCatching { store.read(mode) }.getOrNull() ?: return@async
                val pool = runCatching { restorer.restore(saved) }.getOrNull() ?: return@async
                cache.putIfAbsent(mode, CachedPool(pool, pool.gatheredAtMs))
                Logger.d { "Discover: restored the saved $mode pool in ${System.currentTimeMillis() - started} ms" }
            }
        }
    }
}
