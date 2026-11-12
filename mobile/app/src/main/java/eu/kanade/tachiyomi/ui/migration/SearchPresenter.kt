package eu.kanade.tachiyomi.ui.migration

import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.model.MangasPage
import eu.kanade.tachiyomi.smartsearch.SmartSearchEngine
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchItem
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchMangaItem
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchPresenter

class SearchPresenter(
    initialQuery: String? = "",
    private val originalSource: Long,
    sources: List<CatalogueSource>? = null,
    extraSearchParams: String? = null,
    private val alternativeTitles: List<String> = emptyList(),
) : GlobalSearchPresenter(initialQuery, sourcesToUse = sources) {

    private val originalQuery = initialQuery
    private val searchEngine = SmartSearchEngine(presenterScope.coroutineContext, extraSearchParams)

    override suspend fun searchManga(source: CatalogueSource, query: String): MangasPage {
        val result = searchEngine.search(source, query, alternativeTitles.takeIf { query == originalQuery }.orEmpty())
        if (result.candidates.isEmpty()) result.failure?.let { throw it }
        return MangasPage(result.candidates, false)
    }

    override fun getEnabledSources(): List<CatalogueSource> {
        // Put the source of the selected manga at the top
        return super.getEnabledSources()
            .sortedByDescending { it.id == originalSource }
    }

    override fun createCatalogueSearchItem(source: CatalogueSource, results: List<GlobalSearchMangaItem>?): GlobalSearchItem {
        // Set the catalogue search item as highlighted if the source matches that of the selected manga
        return GlobalSearchItem(source, results, source.id == originalSource)
    }
}
