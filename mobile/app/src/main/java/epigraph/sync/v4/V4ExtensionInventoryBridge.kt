package epigraph.sync.v4

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import yokai.data.DatabaseHandler

data class V4InstalledExtensionDescriptor(
    val kind: String, // "comic" | "novel"
    val packageId: String,
    val name: String,
    val versionName: String,
    val versionCode: Long = 0L,
    val lang: String = "",
    val signatureHash: String = "",
    val isNsfw: Boolean = false,
    val repoUrl: String? = null,
)

/**
 * Syncs extension repositories (Mihon comic repos + LNReader novel repos) and installed extension
 * inventory on the V4 Fast State Lane without making any external internet requests.
 *
 * Remote `extension.repo` entries are applied directly into `extension_repos` / `novel_repos`
 * in one SQLite transaction. Remote `extension.installed` entries are recorded in `v4_entity_map`
 * so the async installer lane can install missing APKs/JS plugins from the Core LAN cache or repos.
 */
internal class V4ExtensionInventoryBridge(
    private val handler: DatabaseHandler,
    private val installedExtensionsProvider: suspend () -> List<V4InstalledExtensionDescriptor> = { emptyList() },
) : V4DomainBridge {
    override suspend fun exportLocalSnapshot(
        serverId: String,
        profileId: String,
        clock: V4HlcClock,
    ): List<V4OutgoingItem> {
        val installed = installedExtensionsProvider()
        return handler.await(inTransaction = true) { buildExtensionDrafts(installed).stamp(clock) }
    }

    override suspend fun digestAffected(serverId: String, profileId: String, records: List<V4WireRecord>): List<V4DigestedItem> =
        if (records.none { it.domain == DOMAIN }) emptyList() else digestSnapshot(serverId, profileId)

    /** Side-effect free. The installed-extension provider runs outside the transaction, as in export. */
    override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> {
        val installed = installedExtensionsProvider()
        return handler.await(inTransaction = true) {
            buildExtensionDrafts(installed).map { V4DigestedItem(it.key, V4LocalDigest.of(it), deleted = it.deleted) }
        }
    }

    /** Pure read of repos and installed extensions. Stamps no clocks and enqueues nothing. */
    private fun yokai.data.Database.buildExtensionDrafts(installed: List<V4InstalledExtensionDescriptor>): List<V4ItemDraft> {
        val comicRepos = extension_reposQueries.findAll().executeAsList()
        val novelRepos = novel_reposQueries.findAll().executeAsList()
        return buildList<V4ItemDraft> {
                for (repo in comicRepos) {
                    val baseUrl = repo.base_url.trim().trimEnd('/')
                    if (baseUrl.isEmpty()) continue
                    add(
                        V4ItemDraft(
                            domain = DOMAIN,
                            entityType = REPO,
                            entityKey = "comic:$baseUrl",
                            payload = buildJsonObject {
                                put("kind", "comic")
                                put("baseUrl", baseUrl)
                                put("name", repo.name)
                                put("shortName", repo.short_name)
                                put("website", repo.website)
                                put("signingKeyFingerprint", repo.signing_key_fingerprint)
                            },
                        ),
                    )
                }
                for (repo in novelRepos) {
                    val baseUrl = repo.base_url.trim().trimEnd('/')
                    if (baseUrl.isEmpty()) continue
                    add(
                        V4ItemDraft(
                            domain = DOMAIN,
                            entityType = REPO,
                            entityKey = "novel:$baseUrl",
                            payload = buildJsonObject {
                                put("kind", "novel")
                                put("baseUrl", baseUrl)
                                put("name", repo.name)
                            },
                        ),
                    )
                }
                for (ext in installed) {
                    val pkg = ext.packageId.trim()
                    if (pkg.isEmpty() || (ext.kind != "comic" && ext.kind != "novel")) continue
                    add(
                        V4ItemDraft(
                            domain = DOMAIN,
                            entityType = INSTALLED,
                            entityKey = "${ext.kind}:$pkg",
                            payload = buildJsonObject {
                                put("kind", ext.kind)
                                put("packageId", pkg)
                                put("name", ext.name)
                                put("versionName", ext.versionName)
                                put("versionCode", ext.versionCode)
                                put("lang", ext.lang)
                                put("signatureHash", ext.signatureHash)
                                put("isNsfw", ext.isNsfw)
                                ext.repoUrl?.let { put("repoUrl", it) }
                            },
                        ),
                    )
                }
            }
    }

    override suspend fun applyRemoteRecords(
        serverId: String,
        profileId: String,
        records: List<V4WireRecord>,
    ) {
        val extRecords = records.filter { it.domain == DOMAIN }
        if (extRecords.isEmpty()) return

        handler.await(inTransaction = true) {
            val store = SqlDelightV4SyncStore(this)
            for (record in extRecords.sortedBy(V4WireRecord::serverSeq)) {
                val previous = v4_syncQueries
                    .selectV4EntityMapByKey(serverId, profileId, record.entityType, record.entityKey)
                    .executeAsOneOrNull()
                if (previous != null && record.hlc <= V4Hlc(previous.hlc_ts_ms, previous.hlc_counter, previous.hlc_device_id)) {
                    continue
                }
                val payload = record.payload as? JsonObject ?: JsonObject(emptyMap())
                when (record.entityType) {
                    REPO -> applyRepo(record, payload)
                    INSTALLED -> Unit // Persisted in v4_entity_map for the async installer lane.
                }
                val payloadJson = if (record.entityType == INSTALLED && !record.deleted) {
                    payload.toString()
                } else {
                    null
                }
                store.upsertEntityMap(
                    serverId = serverId,
                    profileId = profileId,
                    domain = DOMAIN,
                    entityType = record.entityType,
                    entityKey = record.entityKey,
                    localId = record.entityKey,
                    hlc = record.hlc,
                    deleted = record.deleted,
                    payloadJson = payloadJson,
                )
            }
        }
    }

    private fun yokai.data.Database.applyRepo(record: V4WireRecord, payload: JsonObject) {
        val kind = payload.str("kind") ?: record.entityKey.substringBefore(':', "")
        val baseUrl = (payload.str("baseUrl") ?: record.entityKey.substringAfter(':', "")).trim().trimEnd('/')
        if (baseUrl.isEmpty()) return

        when (kind) {
            "comic" -> {
                if (record.deleted) {
                    extension_reposQueries.delete(baseUrl)
                } else {
                    val name = payload.str("name").orEmpty().ifBlank { baseUrl }
                    val shortName = payload.str("shortName")
                    val website = payload.str("website").orEmpty().ifBlank { baseUrl }
                    val fingerprint = payload.str("signingKeyFingerprint").orEmpty()
                    extension_reposQueries.upsert(
                        base_url = baseUrl,
                        name = name,
                        short_name = shortName,
                        website = website,
                        fingerprint = fingerprint,
                    )
                }
            }
            "novel" -> {
                if (record.deleted) {
                    novel_reposQueries.deleteByUrl(baseUrl)
                } else {
                    val name = payload.str("name").orEmpty().ifBlank { baseUrl }
                    novel_reposQueries.insert(baseUrl, name)
                }
            }
        }
    }

    private fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull

    companion object {
        const val DOMAIN = "extensions"
        const val REPO = "extension.repo"
        const val INSTALLED = "extension.installed"
    }
}
