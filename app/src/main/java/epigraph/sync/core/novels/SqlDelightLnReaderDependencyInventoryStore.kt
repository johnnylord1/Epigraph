package epigraph.sync.core.novels

import java.nio.charset.StandardCharsets
import kotlinx.serialization.json.Json
import yokai.data.Database

class SqlDelightLnReaderDependencyInventoryStore(
    private val database: Database,
    private val json: Json = DEFAULT_JSON,
    private val clock: () -> Long = System::currentTimeMillis,
) : LnReaderDependencyInventoryStore {
    override suspend fun replace(inventory: LnReaderDependencyInventory) {
        val normalized = inventory.copy(
            repositories = inventory.repositories.sortedBy { it.requirement.repositoryId },
            plugins = inventory.plugins.sortedWith(
                compareBy({ it.requirement.repositoryId }, { it.requirement.pluginId }),
            ),
        )
        val encoded = json.encodeToString(LnReaderDependencyInventory.serializer(), normalized)
        require(encoded.toByteArray(StandardCharsets.UTF_8).size <= MAX_INVENTORY_BYTES) {
            "LNReader dependency inventory exceeds the local cache limit"
        }
        database.aethon_syncQueries.upsertCoreNovelDependencyInventoryCache(
            serverId = normalized.serverId,
            profileId = normalized.profileId,
            schemaVersion = SCHEMA_VERSION,
            inventoryHash = normalized.fingerprint,
            inventoryJson = encoded,
            generatedAt = normalized.generatedAtMs,
            updatedAt = clock().also { require(it >= 0) },
        )
    }

    override suspend fun get(serverId: String, profileId: String): LnReaderDependencyInventory? {
        val cached = database.aethon_syncQueries
            .selectCoreNovelDependencyInventoryCache(serverId, profileId)
            .executeAsOneOrNull()
            ?: return null
        if (cached.schema_version != SCHEMA_VERSION) return null
        return runCatching {
            json.decodeFromString<LnReaderDependencyInventory>(cached.inventory_json)
        }.getOrNull()?.takeIf { inventory ->
            inventory.serverId == cached.server_id &&
                inventory.profileId == cached.profile_id &&
                inventory.fingerprint == cached.inventory_hash &&
                inventory.generatedAtMs == cached.generated_at
        }
    }

    private companion object {
        const val SCHEMA_VERSION = 1L
        const val MAX_INVENTORY_BYTES = 512 * 1024
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
