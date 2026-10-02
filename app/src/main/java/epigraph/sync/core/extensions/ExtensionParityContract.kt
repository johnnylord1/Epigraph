package epigraph.sync.core.extensions

import kotlinx.serialization.Serializable

@Serializable
enum class ExtensionParityStatus {
    INSTALLED,
    INSTALLED_UPDATE_AVAILABLE,
    MISSING_AVAILABLE,
    MISSING_UNAVAILABLE,
    REPOSITORY_APPROVAL_REQUIRED,
    SOURCE_ID_MISMATCH,
    UNTRUSTED_OR_BLOCKED,
}

@Serializable
data class ExtensionParityItem(
    val packageName: String,
    val displayName: String,
    val desktopVersionName: String,
    val mobileVersionName: String?,
    val sourceNames: List<String>,
    val sourceIds: List<Long>,
    val storeIndexUrl: String? = null,
    val repositoryHintUrl: String? = null,
    val status: ExtensionParityStatus,
)

@Serializable
data class ExtensionParityReport(
    val schemaVersion: Int = 2,
    val serverId: String,
    val profileId: String,
    val inventoryHash: String,
    val generatedAtMs: Long,
    val items: List<ExtensionParityItem>,
) {
    val installedCount: Int
        get() = items.count {
            it.status == ExtensionParityStatus.INSTALLED ||
                it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
        }

    val availableToInstallCount: Int
        get() = items.count { it.status == ExtensionParityStatus.MISSING_AVAILABLE }

    /** Missing packages plus explicit updates that can be offered to the user. */
    val installableCount: Int
        get() = items.count {
            it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
        }

    val unavailableCount: Int
        get() = items.size - installedCount - availableToInstallCount

    /** Whether the sync can still act on this inventory (add repos / install / trust). */
    val hasActionableItems: Boolean
        get() = items.any {
            it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE ||
                it.status == ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED ||
                it.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED ||
                it.status == ExtensionParityStatus.SOURCE_ID_MISMATCH
        }
}

internal data class MobileInstalledExtension(
    val packageName: String,
    val versionCode: Long,
    val versionName: String,
    val sourceIds: Set<Long>,
)

internal data class MobileAvailableExtension(
    val packageName: String,
    val versionCode: Long,
    val versionName: String,
    val sourceIds: Set<Long>,
)

/**
 * One row for the "desktop repositories" setup screen: an installable index URL, a short
 * human-readable label, and whether this phone already has the repository configured.
 */
data class ComicRepositoryRow(
    /** Installable index URL, already normalized with ExtensionParityResolver.repositoryIndexUrl. */
    val indexUrl: String,
    /** Short label, e.g. "keiyoushi" for https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json */
    val name: String,
    val added: Boolean,
)
