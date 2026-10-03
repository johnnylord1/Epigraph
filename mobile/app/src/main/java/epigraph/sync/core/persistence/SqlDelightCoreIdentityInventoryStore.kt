package epigraph.sync.core.persistence

import yokai.data.Database

enum class CoreRemoteBindingStatus {
    BOUND,
    LEGACY_UNBOUND,
    PENDING,
    CONFLICT,
}

data class CoreRemoteIdentityRecord(
    val entityId: String,
    val serverId: String,
    val profileId: String,
    val remoteType: String,
    val remoteId: String,
    val bindingStatus: CoreRemoteBindingStatus,
    val updatedAt: Long,
)

data class CoreExtensionInventoryCacheRecord(
    val serverId: String,
    val profileId: String,
    val schemaVersion: Long,
    val inventoryHash: String,
    val reportJson: String,
    val generatedAt: Long,
    val notifiedInventoryHash: String?,
    val acknowledgedInventoryHash: String?,
    val updatedAt: Long,
)

class SqlDelightCoreIdentityInventoryStore(
    private val database: Database,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    fun upsertRemoteIdentity(record: CoreRemoteIdentityRecord) {
        require(record.entityId.isNotBlank()) { "entityId must not be blank" }
        require(record.serverId.isNotBlank()) { "serverId must not be blank" }
        require(record.profileId.isNotBlank()) { "profileId must not be blank" }
        require(record.remoteType.isNotBlank()) { "remoteType must not be blank" }
        require(record.remoteId.isNotBlank()) { "remoteId must not be blank" }
        require(record.updatedAt >= 0) { "updatedAt must not be negative" }
        database.aethon_syncQueries.upsertCoreRemoteIdentity(
            entityId = record.entityId,
            serverId = record.serverId,
            profileId = record.profileId,
            remoteType = record.remoteType,
            remoteId = record.remoteId,
            bindingStatus = record.bindingStatus.name,
            updatedAt = record.updatedAt,
        )
    }

    fun remoteIdentity(entityId: String): CoreRemoteIdentityRecord? = database.aethon_syncQueries
        .selectCoreRemoteIdentityByEntityId(entityId)
        .executeAsOneOrNull()
        ?.let(::mapRemoteIdentity)

    fun remoteIdentity(
        serverId: String,
        profileId: String,
        remoteType: String,
        remoteId: String,
    ): CoreRemoteIdentityRecord? = database.aethon_syncQueries
        .selectCoreRemoteIdentity(serverId, profileId, remoteType, remoteId)
        .executeAsOneOrNull()
        ?.let(::mapRemoteIdentity)

    fun saveExtensionInventory(
        schemaVersion: Long,
        serverId: String,
        profileId: String,
        inventoryHash: String,
        reportJson: String,
        generatedAt: Long,
    ): Boolean {
        require(schemaVersion >= 1) { "schemaVersion must be positive" }
        require(serverId.isNotBlank()) { "serverId must not be blank" }
        require(profileId.isNotBlank()) { "profileId must not be blank" }
        require(SHA256.matches(inventoryHash)) { "inventoryHash must be lowercase SHA-256" }
        require(reportJson.isNotBlank()) { "reportJson must not be blank" }
        require(generatedAt >= 0) { "generatedAt must not be negative" }
        return database.transactionWithResult {
            val previous = database.aethon_syncQueries
                .selectCoreExtensionInventoryCache(serverId, profileId)
                .executeAsOneOrNull()
            database.aethon_syncQueries.upsertCoreExtensionInventoryCache(
                serverId = serverId,
                profileId = profileId,
                schemaVersion = schemaVersion,
                inventoryHash = inventoryHash,
                reportJson = reportJson,
                generatedAt = generatedAt,
                updatedAt = clock().also { require(it >= 0) },
            )
            previous?.notified_inventory_hash != inventoryHash
        }
    }

    fun markExtensionInventoryNotified(serverId: String, profileId: String, inventoryHash: String) {
        require(SHA256.matches(inventoryHash)) { "inventoryHash must be lowercase SHA-256" }
        database.aethon_syncQueries.markCoreExtensionInventoryNotified(
            inventoryHash = inventoryHash,
            serverId = serverId,
            profileId = profileId,
        )
    }

    fun acknowledgeExtensionInventory(serverId: String, profileId: String, inventoryHash: String) {
        require(SHA256.matches(inventoryHash)) { "inventoryHash must be lowercase SHA-256" }
        database.aethon_syncQueries.acknowledgeCoreExtensionInventory(
            inventoryHash = inventoryHash,
            serverId = serverId,
            profileId = profileId,
        )
    }

    fun latestExtensionInventory(): CoreExtensionInventoryCacheRecord? = database.aethon_syncQueries
        .selectLatestCoreExtensionInventoryCache()
        .executeAsOneOrNull()
        ?.let(::mapExtensionInventory)

    fun extensionInventories(): List<CoreExtensionInventoryCacheRecord> = database.aethon_syncQueries
        .selectAllCoreExtensionInventoryCaches()
        .executeAsList()
        .map(::mapExtensionInventory)

    private fun mapExtensionInventory(row: tachiyomi.data.Aethon_core_extension_inventory_cache) =
        CoreExtensionInventoryCacheRecord(
            serverId = row.server_id,
            profileId = row.profile_id,
            schemaVersion = row.schema_version,
            inventoryHash = row.inventory_hash,
            reportJson = row.report_json,
            generatedAt = row.generated_at,
            notifiedInventoryHash = row.notified_inventory_hash,
            acknowledgedInventoryHash = row.acknowledged_inventory_hash,
            updatedAt = row.updated_at,
        )

    private fun mapRemoteIdentity(row: tachiyomi.data.Aethon_core_remote_identity) =
        CoreRemoteIdentityRecord(
            entityId = row.entity_id,
            serverId = row.server_id,
            profileId = row.profile_id,
            remoteType = row.remote_type,
            remoteId = row.remote_id,
            bindingStatus = CoreRemoteBindingStatus.valueOf(row.binding_status),
            updatedAt = row.updated_at,
        )

    private companion object {
        val SHA256 = Regex("[0-9a-f]{64}")
    }
}
