package epigraph.sync.v4

import epigraph.contract.NovelPluginSettingRules
import epigraph.contract.SourcePreferenceRules
import epigraph.contract.SourcePreferenceValue
import epigraph.sync.SourcePreferenceStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import yokai.data.DatabaseHandler

/** Captures declared preferences and defers installation-dependent writes until the async lane. */
internal class V4ExtensionPreferences(
    private val database: DatabaseHandler,
    comicPreferences: SourcePreferenceStore,
    novelPreferences: SourcePreferenceStore,
) : V4DomainBridge {
    private val stores = mapOf("comic" to comicPreferences, "novel" to novelPreferences)
    private val lock = Mutex()
    private val json = V4CoreHttpClient.DEFAULT_JSON

    override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock): List<V4OutgoingItem> =
        withContext(Dispatchers.IO) {
            buildList {
                for ((kind, store) in stores) {
                    for ((owner, settings) in store.installedSources()) {
                        for (setting in settings) {
                            val value = setting.current ?: continue
                            if (!validIdentity(kind, owner, setting.key) || !value.isSyncable()) continue
                            add(V4OutgoingItem(
                                domain = "preferences", entityType = "extension.pref",
                                entityKey = "$kind:$owner:${setting.key}", hlc = clock.next(),
                                payload = buildJsonObject {
                                    put("valueType", value.valueType)
                                    put("value", value.toJson())
                                },
                            ))
                        }
                    }
                }
            }
        }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        val settings = records.filter { it.domain == "preferences" && it.entityType == "extension.pref" }
        if (settings.isEmpty()) return
        lock.withLock {
            database.await(inTransaction = true) {
                val store = SqlDelightV4SyncStore(this)
                for (record in settings.sortedBy(V4WireRecord::serverSeq)) {
                    val (kind, owner, key) = record.entityKey.split(':', limit = 3).takeIf { it.size == 3 } ?: continue
                    if (!validIdentity(kind, owner, key)) continue
                    if (!record.deleted && decode(record.payload) == null) continue
                    val applied = v4_syncQueries.selectV4EntityMapByKey(serverId, profileId, record.entityType, record.entityKey)
                        .executeAsOneOrNull()
                    if (applied != null && record.hlc <= V4Hlc(applied.hlc_ts_ms, applied.hlc_counter, applied.hlc_device_id)) continue
                    store.savePendingExtensionPref(
                        serverId, profileId, kind, owner, key,
                        if (record.deleted) "null" else record.payload.toString(), record.hlc,
                    )
                    store.upsertEntityMap(
                        serverId, profileId, "preferences", record.entityType, record.entityKey, null, record.hlc, record.deleted,
                    )
                }
            }
        }
    }

    /** Drained on the active pairing only, including when an APK or JS plugin is installed. */
    suspend fun drain(serverId: String, profileId: String, syncComics: Boolean, syncNovels: Boolean) = lock.withLock {
        withContext(Dispatchers.IO) {
            for ((kind, preferences) in stores) {
                if ((kind == "comic" && !syncComics) || (kind == "novel" && !syncNovels)) continue
                val pending = database.await { SqlDelightV4SyncStore(this).loadPendingExtensionPrefs(serverId, profileId, kind) }
                if (pending.isEmpty()) continue
                val installed = preferences.installedSources()
                for (record in pending) {
                    val owner = record.source_or_plugin_id
                    val key = record.pref_key
                    if (!validIdentity(kind, owner, key)) continue
                    val setting = installed[owner]?.firstOrNull { it.key == key } ?: continue
                    val json = json.parseToJsonElement(record.payload_json)
                    val applied = if (json == JsonNull) {
                        preferences.reset(owner, key)
                    } else {
                        val target = decode(json) ?: continue
                        if (!SourcePreferenceRules.accepts(setting.valueType, setting.entryValues, target)) continue
                        preferences.write(owner, key, target)
                    }
                    if (applied) {
                        database.await {
                            SqlDelightV4SyncStore(this).deletePendingExtensionPref(serverId, profileId, kind, owner, key)
                        }
                    }
                }
            }
        }
    }

    private fun validIdentity(kind: String, owner: String, key: String): Boolean = when (kind) {
        "comic" -> SourcePreferenceRules.isValidSourceId(owner) && SourcePreferenceRules.isSyncableKey(key)
        "novel" -> ':' !in owner && NovelPluginSettingRules.isSyncableSetting(owner, key)
        else -> false
    }

    private fun decode(payload: JsonElement): SourcePreferenceValue? {
        val fields = payload as? JsonObject ?: return null
        val type = (fields["valueType"] as? JsonPrimitive)?.contentOrNull ?: return null
        val value = fields["value"] ?: return null
        return SourcePreferenceValue.fromTyped(type, value)?.takeIf { it.isSyncable() }
    }
}
