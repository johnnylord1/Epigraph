package epigraph.sync.core.policy

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.protocol.CoreCapabilities

data class EffectiveSyncPolicy(
    val selection: DeviceSyncSelectionV1,
    val selectedScopes: Set<String>,
    val syncComics: Boolean,
    val syncNovels: Boolean,
    val syncBooks: Boolean,
    val reconcileComicRepositories: Boolean,
    val reconcileComicExtensions: Boolean,
    val reconcileNovelRepositories: Boolean,
    val reconcileNovelPlugins: Boolean,
    val transferBookAssets: Boolean,
)

class SyncPolicyResolver(
    private val selections: DeviceSyncSelectionStore,
) {
    fun resolve(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        deviceId: String,
        grantedScopes: Collection<String> = credentials.scopes,
    ): EffectiveSyncPolicy {
        val selection = selections.load(credentials.serverId, credentials.profileId, deviceId)
            ?: DeviceSyncSelectionV1.defaults(
                credentials.serverId,
                credentials.profileId,
                deviceId,
            ).also(selections::upsert)
        val normalized = selection.normalized()
        val granted = grantedScopes.toSet()
        val comicsScope = "comics:profile:${credentials.profileId}"
        val novelsScope = "novels:profile:${credentials.profileId}"
        val booksScope = "books:global"
        val syncComics = SyncDomain.COMICS in normalized.enabledDomains &&
            comicsScope in granted && capabilities.supportsSuwayomiCatalog
        val syncNovels = SyncDomain.NOVELS in normalized.enabledDomains &&
            novelsScope in granted && capabilities.supportsSnapshot
        val syncBooks = SyncDomain.BOOKS in normalized.enabledDomains &&
            booksScope in granted && capabilities.supportsSnapshot
        val selectedScopes = buildSet {
            if (syncComics) add(comicsScope)
            if (syncNovels) add(novelsScope)
            if (syncBooks) add(booksScope)
        }
        return EffectiveSyncPolicy(
            selection = normalized,
            selectedScopes = selectedScopes,
            syncComics = syncComics,
            syncNovels = syncNovels,
            syncBooks = syncBooks,
            reconcileComicRepositories = syncComics &&
                normalized.comicRepositories == DependencyInventoryMode.INVENTORY_ONLY &&
                capabilities.supportsSuwayomiExtensionInventory,
            reconcileComicExtensions = syncComics &&
                normalized.comicExtensions == DependencyInventoryMode.INVENTORY_ONLY &&
                capabilities.supportsSuwayomiExtensionInventory,
            reconcileNovelRepositories = syncNovels &&
                normalized.novelRepositories == DependencyInventoryMode.INVENTORY_ONLY &&
                capabilities.supportsNovelPluginSync,
            reconcileNovelPlugins = syncNovels &&
                normalized.novelPlugins == DependencyInventoryMode.INVENTORY_ONLY &&
                capabilities.supportsNovelPluginSync,
            transferBookAssets = syncBooks && capabilities.supportsAssets,
        )
    }
}
