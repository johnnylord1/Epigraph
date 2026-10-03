package epigraph.sync.core.policy

enum class SyncDomain {
    COMICS,
    NOVELS,
    BOOKS,
}

enum class DependencyInventoryMode {
    DISABLED,
    INVENTORY_ONLY,
}

enum class BookAssetPolicy {
    ON_DEMAND,
}

data class DeviceSyncSelectionV1(
    val schemaVersion: Int = SCHEMA_VERSION,
    val serverId: String,
    val profileId: String,
    val deviceId: String,
    val enabledDomains: Set<SyncDomain>,
    val comicRepositories: DependencyInventoryMode,
    val comicExtensions: DependencyInventoryMode,
    val novelRepositories: DependencyInventoryMode,
    val novelPlugins: DependencyInventoryMode,
    val bookAssets: BookAssetPolicy,
    val updatedAtMs: Long,
) {
    init {
        require(schemaVersion == SCHEMA_VERSION) { "unsupported sync selection schema" }
        requireCanonicalIdentifier(serverId, "serverId")
        requireCanonicalIdentifier(profileId, "profileId")
        requireCanonicalIdentifier(deviceId, "deviceId")
        require(enabledDomains.isNotEmpty()) { "at least one sync domain must be enabled" }
        require(updatedAtMs >= 0) { "updatedAtMs must not be negative" }
    }

    /**
     * Removes dependent inventory work for disabled domains without changing persisted content.
     * Book assets currently have one safe policy: explicit, on-demand transfer.
     */
    fun normalized(): DeviceSyncSelectionV1 = copy(
        enabledDomains = enabledDomains.toSet(),
        comicRepositories = comicRepositories.takeIf { SyncDomain.COMICS in enabledDomains }
            ?: DependencyInventoryMode.DISABLED,
        comicExtensions = comicExtensions.takeIf { SyncDomain.COMICS in enabledDomains }
            ?: DependencyInventoryMode.DISABLED,
        novelRepositories = novelRepositories.takeIf { SyncDomain.NOVELS in enabledDomains }
            ?: DependencyInventoryMode.DISABLED,
        novelPlugins = novelPlugins.takeIf { SyncDomain.NOVELS in enabledDomains }
            ?: DependencyInventoryMode.DISABLED,
    )

    companion object {
        const val SCHEMA_VERSION = 1

        fun defaults(
            serverId: String,
            profileId: String,
            deviceId: String,
            updatedAtMs: Long = System.currentTimeMillis(),
        ): DeviceSyncSelectionV1 = DeviceSyncSelectionV1(
            serverId = serverId,
            profileId = profileId,
            deviceId = deviceId,
            enabledDomains = SyncDomain.entries.toSet(),
            comicRepositories = DependencyInventoryMode.INVENTORY_ONLY,
            comicExtensions = DependencyInventoryMode.INVENTORY_ONLY,
            novelRepositories = DependencyInventoryMode.INVENTORY_ONLY,
            novelPlugins = DependencyInventoryMode.INVENTORY_ONLY,
            bookAssets = BookAssetPolicy.ON_DEMAND,
            updatedAtMs = updatedAtMs,
        )

        private fun requireCanonicalIdentifier(value: String, label: String) {
            require(value.isNotBlank() && value == value.trim()) { "$label must be non-blank and canonical" }
            require(value.length <= MAX_IDENTIFIER_LENGTH) { "$label is too long" }
            require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
        }

        private const val MAX_IDENTIFIER_LENGTH = 256
    }
}
