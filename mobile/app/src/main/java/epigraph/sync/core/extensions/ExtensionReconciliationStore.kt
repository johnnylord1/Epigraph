package epigraph.sync.core.extensions

import epigraph.sync.core.persistence.SqlDelightCoreIdentityInventoryStore
import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json

class ExtensionReconciliationStore(
    private val persistence: SqlDelightCoreIdentityInventoryStore,
    private val json: Json = DEFAULT_JSON,
) {
    @Synchronized
    fun save(report: ExtensionParityReport): Boolean {
        val encoded = json.encodeToString(ExtensionParityReport.serializer(), report)
        require(encoded.toByteArray(StandardCharsets.UTF_8).size <= MAX_REPORT_BYTES) {
            "extension reconciliation report exceeds the local UI-state limit"
        }
        return persistence.saveExtensionInventory(
            schemaVersion = report.schemaVersion.toLong(),
            serverId = report.serverId,
            profileId = report.profileId,
            inventoryHash = report.inventoryHash,
            reportJson = encoded,
            generatedAt = report.generatedAtMs,
        )
    }

    @Synchronized
    fun markNotified(report: ExtensionParityReport) {
        persistence.markExtensionInventoryNotified(report.serverId, report.profileId, report.inventoryHash)
    }

    @Synchronized
    fun acknowledge(report: ExtensionParityReport) {
        persistence.acknowledgeExtensionInventory(report.serverId, report.profileId, report.inventoryHash)
    }

    @Synchronized
    fun latest(): ExtensionParityReport? {
        val cached = persistence.latestExtensionInventory() ?: return null
        return decode(cached)
    }

    @Synchronized
    fun all(): List<ExtensionParityReport> = persistence.extensionInventories().mapNotNull(::decode)

    private fun decode(
        cached: epigraph.sync.core.persistence.CoreExtensionInventoryCacheRecord,
    ): ExtensionParityReport? = runCatching {
        json.decodeFromString<ExtensionParityReport>(cached.reportJson)
    }.getOrNull()?.takeIf { report ->
        report.schemaVersion.toLong() == cached.schemaVersion &&
            report.serverId == cached.serverId &&
            report.profileId == cached.profileId &&
            report.inventoryHash == cached.inventoryHash
    }

    private companion object {
        const val MAX_REPORT_BYTES = 512 * 1024
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
