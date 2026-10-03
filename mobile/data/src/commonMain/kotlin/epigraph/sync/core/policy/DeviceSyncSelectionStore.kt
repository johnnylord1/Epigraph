package epigraph.sync.core.policy

import yokai.data.Database

interface DeviceSyncSelectionStore {
    fun load(serverId: String, profileId: String, deviceId: String): DeviceSyncSelectionV1?

    fun upsert(selection: DeviceSyncSelectionV1)

    fun delete(serverId: String, profileId: String, deviceId: String)
}

class SqlDelightDeviceSyncSelectionStore(
    private val database: Database,
) : DeviceSyncSelectionStore {
    override fun load(serverId: String, profileId: String, deviceId: String): DeviceSyncSelectionV1? {
        requireIdentifier(serverId, "serverId")
        requireIdentifier(profileId, "profileId")
        requireIdentifier(deviceId, "deviceId")
        return database.aethon_syncQueries
            .selectDeviceSyncSelection(serverId, profileId, deviceId)
            .executeAsOneOrNull()
            ?.let { row ->
                DeviceSyncSelectionV1(
                    schemaVersion = row.schema_version.toInt(),
                    serverId = row.server_id,
                    profileId = row.profile_id,
                    deviceId = row.device_id,
                    enabledDomains = buildSet {
                        if (row.comics_enabled) add(SyncDomain.COMICS)
                        if (row.novels_enabled) add(SyncDomain.NOVELS)
                        if (row.books_enabled) add(SyncDomain.BOOKS)
                    },
                    comicRepositories = DependencyInventoryMode.valueOf(row.comic_repositories),
                    comicExtensions = DependencyInventoryMode.valueOf(row.comic_extensions),
                    novelRepositories = DependencyInventoryMode.valueOf(row.novel_repositories),
                    novelPlugins = DependencyInventoryMode.valueOf(row.novel_plugins),
                    bookAssets = BookAssetPolicy.valueOf(row.book_asset_policy),
                    updatedAtMs = row.updated_at,
                ).normalized()
            }
    }

    override fun upsert(selection: DeviceSyncSelectionV1) {
        val normalized = selection.normalized()
        database.aethon_syncQueries.upsertDeviceSyncSelection(
            serverId = normalized.serverId,
            profileId = normalized.profileId,
            deviceId = normalized.deviceId,
            schemaVersion = normalized.schemaVersion.toLong(),
            comicsEnabled = SyncDomain.COMICS in normalized.enabledDomains,
            novelsEnabled = SyncDomain.NOVELS in normalized.enabledDomains,
            booksEnabled = SyncDomain.BOOKS in normalized.enabledDomains,
            comicRepositories = normalized.comicRepositories.name,
            comicExtensions = normalized.comicExtensions.name,
            novelRepositories = normalized.novelRepositories.name,
            novelPlugins = normalized.novelPlugins.name,
            bookAssetPolicy = normalized.bookAssets.name,
            updatedAt = normalized.updatedAtMs,
        )
    }

    override fun delete(serverId: String, profileId: String, deviceId: String) {
        requireIdentifier(serverId, "serverId")
        requireIdentifier(profileId, "profileId")
        requireIdentifier(deviceId, "deviceId")
        database.aethon_syncQueries.deleteDeviceSyncSelection(serverId, profileId, deviceId)
    }

    private fun requireIdentifier(value: String, label: String) {
        require(value.isNotBlank() && value == value.trim()) { "$label must be non-blank and canonical" }
        require(value.length <= MAX_IDENTIFIER_LENGTH) { "$label is too long" }
        require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
    }

    private companion object {
        const val MAX_IDENTIFIER_LENGTH = 256
    }
}
