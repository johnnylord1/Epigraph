package epigraph.sync.core.pairing

import epigraph.sync.core.policy.BookAssetPolicy
import epigraph.sync.core.policy.DependencyInventoryMode
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import epigraph.sync.core.policy.SyncDomain

data class PairingSyncSelection(
    val enabledDomains: Set<SyncDomain>,
    val compareComicRepositories: Boolean = true,
    val compareComicExtensions: Boolean = true,
    val compareNovelRepositories: Boolean = true,
    val compareNovelPlugins: Boolean = true,
) {
    init {
        require(enabledDomains.isNotEmpty()) { "at least one sync domain must be enabled" }
    }

    fun toPersistedSelection(
        serverId: String,
        profileId: String,
        deviceId: String,
        updatedAtMs: Long = System.currentTimeMillis(),
    ): DeviceSyncSelectionV1 = DeviceSyncSelectionV1(
        serverId = serverId,
        profileId = profileId,
        deviceId = deviceId,
        enabledDomains = enabledDomains,
        comicRepositories = inventoryMode(compareComicRepositories),
        comicExtensions = inventoryMode(compareComicExtensions),
        novelRepositories = inventoryMode(compareNovelRepositories),
        novelPlugins = inventoryMode(compareNovelPlugins),
        bookAssets = BookAssetPolicy.ON_DEMAND,
        updatedAtMs = updatedAtMs,
    ).normalized()

    private fun inventoryMode(enabled: Boolean): DependencyInventoryMode =
        if (enabled) DependencyInventoryMode.INVENTORY_ONLY else DependencyInventoryMode.DISABLED

    companion object {
        fun defaults(): PairingSyncSelection = PairingSyncSelection(SyncDomain.entries.toSet())
    }
}
