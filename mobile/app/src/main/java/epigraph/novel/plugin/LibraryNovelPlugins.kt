package epigraph.novel.plugin

import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.source.NovelSource

/**
 * Desktop `RestoreNovelDependencies`: the repository plugins the library's novels wait for. A
 * restored LNReader backup keeps its novels under the source ids their plugins get here. The restore
 * installs them from the configured repositories; Browse offers the ones that failed with one tap.
 */
fun pluginsNeededByLibrary(
    librarySourceIds: Set<Long>,
    installedIds: Set<String>,
    available: List<NovelPluginIndex>,
): List<NovelPluginIndex> =
    available
        .filter { plugin ->
            plugin.id !in installedIds &&
                plugin.url.isNotBlank() &&
                NovelSource.sourceIdFor(plugin.id, NovelPluginManager.langFromLnReaderLang(plugin.lang)) in librarySourceIds
        }
        .distinctBy { it.id }
        .sortedBy { it.name }
