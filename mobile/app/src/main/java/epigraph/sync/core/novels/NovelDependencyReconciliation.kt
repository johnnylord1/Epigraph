package epigraph.sync.core.novels

import epigraph.sync.core.novels.NovelDependencyBaselineEntry.Kind
import epigraph.sync.core.protocol.EpigraphCoreEntityType

/**
 * Decides how this device and the Core become one list again, without touching either.
 *
 * Only entries in the baseline, held by both sides before, are ever removed. A Core tombstone for
 * one means the other device removed it; its absence here means this device removed it.
 */
internal object NovelDependencyReconciliation {
    data class RemoteRemovals(
        /** Plugin ids to uninstall here. */
        val pluginIds: List<String>,
        /** Canonical repository URLs to remove here. */
        val repositoryUrls: List<String>,
        /** Baseline entries that are settled by this pass, whether removed or kept. */
        val settledEntityIds: Set<String>,
    )

    data class Deletion(val entityType: String, val entityId: String)

    /**
     * Deletes the Core confirmed for entries both sides held. [installedAt] gives when a plugin's
     * artifact was written here, 0 when it is missing; written after the delete, it is a newer
     * install that is kept and published again.
     */
    fun remoteRemovals(
        core: CoreNovelDependencyManifest,
        agreed: Map<String, NovelDependencyBaselineEntry>,
        includeRepositories: Boolean,
        includePlugins: Boolean,
        installedAt: (pluginId: String) -> Long,
    ): RemoteRemovals {
        val deleted = agreed.values.filter { it.entityId in core.removed }
        val plugins = deleted.takeIf { includePlugins }.orEmpty().filter { it.kind == Kind.PLUGIN }
        val repositories = deleted.takeIf { includeRepositories }.orEmpty().filter { it.kind == Kind.REPOSITORY }
        return RemoteRemovals(
            pluginIds = plugins
                .filter { entry ->
                    val written = installedAt(entry.key)
                    written != 0L && written <= core.removed.getValue(entry.entityId)
                }
                .map(NovelDependencyBaselineEntry::key)
                .distinct(),
            repositoryUrls = repositories.map(NovelDependencyBaselineEntry::key).distinct(),
            settledEntityIds = (plugins + repositories).mapTo(mutableSetOf()) { it.entityId },
        )
    }

    /**
     * Core deletes for entries both sides held that are gone here, plugins first. A repository
     * takes its Core plugins with it, as the Core keeps no plugin without its repository; when
     * those plugins cannot be judged in this pass, the repository waits.
     */
    fun localDeletions(
        core: CoreNovelDependencyManifest,
        agreed: Map<String, NovelDependencyBaselineEntry>,
        localRepositoryIds: Set<String>,
        installedPluginIds: Set<String>?,
        includeRepositories: Boolean,
        includePlugins: Boolean,
    ): List<Deletion> {
        val corePlugins = core.plugins.associateBy(::entityId)
        val pluginsJudged = includePlugins && installedPluginIds != null
        val plugins = linkedSetOf<String>()
        val repositories = linkedSetOf<String>()
        if (pluginsJudged) {
            corePlugins.forEach { (entityId, plugin) ->
                if (agreed[entityId]?.kind == Kind.PLUGIN && plugin.pluginId !in installedPluginIds!!) {
                    plugins += entityId
                }
            }
        }
        if (includeRepositories) {
            core.repositories.forEach { repository ->
                val id = repository.repositoryId
                if (agreed[id]?.kind != Kind.REPOSITORY || id in localRepositoryIds) return@forEach
                val owned = corePlugins.filterValues { it.repositoryId == id }.keys
                if (owned.isNotEmpty() && !pluginsJudged) return@forEach
                plugins += owned
                repositories += id
            }
        }
        return plugins.map { Deletion(EpigraphCoreEntityType.NOVEL_PLUGIN, it) } +
            repositories.map { Deletion(EpigraphCoreEntityType.NOVEL_REPOSITORY, it) }
    }

    /**
     * Entries both sides hold after this pass. Kinds this pass did not reconcile, or could not
     * read, keep their previous entries, and so does a delete that could not be queued yet.
     */
    fun nextBaseline(
        core: CoreNovelDependencyManifest,
        agreed: Map<String, NovelDependencyBaselineEntry>,
        localRepositoryIds: Set<String>,
        installedPluginIds: Set<String>?,
        deletedEntityIds: Set<String>,
        pendingDeletionIds: Set<String>,
        includeRepositories: Boolean,
        includePlugins: Boolean,
    ): List<NovelDependencyBaselineEntry> {
        val next = agreed.values.filterTo(mutableListOf()) { it.entityId in pendingDeletionIds }
        if (includeRepositories) {
            core.repositories
                .filter { it.repositoryId !in deletedEntityIds && it.repositoryId in localRepositoryIds }
                .mapTo(next) { NovelDependencyBaselineEntry(it.repositoryId, Kind.REPOSITORY, it.canonicalUrl) }
        } else {
            agreed.values.filterTo(next) { it.kind == Kind.REPOSITORY }
        }
        if (includePlugins && installedPluginIds != null) {
            core.plugins
                .map { entityId(it) to it }
                .filter { (entityId, plugin) -> entityId !in deletedEntityIds && plugin.pluginId in installedPluginIds }
                .mapTo(next) { (entityId, plugin) -> NovelDependencyBaselineEntry(entityId, Kind.PLUGIN, plugin.pluginId) }
        } else {
            agreed.values.filterTo(next) { it.kind == Kind.PLUGIN && it.entityId !in deletedEntityIds }
        }
        return next.distinctBy(NovelDependencyBaselineEntry::entityId)
    }

    fun entityId(plugin: CoreNovelPluginRequirement): String =
        CoreNovelDependencyIds.pluginId(plugin.repositoryId, plugin.pluginId, plugin.sourceId)
}
