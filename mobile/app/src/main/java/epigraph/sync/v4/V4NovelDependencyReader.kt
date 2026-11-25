package epigraph.sync.v4

import epigraph.sync.core.novels.CoreNovelDependencyManifest
import epigraph.sync.core.novels.CoreNovelDependencyReader
import epigraph.sync.core.novels.CoreNovelPluginRequirement
import epigraph.sync.core.novels.CoreNovelRepositoryRequirement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import yokai.data.DatabaseHandler

/**
 * Reads LNReader novel repository and plugin requirements from Sync V4's `v4_entity_map`
 * (`domain = "extensions"`, `deleted = 0`).
 */
class V4NovelDependencyReader(
    private val handler: DatabaseHandler,
) : CoreNovelDependencyReader {
    override suspend fun read(scopeId: String): CoreNovelDependencyManifest {
        val profileId = scopeId.removePrefix("novels:profile:")
        val serverIds = handler.awaitList { v4_syncQueries.selectAllV4SyncStates() }
            .filter { it.profile_id == profileId }
            .map { it.server_id }
        val serverId = serverIds.firstOrNull() ?: return CoreNovelDependencyManifest(emptyList(), emptyList())
        return read(serverId, profileId)
    }

    suspend fun read(serverId: String, profileId: String): CoreNovelDependencyManifest {
        val rows = handler.awaitList {
            v4_syncQueries.selectV4ActiveDomainEntityMap(
                serverId = serverId,
                profileId = profileId,
                domain = V4ExtensionInventoryBridge.DOMAIN,
            )
        }
        val repositories = mutableListOf<CoreNovelRepositoryRequirement>()
        val plugins = mutableListOf<CoreNovelPluginRequirement>()

        // Also include locally configured novel_repos so V4-synced repos are always available.
        val localNovelRepos = handler.awaitList { novel_reposQueries.findAll() }
        for (repo in localNovelRepos) {
            val baseUrl = repo.base_url.trim().trimEnd('/')
            if (baseUrl.isEmpty()) continue
            repositories += CoreNovelRepositoryRequirement(
                repositoryId = baseUrl,
                canonicalUrl = baseUrl,
                displayName = repo.name.ifBlank { baseUrl },
                enabled = true,
            )
        }

        for (row in rows) {
            if (!row.entity_key.startsWith(NOVEL_PREFIX)) continue
            when (row.entity_type) {
                V4ExtensionInventoryBridge.INSTALLED -> {
                    val raw = row.payload_json ?: continue
                    val obj = runCatching { Json.parseToJsonElement(raw) as? JsonObject }.getOrNull() ?: continue
                    if (obj.str("kind") != "novel") continue
                    val pluginId = obj.str("packageId") ?: row.entity_key.removePrefix(NOVEL_PREFIX).trim()
                    if (pluginId.isEmpty()) continue
                    val version = obj.str("versionName").orEmpty()
                    plugins += CoreNovelPluginRequirement(
                        repositoryId = obj.str("repoUrl").orEmpty(),
                        pluginId = pluginId,
                        sourceId = pluginId,
                        version = version,
                        enabled = true,
                        artifactSha256 = "",
                        artifactByteLength = 0L,
                        name = obj.str("name").orEmpty(),
                        lang = obj.str("lang").orEmpty(),
                    )
                }
            }
        }

        return CoreNovelDependencyManifest(
            repositories = repositories.distinctBy(CoreNovelRepositoryRequirement::repositoryId),
            plugins = plugins.distinctBy(CoreNovelPluginRequirement::pluginId),
        )
    }

    private fun JsonObject.str(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull?.trim()?.takeIf(String::isNotEmpty)

    private companion object {
        const val NOVEL_PREFIX = "novel:"
    }
}
