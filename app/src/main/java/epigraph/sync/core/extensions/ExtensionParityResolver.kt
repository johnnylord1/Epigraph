package epigraph.sync.core.extensions

import epigraph.sync.core.protocol.CoreExtensionDescriptor
import epigraph.sync.core.protocol.CoreExtensionInventory
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal object ExtensionParityResolver {
    fun resolve(
        inventory: CoreExtensionInventory,
        installed: List<MobileInstalledExtension>,
        available: List<MobileAvailableExtension>,
        untrustedPackages: Set<String>,
        configuredRepositoryBaseUrls: Set<String> = emptySet(),
    ): ExtensionParityReport {
        val installedByPackage = installed.associateBy { it.packageName }
        val availableByPackage = available
            .groupBy { it.packageName }
            .mapValues { (_, values) -> values.maxBy { it.versionCode } }
        val descriptors = inventory.extensions
            .groupBy { it.packageName }
            .map { (_, values) -> mergeDescriptors(values) }
            .sortedBy { it.packageName }

        return ExtensionParityReport(
            serverId = inventory.serverId,
            profileId = inventory.profileId,
            inventoryHash = inventoryHash(inventory.serverId, inventory.profileId, descriptors),
            generatedAtMs = inventory.generatedAtMs,
            items = descriptors.map { desktop ->
                val repositoryHintUrl = desktop.storeIndexUrl ?: desktop.legacyRepositoryIndexUrl
                val mobileInstalled = installedByPackage[desktop.packageName]
                val mobileAvailable = availableByPackage[desktop.packageName]
                val expectedSourceIds = desktop.sources.mapTo(mutableSetOf()) { source ->
                    requireNotNull(source.id.toLongOrNull()) { "extension source ID must fit signed 64-bit storage" }
                }
                val status = when {
                    mobileInstalled != null && expectedSourceIds.isNotEmpty() &&
                        mobileInstalled.sourceIds.intersect(expectedSourceIds).isEmpty() -> {
                        ExtensionParityStatus.SOURCE_ID_MISMATCH
                    }
                    mobileInstalled != null && mobileAvailable != null &&
                        mobileAvailable.versionCode > mobileInstalled.versionCode -> {
                        ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                    }
                    mobileInstalled != null -> ExtensionParityStatus.INSTALLED
                    desktop.packageName in untrustedPackages -> ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
                    mobileAvailable != null -> ExtensionParityStatus.MISSING_AVAILABLE
                    repositoryHintUrl != null &&
                        repositoryBaseUrl(repositoryHintUrl) !in configuredRepositoryBaseUrls ->
                        ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED
                    else -> ExtensionParityStatus.MISSING_UNAVAILABLE
                }
                ExtensionParityItem(
                    packageName = desktop.packageName,
                    displayName = desktop.displayName,
                    desktopVersionName = desktop.versionName,
                    mobileVersionName = mobileInstalled?.versionName ?: mobileAvailable?.versionName,
                    sourceNames = desktop.sources.map { it.name }.distinct().sorted(),
                    sourceIds = expectedSourceIds.sorted(),
                    storeIndexUrl = desktop.storeIndexUrl,
                    repositoryHintUrl = repositoryHintUrl,
                    status = status,
                )
            },
        )
    }

    private fun mergeDescriptors(values: List<CoreExtensionDescriptor>): CoreExtensionDescriptor {
        val preferred = values.maxWithOrNull(
            compareBy<CoreExtensionDescriptor> { it.versionCode.toLongOrNull() ?: Long.MIN_VALUE }
                .thenBy { it.versionCode }
                .thenBy { it.versionName },
        ) ?: error("extension descriptor group must not be empty")
        return preferred.copy(
            sources = values.flatMap { it.sources }.distinctBy { it.id }.sortedBy { it.id },
        )
    }

    private fun inventoryHash(
        serverId: String,
        profileId: String,
        descriptors: List<CoreExtensionDescriptor>,
    ): String {
        val canonical = buildString {
            append(serverId).append('\u0000').append(profileId).append('\n')
            descriptors.forEach { extension ->
                append(extension.packageName).append('\u0000')
                append(extension.versionCode).append('\u0000')
                append(extension.versionName).append('\n')
                append(extension.storeIndexUrl.orEmpty()).append('\n')
                append(extension.legacyRepositoryIndexUrl.orEmpty()).append('\n')
                extension.sources.sortedBy { it.id }.forEach { source ->
                    append(source.id).append('\u0000')
                    append(source.name).append('\u0000')
                    append(source.lang).append('\n')
                }
            }
        }
        return MessageDigest.getInstance("SHA-256")
            .digest(canonical.toByteArray(StandardCharsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }

    internal fun repositoryBaseUrl(indexUrl: String): String {
        val base = indexUrl
            .trimEnd('/')
            .removeSuffix("/index.min.json")
            .removeSuffix("/index.json")
            .removeSuffix("/index.pb")
        return runCatching {
            val uri = URI(base)
            val segments = uri.path.trim('/').split('/').filter(String::isNotEmpty)
            if (
                uri.scheme.equals("https", ignoreCase = true) &&
                uri.host.equals("github.com", ignoreCase = true) &&
                segments.size >= 4 && segments[2] == "raw"
            ) {
                "https://raw.githubusercontent.com/${segments[0]}/${segments[1]}/" +
                    segments.drop(3).joinToString("/")
            } else base
        }.getOrDefault(base)
    }

    internal fun repositoryIndexUrl(indexUrl: String): String {
        val fileName = if (indexUrl.endsWith("/index.json")) "index.json" else "index.min.json"
        return "${repositoryBaseUrl(indexUrl)}/$fileName"
    }
}
