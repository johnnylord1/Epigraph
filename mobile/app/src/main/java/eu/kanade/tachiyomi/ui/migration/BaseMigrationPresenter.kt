package eu.kanade.tachiyomi.ui.migration

import yokai.util.koin.get
import eu.kanade.tachiyomi.data.preference.PreferenceValues
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.LocalSource
import eu.kanade.tachiyomi.source.Source
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.isNovelSource
import eu.kanade.tachiyomi.ui.base.presenter.BaseCoroutinePresenter
import eu.kanade.tachiyomi.ui.source.BrowseSourceType
import eu.kanade.tachiyomi.util.system.withUIContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yokai.util.koin.injectLazy
import yokai.domain.manga.interactor.GetManga
import yokai.domain.ui.UiPreferences

abstract class BaseMigrationPresenter<T : BaseMigrationInterface>(
    protected val sourceManager: SourceManager = get(),
    val uiPreferences: UiPreferences = get(),
    val preferences: PreferencesHelper = get(),
) : BaseCoroutinePresenter<T>() {
    private val getManga: GetManga by injectLazy()

    private var selectedSource: Pair<String, Long>? = null
    var sourceItems = emptyList<SourceItem>()
        protected set

    var mangaItems = hashMapOf<Long, List<MangaItem>>()
        protected set
    protected val extensionManager: ExtensionManager by injectLazy()

    /** Browse's Manga / Novel choice; only sources of this type are listed for migration. */
    val browseType: BrowseSourceType
        get() = BrowseSourceType.fromOrdinal(preferences.lastBrowseSourceType().get())

    fun setBrowseType(type: BrowseSourceType) {
        preferences.lastBrowseSourceType().set(type.ordinal)
    }

    override fun onCreate() {
        super.onCreate()
        preferences.lastBrowseSourceType().changes()
            .drop(1)
            .distinctUntilChanged()
            .onEach {
                selectedSource = null
                withUIContext { view?.onBrowseTypeChanged(browseType) }
                refreshMigrations()
            }
            .launchIn(presenterScope)
    }

    fun refreshMigrations() {
        presenterScope.launch {
            val favs = getManga.awaitFavorites()
            sourceItems = findSourcesWithManga(favs)
            mangaItems = HashMap(
                sourceItems.associate {
                    it.source.id to libraryToMigrationItem(favs, it.source.id)
                },
            )
            withContext(Dispatchers.Main) {
                if (selectedSource != null) {
                    view?.setMigrationManga(selectedSource!!.first, mangaItems[selectedSource!!.second])
                } else {
                    view?.setMigrationSources(sourceItems)
                }
            }
        }
    }

    private fun findSourcesWithManga(library: List<Manga>): List<SourceItem> {
        val header = SelectionHeader()
        val sourceGroup = library.groupBy { it.source }
        val sortOrder = PreferenceValues.MigrationSourceOrder.fromPreference(preferences)
        val novels = browseType == BrowseSourceType.Novel
        val extensions = extensionManager.installedExtensionsFlow.value
        val obsoleteSources =
            extensions.filter { it.isObsolete }.map { it.sources }.flatten().map { it.id }

        return sourceGroup
            .mapNotNull { if (it.key != LocalSource.ID) sourceManager.getOrStub(it.key) to it.value.size else null }
            .filter { it.first.isNovelSource() == novels }
            .sortedWith(
                compareBy(
                    {
                        when (sortOrder) {
                            PreferenceValues.MigrationSourceOrder.Alphabetically -> it.first.name
                            PreferenceValues.MigrationSourceOrder.MostEntries -> Long.MAX_VALUE - it.second
                            PreferenceValues.MigrationSourceOrder.Obsolete ->
                                it.first !is SourceManager.StubSource &&
                                    it.first.id !in obsoleteSources
                        }
                    },
                    { it.first.name },
                ),
            )
            .map {
                SourceItem(
                    it.first,
                    header,
                    it.second,
                    it.first is SourceManager.StubSource,
                    it.first.id in obsoleteSources,
                )
            }
    }

    private fun libraryToMigrationItem(library: List<Manga>, sourceId: Long): List<MangaItem> {
        return library.filter { it.source == sourceId }.map(::MangaItem)
    }

    protected suspend fun firstTimeMigration() {
        val favs = getManga.awaitFavorites()
        sourceItems = findSourcesWithManga(favs)
        mangaItems = HashMap(
            sourceItems.associate {
                it.source.id to libraryToMigrationItem(
                    favs,
                    it.source.id,
                )
            },
        )
        withContext(Dispatchers.Main) {
            if (selectedSource != null) {
                view?.setMigrationManga(selectedSource!!.first, mangaItems[selectedSource!!.second])
            } else {
                view?.setMigrationSources(sourceItems)
            }
        }
    }

    fun setSelectedSource(source: Source) {
        selectedSource = source.name to source.id
        presenterScope.launch {
            withUIContext { view?.setMigrationManga(source.name, mangaItems[source.id]) }
        }
    }

    fun deselectSource() {
        selectedSource = null
        presenterScope.launch {
            withUIContext { view?.setMigrationSources(sourceItems) }
        }
    }
}

interface BaseMigrationInterface {
    fun setMigrationManga(title: String, manga: List<MangaItem>?)
    fun setMigrationSources(sources: List<SourceItem>)

    /** Browse's Manga / Novel choice changed; the migration list follows it. */
    fun onBrowseTypeChanged(type: BrowseSourceType) {}
}
