package epigraph.sync.core.suwayomi

import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionReconciliationStore
import yokai.data.Database

/**
 * Names the native extension a Core-bridged comic is waiting for.
 *
 * A comic lands on [EpigraphCoreSource] when the desktop's Suwayomi source is not installed on
 * this device. The source binding still records the desktop package and source ID, so the UI can
 * say which extension would move the work off the bridge instead of only showing "Epigraph Core".
 */
class EpigraphCoreBridgeLabeler(
    private val database: Database,
    private val extensionReports: ExtensionReconciliationStore,
) {
    fun waitingExtensionName(mangaId: Long): String? {
        val queries = database.aethon_syncQueries
        val identity = queries.selectIdentityByLocalReference(MANGA_CONTENT_TYPE, mangaId.toString())
            .executeAsOneOrNull() ?: return null
        val binding = queries.selectBindingsByEntityId(identity.entity_id).executeAsList()
            .firstOrNull { it.ecosystem == SUWAYOMI_ECOSYSTEM } ?: return null
        return resolveExtensionName(binding.plugin_package, binding.source_id, extensionReports.all())
    }

    internal companion object {
        private const val MANGA_CONTENT_TYPE = "MANGA"
        private const val SUWAYOMI_ECOSYSTEM = "SUWAYOMI"
        private const val UNKNOWN_PACKAGE = "unknown"

        /** Prefers the desktop inventory's display name, then a readable package suffix. */
        fun resolveExtensionName(
            pluginPackage: String,
            sourceId: String,
            reports: List<ExtensionParityReport>,
        ): String? {
            val numericSourceId = sourceId.toLongOrNull()
            val items = reports.flatMap { it.items }
            val item = items.firstOrNull { numericSourceId != null && numericSourceId in it.sourceIds }
                ?: items.firstOrNull { it.packageName == pluginPackage }
            item?.displayName?.takeIf(String::isNotBlank)?.let { return it }
            if (pluginPackage.isBlank() || pluginPackage == UNKNOWN_PACKAGE) return null
            return pluginPackage.substringAfterLast('.').takeIf(String::isNotBlank)
        }
    }
}
