package epigraph.sync.core.novels

import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.Serializable

@Serializable
enum class LnReaderRepositoryParityStatus {
    INSTALLED,
    APPROVAL_REQUIRED,
}

@Serializable
enum class LnReaderPluginParityStatus {
    INSTALLED,
    UPDATE_AVAILABLE,
    MISSING_AVAILABLE,
    MISSING_UNAVAILABLE,
    IDENTITY_MISMATCH,
    UNTRUSTED_OR_BLOCKED,
}

@Serializable
data class LnReaderRepositoryInventoryItem(
    val requirement: CoreNovelRepositoryRequirement,
    val status: LnReaderRepositoryParityStatus,
    val configuredIndexUrl: String?,
)

@Serializable
data class LnReaderPluginInventoryItem(
    val requirement: CoreNovelPluginRequirement,
    val status: LnReaderPluginParityStatus,
    val installedVersion: String?,
    val availableVersion: String?,
)

@Serializable
data class LnReaderDependencyInventory(
    val serverId: String,
    val profileId: String,
    val generatedAtMs: Long,
    val fingerprint: String,
    val repositories: List<LnReaderRepositoryInventoryItem>,
    val plugins: List<LnReaderPluginInventoryItem>,
)

interface LnReaderDependencyInventoryStore {
    suspend fun replace(inventory: LnReaderDependencyInventory)
    suspend fun get(serverId: String, profileId: String): LnReaderDependencyInventory?
}

/** Process-local inventory. A persistent implementation can replace it without changing sync semantics. */
class InMemoryLnReaderDependencyInventoryStore : LnReaderDependencyInventoryStore {
    private val inventories = ConcurrentHashMap<String, LnReaderDependencyInventory>()

    override suspend fun replace(inventory: LnReaderDependencyInventory) {
        inventories[key(inventory.serverId, inventory.profileId)] = inventory
    }

    override suspend fun get(serverId: String, profileId: String): LnReaderDependencyInventory? =
        inventories[key(serverId, profileId)]

    private fun key(serverId: String, profileId: String): String = "$serverId\u0000$profileId"
}

internal fun CoreNovelDependencyManifest.fingerprint(): String {
    val canonical = buildString {
        repositories.sortedBy { it.repositoryId }.forEach { repository ->
            append("repository|")
            append(repository.repositoryId).append('|')
            append(repository.canonicalUrl).append('|')
            append(repository.enabled).append('\n')
        }
        plugins.sortedWith(compareBy({ it.repositoryId }, { it.pluginId }, { it.sourceId })).forEach { plugin ->
            append("plugin|")
            append(plugin.repositoryId).append('|')
            append(plugin.pluginId).append('|')
            append(plugin.sourceId).append('|')
            append(plugin.version).append('|')
            append(plugin.artifactSha256).append('|')
            append(plugin.artifactByteLength).append('|')
            append(plugin.enabled).append('\n')
        }
    }
    return MessageDigest.getInstance("SHA-256")
        .digest(canonical.encodeToByteArray())
        .joinToString("") { byte -> "%02x".format(byte) }
}

internal fun String.matchesDeclaredRepository(declaredUrl: String): Boolean {
    val configured = trim().trimEnd('/')
    val declared = declaredUrl.trim().trimEnd('/')
    if (configured == declared) return true
    if (declared.endsWith(".json", ignoreCase = true)) return false
    return configured == "$declared/plugins.min.json" || configured == "$declared/index.min.json"
}
