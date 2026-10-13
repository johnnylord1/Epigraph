package eu.kanade.tachiyomi.ui.migration.manga.process

import android.content.pm.ActivityInfo
import android.graphics.Color
import android.os.Bundle
import android.view.LayoutInflater
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import android.view.View
import android.widget.Toast
import androidx.activity.BackEventCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.isVisible
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.vectordrawable.graphics.drawable.VectorDrawableCompat
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.R
import epigraph.ui.motion.PredictiveBackPreview
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.databinding.MigrationListControllerBinding
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.smartsearch.SmartSearchEngine
import eu.kanade.tachiyomi.smartsearch.TitleMatcher
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.ui.base.SmallToolbarInterface
import eu.kanade.tachiyomi.ui.base.controller.BaseLegacyController
import eu.kanade.tachiyomi.ui.base.controller.FadeChangeHandler
import eu.kanade.tachiyomi.ui.main.BottomNavBarInterface
import eu.kanade.tachiyomi.ui.manga.MangaDetailsController
import eu.kanade.tachiyomi.ui.migration.MigrationFlags
import eu.kanade.tachiyomi.ui.migration.SearchController
import eu.kanade.tachiyomi.ui.migration.manga.design.PreMigrationController
import eu.kanade.tachiyomi.util.chapter.syncChaptersWithSource
import eu.kanade.tachiyomi.util.lang.toNormalized
import eu.kanade.tachiyomi.util.system.getParcelableCompat
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.util.system.launchUI
import eu.kanade.tachiyomi.util.system.materialAlertDialog
import eu.kanade.tachiyomi.util.system.toast
import eu.kanade.tachiyomi.util.system.withIOContext
import eu.kanade.tachiyomi.util.system.withUIContext
import eu.kanade.tachiyomi.util.view.RecyclerWindowInsetsListener
import eu.kanade.tachiyomi.util.view.activityBinding
import eu.kanade.tachiyomi.util.view.appBar
import eu.kanade.tachiyomi.util.view.isControllerVisible
import eu.kanade.tachiyomi.util.view.liftAppbarWith
import eu.kanade.tachiyomi.util.view.previousController
import eu.kanade.tachiyomi.util.view.setPositiveButton
import eu.kanade.tachiyomi.util.view.setTextColorAlpha
import eu.kanade.tachiyomi.util.view.setTitle
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import java.util.concurrent.atomic.AtomicInteger
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeout
import yokai.util.koin.injectLazy
import yokai.domain.chapter.interactor.GetChapter
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.UpdateManga
import yokai.i18n.MR
import yokai.util.lang.getString
import android.R as AR

class MigrationListController(bundle: Bundle? = null) :
    BaseLegacyController<MigrationListControllerBinding>(bundle),
    MigrationProcessAdapter.MigrationProcessInterface,
    BottomNavBarInterface,
    SmallToolbarInterface,
    CoroutineScope {

    init {
        setHasOptionsMenu(true)
    }

    private var adapter: MigrationProcessAdapter? = null

    override val coroutineContext: CoroutineContext = Job() + Dispatchers.Default

    val config = args.getParcelableCompat(CONFIG_EXTRA, MigrationProcedureConfig::class.java)

    private val getManga: GetManga by injectLazy()
    private val updateManga: UpdateManga by injectLazy()

    private val preferences: PreferencesHelper by injectLazy()
    private val sourceManager: SourceManager by injectLazy()

    private val getChapter: GetChapter by injectLazy()

    private val smartSearchEngine = SmartSearchEngine(coroutineContext, config?.extraSearchParams)

    // Chapter lists of sources such as Comix are read through a WebView (and may need a captcha), so
    // only one loads at a time; searches are not held up by it.
    private val chapterSemaphore = Semaphore(1)

    var migrationsJob: Job? = null
        private set
    private var migratingManga: MutableList<MigratingManga>? = null
    private var selectedPosition: Int? = null
    private var manaulMigrations = 0

    override fun createBinding(inflater: LayoutInflater) = MigrationListControllerBinding.inflate(inflater)
    override fun getTitle(): String {
        val progress = adapter?.items?.count { it.manga.migrationStatus != MigrationStatus.RUNNUNG }
        return activity?.getString(MR.strings.migration) + " ($progress/${adapter?.itemCount})"
    }

    override fun onViewCreated(view: View) {
        super.onViewCreated(view)
        liftAppbarWith(binding.recycler)
        val toolbarTextView = appBar()?.mainToolbar?.toolbarTitle
        toolbarTextView?.setTextColorAlpha(255)
        val config = this.config ?: return

        val newMigratingManga = migratingManga ?: run {
            val new = config.mangaIds.map {
                MigratingManga(sourceManager, it, coroutineContext)
            }
            migratingManga = new.toMutableList()
            new
        }

        adapter = MigrationProcessAdapter(this)

        binding.recycler.adapter = adapter
        binding.recycler.layoutManager = LinearLayoutManager(view.context)
        binding.recycler.setHasFixedSize(true)
        binding.recycler.setOnApplyWindowInsetsListener(RecyclerWindowInsetsListener)

        adapter?.updateDataSet(newMigratingManga.map { it.toModal() })

        if (migrationsJob == null) {
            migrationsJob = launch {
                runMigrations(newMigratingManga)
            }
        }
    }

    private suspend fun runMigrations(mangas: List<MigratingManga>) {
        val useSourceWithMost = preferences.useSourceWithMost().get()

        val sources = preferences.migrationSources().get().split("/").mapNotNull {
            val value = it.toLongOrNull() ?: return@mapNotNull null
            sourceManager.get(value) as? CatalogueSource
        }
        if (config == null) return
        val parallelism = preferences.migrationParallelism().get()
        val mangaSemaphore = Semaphore(parallelism)

        coroutineScope {
            for (manga in mangas) {
                if (!isActive) break
                // in case it was removed
                if (manga.mangaId !in config.mangaIds) continue
                if (!manga.searchResult.initialized && manga.migrationJob.isActive) {
                    launch {
                        mangaSemaphore.withPermit {
                            val mangaObj = manga.manga()

                            if (mangaObj == null) {
                                manga.searchResult.initialize(null)
                                return@withPermit
                            }

                            val mangaSource = manga.mangaSource()

                            // The search alone decides a match. The target's chapters load afterwards (see
                            // prefetchChapters): sources that read them through a WebView or behind a captcha
                            // can take minutes, or fail, and that must not hide a title the search found.
                            var chaptersLoaded = false
                            val result: Manga? = try {
                                CoroutineScope(manga.migrationJob).async {
                                    // The saved list holds comic and novel picks alike.
                                    val kindSources = sources.filter { it.isNovelSource() == mangaSource.isNovelSource() }
                                    // Other names the series goes by, from its description.
                                    val alternativeTitles = TitleMatcher.alternativeTitles(mangaObj.originalDescription)
                                    val validSources = if (kindSources.size == 1) {
                                        kindSources
                                    } else {
                                        kindSources.filter { it.id != mangaSource.id }
                                    }
                                    if (useSourceWithMost) {
                                        val sourceSemaphore = Semaphore(3)
                                        val processedSources = AtomicInteger()

                                        validSources.map { source ->
                                            async source@{
                                                sourceSemaphore.withPermit {
                                                    val searchResult = try {
                                                        smartSearchEngine.normalSearch(source, mangaObj.title, alternativeTitles)
                                                    } catch (e: CancellationException) {
                                                        throw e
                                                    } catch (e: Exception) {
                                                        Logger.w(e) { "Migration search failed in ${source.name}" }
                                                        null
                                                    }
                                                    manga.progress.value = validSources.size to processedSources.incrementAndGet()
                                                    if (searchResult == null ||
                                                        (searchResult.url == mangaObj.url && source.id == mangaObj.source)
                                                    ) {
                                                        return@source null
                                                    }
                                                    val localManga = smartSearchEngine.networkToLocalManga(searchResult, source.id)
                                                    // Comparing sources needs their chapter counts, but a source that
                                                    // cannot load them still counts as a match.
                                                    val loaded = chapterSemaphore.withPermit {
                                                        loadChapters(localManga, source) == null
                                                    }
                                                    val count = if (loaded) getChapter.awaitAll(localManga, false).size else -1
                                                    Triple(localManga, count, loaded)
                                                }
                                            }
                                        }.mapNotNull { it.await() }.maxByOrNull { it.second }?.let {
                                            chaptersLoaded = it.third
                                            it.first
                                        }
                                    } else {
                                        validSources.forEachIndexed { index, source ->
                                            val searchResult = try {
                                                smartSearchEngine.normalSearch(source, mangaObj.title, alternativeTitles)
                                                    ?.let { smartSearchEngine.networkToLocalManga(it, source.id) }
                                            } catch (e: CancellationException) {
                                                // Ignore cancellations
                                                throw e
                                            } catch (e: Exception) {
                                                Logger.w(e) { "Migration search failed in ${source.name}" }
                                                null
                                            }

                                            manga.progress.value = validSources.size to (index + 1)

                                            if (searchResult != null) return@async searchResult
                                        }

                                        null
                                    }
                                }.await()
                            } catch (e: CancellationException) {
                                // Ignore canceled migrations
                                return@launch
                            }

                            if (result != null && result.thumbnail_url == null) {
                                try {
                                    val newManga = withTimeout(DETAILS_TIMEOUT_MS) {
                                        sourceManager.getOrStub(result.source).getMangaDetails(result)
                                    }
                                    result.copyFrom(newManga)

                                    updateManga.await(result.toMangaUpdate())
                                } catch (e: TimeoutCancellationException) {
                                    Logger.w { "Migration details timed out for ${result.title}" }
                                } catch (e: CancellationException) {
                                    // Ignore cancellations
                                    throw e
                                } catch (_: Exception) {
                                }
                            }

                            manga.migrationStatus =
                                if (result == null) MigrationStatus.MANGA_NOT_FOUND else MigrationStatus.MANGA_FOUND
                            adapter?.sourceFinished()
                            manga.searchResult.initialize(result?.id)
                            if (result != null && !chaptersLoaded) {
                                prefetchChapters(manga, result, sourceManager.getOrStub(result.source))
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Loads the chapters of [target] in the background, one source request at a time, so the read
     * progress can be carried over when the migration runs. The row is refreshed once they arrive.
     */
    private fun prefetchChapters(
        migrating: MigratingManga,
        target: Manga,
        source: Source,
        reportFailure: Boolean = false,
    ) {
        migrating.chapterJob?.cancel()
        migrating.chapterJob = CoroutineScope(migrating.migrationJob).launch {
            val failure = chapterSemaphore.withPermit { loadChapters(target, source) }
            withUIContext {
                refreshItem(migrating)
                val activity = activity
                if (failure != null && reportFailure && activity != null) {
                    activity.toast(
                        activity.getString(MR.strings.migration_chapters_failed, target.title, failure),
                        Toast.LENGTH_LONG,
                    )
                }
            }
        }
    }

    /** Fetches and stores the chapters of [target]; returns why that failed, or null when it worked. */
    private suspend fun loadChapters(target: Manga, source: Source): String? {
        return try {
            val chapters = withTimeout(CHAPTERS_TIMEOUT_MS) { source.getChapterList(target) }
            withIOContext { syncChaptersWithSource(chapters, target, source) }
            null
        } catch (e: TimeoutCancellationException) {
            Logger.w { "Migration chapter list timed out for ${target.title} in ${source.name}" }
            activity?.getString(MR.strings.migration_chapters_timed_out) ?: "Timed out"
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Logger.w(e) { "Migration chapter list failed for ${target.title} in ${source.name}" }
            e.message?.takeIf { it.isNotBlank() } ?: e.javaClass.simpleName
        }
    }

    /**
     * Before the read progress of [prevManga] is copied, makes sure [target] has chapters to copy it
     * to: waits for the background load, then tries once more. Returns why they are still missing, or
     * null when the migration can go ahead (also when there is no progress to carry over).
     */
    suspend fun missingChaptersReason(
        migrating: MigratingManga,
        prevManga: Manga,
        target: Manga,
        source: Source,
    ): String? {
        if (!MigrationFlags.hasChapters(preferences.migrateFlags().get())) return null
        if (getChapter.awaitAll(prevManga, false).none { it.read || it.bookmark }) return null
        migrating.chapterJob?.join()
        if (getChapter.awaitAll(target, false).isNotEmpty()) return null
        val failure = chapterSemaphore.withPermit { loadChapters(target, source) }
        return failure ?: if (getChapter.awaitAll(target, false).isEmpty()) {
            activity?.getString(MR.strings.no_chapters_found_for_migration) ?: "No chapters"
        } else {
            null
        }
    }

    private fun refreshItem(migrating: MigratingManga) {
        val position = adapter?.currentItems?.indexOfFirst { it.manga === migrating } ?: return
        if (position >= 0) adapter?.notifyItemChanged(position)
    }

    override fun updateCount() {
        viewScope.launchUI {
            if (isControllerVisible) {
                setTitle()
            }
        }
    }

    override fun onDestroy() {
        super.onDestroy()

        activity?.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }

    override fun enableButtons() {
        activity?.invalidateOptionsMenu()
    }

    override fun removeManga(item: MigrationProcessItem) {
        val ids = config?.mangaIds?.toMutableList() ?: return
        val index = ids.indexOf(item.manga.mangaId)
        if (index > -1) {
            ids.removeAt(index)
            config.mangaIds = ids
            val index2 = migratingManga?.indexOf(item.manga) ?: return
            if (index2 > -1) migratingManga?.removeAt(index2)
        }
    }

    override fun noMigration() {
        launchUI {
            if (activity != null) {
                activity!!.toast(
                    activity!!.getString(
                        MR.plurals.manga_migrated,
                        manaulMigrations,
                        manaulMigrations,
                    ),
                )
            }
            router.popCurrentController()
        }
    }

    override fun onMenuItemClick(position: Int, item: MenuItem) {
        when (item.itemId) {
            R.id.action_search_manually -> {
                launchUI {
                    val manga = adapter?.getItem(position)?.manga?.manga() ?: return@launchUI
                    selectedPosition = position
                    val sources = preferences.migrationSources().get().split("/").mapNotNull {
                        val value = it.toLongOrNull() ?: return@mapNotNull null
                        sourceManager.get(value) as? CatalogueSource
                    }.filter { it.isNovelSource() == sourceManager.getOrStub(manga.source).isNovelSource() }
                    val validSources = if (sources.size == 1) {
                        sources
                    } else {
                        sources.filter { it.id != manga.source }
                    }
                    // The manga is shared with the rest of the screen; only the query is normalized.
                    val searchController = SearchController(manga.originalTitle.toNormalized(), manga.source, validSources)
                    searchController.targetController = this@MigrationListController
                    router.pushController(searchController.withFadeTransaction())
                }
            }
            R.id.action_skip -> adapter?.removeManga(position)
            R.id.action_migrate_now -> {
                adapter?.migrateManga(position, false)
                manaulMigrations++
            }
            R.id.action_copy_now -> {
                adapter?.migrateManga(position, true)
                manaulMigrations++
            }
        }
    }

    fun useMangaForMigration(manga: Manga, source: Source) {
        val firstIndex = selectedPosition ?: return
        val migratingManga = adapter?.getItem(firstIndex) ?: return
        migratingManga.manga.migrationStatus = MigrationStatus.RUNNUNG
        adapter?.notifyItemChanged(firstIndex)
        launchUI {
            // The user picked this series, so it is used even when its chapters cannot load right now
            // (a captcha, a slow WebView); the reason is shown and they load again before migrating.
            val result = try {
                CoroutineScope(migratingManga.manga.migrationJob).async {
                    smartSearchEngine.networkToLocalManga(manga, source.id)
                }.await()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Logger.e(e) { "Could not store the series picked for migration" }
                null
            }

            if (result != null) {
                try {
                    val newManga = withTimeout(DETAILS_TIMEOUT_MS) {
                        sourceManager.getOrStub(result.source).getMangaDetails(result)
                    }
                    result.copyFrom(newManga)

                    updateManga.await(result.toMangaUpdate())
                } catch (e: TimeoutCancellationException) {
                    Logger.w { "Migration details timed out for ${result.title}" }
                } catch (e: CancellationException) {
                    // Ignore cancellations
                    throw e
                } catch (_: Exception) {
                }

                migratingManga.manga.migrationStatus = MigrationStatus.MANGA_FOUND
                migratingManga.manga.searchResult.set(result.id)
                adapter?.notifyItemChanged(firstIndex)
                adapter?.sourceFinished()
                prefetchChapters(migratingManga.manga, result, source, reportFailure = true)
            } else {
                migratingManga.manga.migrationStatus = MigrationStatus.MANGA_NOT_FOUND
                adapter?.notifyItemChanged(firstIndex)
                adapter?.sourceFinished()
            }
        }
    }

    fun migrateMangas() = finishMigrations(false)

    fun copyMangas() = finishMigrations(true)

    private fun finishMigrations(copy: Boolean) {
        launchUI {
            val adapter = adapter ?: return@launchUI
            val kept = adapter.performMigrations(copy)
            if (kept.isEmpty()) {
                navigateOut()
                return@launchUI
            }
            // Only the series that could not be migrated stay on screen, to be retried.
            val keptItems = kept.map { it.first }
            adapter.currentItems.toList().forEach { item ->
                if (keptItems.none { it === item }) {
                    val position = adapter.currentItems.indexOf(item)
                    if (position >= 0) adapter.removeManga(position)
                }
            }
            showChaptersMissing(
                kept.map { (item, reason) ->
                    val target = item.manga.searchResult.content?.let { getManga.awaitById(it) }
                    (target?.title ?: item.manga.manga()?.title.orEmpty()) to reason
                },
            )
        }
    }

    fun showChaptersMissing(series: List<Pair<String, String>>) {
        val activity = activity ?: return
        activity.materialAlertDialog()
            .setTitle(MR.strings.migration_chapters_missing_title)
            .setMessage(
                activity.getString(MR.strings.migration_chapters_missing_message) + "\n\n" +
                    series.joinToString("\n") { (title, reason) -> "• $title: $reason" },
            )
            .setPositiveButton(AR.string.ok, null)
            .show()
    }

    private fun navigateOut() {
        if (migratingManga?.size == 1) {
            launchUI {
                val hasDetails = router.backstack.any { it.controller is MangaDetailsController }
                if (hasDetails) {
                    val manga = migratingManga?.firstOrNull()?.searchResult?.get()?.let { getManga.awaitById(it) }
                    if (manga != null) {
                        val newStack = router.backstack.filter {
                            it.controller !is MangaDetailsController &&
                                it.controller !is MigrationListController &&
                                it.controller !is PreMigrationController
                        } + MangaDetailsController(manga).withFadeTransaction()
                        router.setBackstack(newStack, FadeChangeHandler())
                        return@launchUI
                    }
                }
                router.popCurrentController()
            }
        } else {
            router.popCurrentController()
        }
    }

    override fun handleBack(): Boolean {
        view?.let { view ->
            if (view.translationX != 0f || view.scaleX != 1f || view.alpha != 1f) {
                // The gesture previewed a pop that a confirmation dialog may still refuse.
                PredictiveBackPreview.cancel(view, previousController?.view, activityBinding?.appBar)
            }
        }
        activity?.materialAlertDialog()
            ?.setTitle(MR.strings.stop_migrating)
            ?.setPositiveButton(MR.strings.stop) { _, _ ->
                router.popCurrentController()
                migrationsJob?.cancel()
            }
            ?.setNegativeButton(AR.string.cancel, null)?.show()
        return true
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        inflater.inflate(R.menu.migration_list, menu)
    }

    override fun onPrepareOptionsMenu(menu: Menu) {
        // Initialize menu items.

        val allMangasDone = adapter?.allMangasDone() ?: return

        val menuCopy = menu.findItem(R.id.action_copy_manga)
        val menuMigrate = menu.findItem(R.id.action_migrate_manga)

        if (adapter?.itemCount == 1) {
            menuMigrate.icon = VectorDrawableCompat.create(
                resources!!,
                R.drawable.ic_done_24dp,
                null,
            )
        }

        menuCopy.icon?.mutate()
        menuMigrate.icon?.mutate()
        val tintColor = activity?.getResourceColor(R.attr.actionBarTintColor) ?: Color.WHITE
        val translucentWhite = ColorUtils.setAlphaComponent(tintColor, 127)
        menuCopy.icon?.setTint(if (allMangasDone) tintColor else translucentWhite)
        menuMigrate?.icon?.setTint(if (allMangasDone) tintColor else translucentWhite)
        menuCopy.isEnabled = allMangasDone
        menuMigrate.isEnabled = allMangasDone
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        val totalManga = adapter?.itemCount ?: 0
        val mangaSkipped = adapter?.mangasSkipped() ?: 0
        when (item.itemId) {
            R.id.action_copy_manga, R.id.action_migrate_manga -> {
                showCopyMigrateDialog(
                    R.id.action_copy_manga == item.itemId,
                    totalManga,
                    mangaSkipped,
                )
            }
            else -> return super.onOptionsItemSelected(item)
        }
        return true
    }

    private fun showCopyMigrateDialog(copy: Boolean, totalManga: Int, mangaSkipped: Int) {
        val activity = activity ?: return
        val confirmRes = if (copy) MR.plurals.copy_manga else MR.plurals.migrate_manga
        val skipping by lazy { activity.getString(MR.strings.skipping_, mangaSkipped) }
        val additionalString = if (mangaSkipped > 0) " $skipping" else ""
        val confirmString = activity.getString(
            confirmRes,
            totalManga,
            totalManga,
            additionalString,
        )
        activity.materialAlertDialog()
            .setMessage(confirmString)
            .setPositiveButton(if (copy) MR.strings.copy_value else MR.strings.migrate) { _, _ ->
                if (copy) {
                    copyMangas()
                } else {
                    migrateMangas()
                }
            }
            .setNegativeButton(AR.string.cancel, null)
            .show()
    }

    override fun canChangeTabs(block: () -> Unit): Boolean {
        if (migrationsJob?.isCancelled == false || adapter?.allMangasDone() == true) {
            activity?.materialAlertDialog()
                ?.setTitle(MR.strings.stop_migrating)
                ?.setPositiveButton(MR.strings.stop) { _, _ ->
                    block()
                    migrationsJob?.cancel()
                }
                ?.setNegativeButton(AR.string.cancel, null)
            return false
        }
        return true
    }

    override fun handleOnBackProgressed(backEvent: BackEventCompat) {
        super.handleOnBackProgressed(backEvent)
        if (router.backstackSize > 1 && isControllerVisible) {
            router.backstack[router.backstackSize - 2].controller.view?.let { view2 ->
                view2.alpha = 0f
                view2.x = 0f
            }
        }
    }


    companion object {
        const val CONFIG_EXTRA = "config_extra"
        const val TAG = "migration_list"

        // Comix reads chapter pages through a WebView with its own two-minute limit.
        private const val CHAPTERS_TIMEOUT_MS = 150_000L
        private const val DETAILS_TIMEOUT_MS = 30_000L

        fun create(config: MigrationProcedureConfig): MigrationListController {
            return MigrationListController(
                Bundle().apply {
                    putParcelable(CONFIG_EXTRA, config)
                },
            )
        }
    }
}
