package epigraph.sync

import epigraph.contract.DeviceId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.NovelPluginSettingRules
import epigraph.contract.SourcePreferenceRules
import epigraph.contract.SourcePreferenceValue
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import yokai.data.Database

/**
 * What a [EpigraphSourcePreferenceSync] compares: the settings of comic extension sources
 * (`comic.source_preference`, owner = numeric source ID) or of LNReader novel plugins
 * (`novel.plugin_setting`, owner = plugin ID). Both use the same values and never-synced keys.
 */
enum class SourcePreferenceKind(val entityType: SyncEntityType) {
    ComicSource(SyncEntityType(SourcePreferenceRules.ENTITY_TYPE)),
    NovelPlugin(SyncEntityType(NovelPluginSettingRules.ENTITY_TYPE)),
    ;

    internal fun scope(scopes: EpigraphSyncScopes): SyncScopeId = when (this) {
        ComicSource -> scopes.comics
        NovelPlugin -> scopes.novels
    }

    /** The entity ID of a setting that may travel, or null when it never does. */
    internal fun syncableEntityId(ownerId: String, key: String): String? = when (this) {
        ComicSource -> SourcePreferenceRules.entityIdFor(ownerId, key).takeIf {
            SourcePreferenceRules.isValidSourceId(ownerId) && SourcePreferenceRules.isSyncableKey(key)
        }
        NovelPlugin -> NovelPluginSettingRules.entityIdFor(ownerId, key).takeIf {
            NovelPluginSettingRules.isSyncableSetting(ownerId, key)
        }
    }

    internal fun recordValue(entityId: String, record: Map<String, kotlinx.serialization.json.JsonElement>) =
        when (this) {
            ComicSource -> SourcePreferenceRules.recordValue(entityId, record)
            NovelPlugin -> NovelPluginSettingRules.recordValue(entityId, record)
        }

    internal fun command(ownerId: String, key: String, value: SourcePreferenceValue): SyncCommand = when (this) {
        ComicSource -> SyncCommand.SetSourcePreference.of(ownerId, key, value)
        NovelPlugin -> SyncCommand.SetNovelPluginSetting.of(ownerId, key, value)
    }
}

/** One setting an installed comic extension or novel plugin shows on its settings screen. */
data class OfferedSourcePreference(
    val key: String,
    /** [SourcePreferenceRules.VALUE_TYPE_BOOLEAN], `_STRING` or `_STRING_SET`. */
    val valueType: String,
    /** The values a list setting offers; null for a switch or a free text field. */
    val entryValues: List<String>?,
    /** The value the user chose, or null while the extension still uses its default. */
    val current: SourcePreferenceValue?,
)

/** Reads and writes the settings of the comic extensions or novel plugins installed on this device. */
interface SourcePreferenceStore {
    /** Settings offered by each installed configurable source (or plugin), by source (or plugin) ID. */
    suspend fun installedSources(): Map<String, List<OfferedSourcePreference>>

    /** Stores [value] as the source's setting; false when the source or setting is gone. */
    suspend fun write(sourceId: String, key: String, value: SourcePreferenceValue): Boolean
}

data class SourcePreferenceSyncResult(
    val emitted: Int,
    val applied: Int,
    val agreed: Int,
)

/**
 * Keeps comic extension settings (for example a preferred mirror) or novel plugin settings (for
 * example a preferred translation) the same as on the paired desktop, as `comic.source_preference`
 * or `novel.plugin_setting` records ([kind]).
 *
 * Settings are not written through a database the outbox can share a transaction with (each
 * extension or plugin keeps its own shared preferences), so this compares instead of intercepting
 * edits. Comic and novel agreements share one table: their entity IDs never collide.
 * Per setting it remembers the value both sides last agreed on and the Core version it came from:
 * a local value that moved from it is sent, a newer Core version is applied. A value applied from
 * the Core is recorded as agreed and never sent back, so nothing echoes.
 *
 * Only settings the extension shows on its screen, stored by the user, with a key that names no
 * credential, session or cache, and a simple value are compared ([SourcePreferenceRules]).
 */
class EpigraphSourcePreferenceSync(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val scopeProvider: EpigraphSyncScopeProvider,
    private val gate: TrackingSyncGate,
    private val store: SourcePreferenceStore,
    private val kind: SourcePreferenceKind = SourcePreferenceKind.ComicSource,
) {
    private val entityType = kind.entityType

    suspend fun reconcile(nowEpochMillis: Long): SourcePreferenceSyncResult {
        if (!gate.advertises(entityType)) return NOTHING
        val scopeId = try {
            kind.scope(scopeProvider.current())
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return NOTHING
        }
        val installed = try {
            store.installedSources()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return NOTHING
        }
        val offered = installed.flatMap { (sourceId, preferences) ->
            preferences.mapNotNull { preference ->
                kind.syncableEntityId(sourceId, preference.key)?.let { it to OfferedEntry(sourceId, preference) }
            }
        }.toMap()

        val applies = coordinator.mutateLocalBatch(nowEpochMillis) {
            val agreements = epigraph_source_preferenceQueries.selectSourcePreferenceAgreements(scopeId.value)
                .executeAsList()
                .associate { it.entity_id to SourcePreferenceAgreement(it.fingerprint, it.core_server_version) }
            val records = aethon_syncQueries.selectCoreReplicaRecordVersionsByType(scopeId.value, entityType.value)
                .executeAsList()
                .associateBy { it.entity_id }
            val pending = aethon_syncQueries.selectOutboxOrWaitEntityIdsForType(scopeId.value, entityType.value)
                .executeAsList()
                .filterNotNullTo(hashSetOf())

            val envelopes = mutableListOf<SyncCommandEnvelope>()
            val applies = mutableListOf<PendingApply>()
            var agreed = 0
            (offered.keys + records.keys).forEach { entityId ->
                val record = records[entityId]
                val core = record?.let { decodeRecord(kind, entityId, it.record_json) }
                // A record this build cannot read (another type, a newer shape) is left alone.
                if (record != null && core == null) return@forEach
                val coreVersion = record?.server_version
                val entry = offered[entityId]
                if (entityId in pending &&
                    hasBlockingMutation(scopeId.value, entityId, coreVersion ?: 0)
                ) {
                    return@forEach
                }
                val local = entry?.preference?.current?.takeIf { value ->
                    value.isSyncable() && SourcePreferenceRules.accepts(
                        entry.preference.valueType,
                        entry.preference.entryValues,
                        value,
                    )
                }
                val coreAccepted = core != null && entry != null && SourcePreferenceRules.accepts(
                    entry.preference.valueType,
                    entry.preference.entryValues,
                    core,
                )
                val decision = decideSourcePreference(
                    local = local?.fingerprint(),
                    core = core?.fingerprint(),
                    coreVersion = coreVersion,
                    agreement = agreements[entityId],
                    coreAccepted = coreAccepted,
                )
                when (decision) {
                    SourcePreferenceDecision.Keep -> Unit
                    is SourcePreferenceDecision.Agree -> {
                        upsertAgreement(scopeId.value, entityId, decision.agreement, nowEpochMillis)
                        agreed++
                    }
                    is SourcePreferenceDecision.Emit -> {
                        val value = checkNotNull(local)
                        val envelope = envelopeFor(scopeId, checkNotNull(entry).sourceId, entry.preference.key, value)
                            ?: return@forEach
                        upsertAgreement(scopeId.value, entityId, decision.agreement, nowEpochMillis)
                        envelopes += envelope
                    }
                    is SourcePreferenceDecision.ApplyCore -> applies += PendingApply(
                        entityId = entityId,
                        sourceId = checkNotNull(entry).sourceId,
                        key = entry.preference.key,
                        value = checkNotNull(core),
                        agreement = decision.agreement,
                    )
                }
            }
            LocalMutationResult(Triple(envelopes.size, applies.toList(), agreed), envelopes)
        }

        var applied = 0
        applies.second.forEach { apply ->
            val written = try {
                store.write(apply.sourceId, apply.key, apply.value)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            if (!written) return@forEach
            coordinator.mutateLocalBatch(nowEpochMillis) {
                upsertAgreement(scopeId.value, apply.entityId, apply.agreement, nowEpochMillis)
                LocalMutationResult(Unit, emptyList())
            }
            applied++
        }
        return SourcePreferenceSyncResult(emitted = applies.first, applied = applied, agreed = applies.third)
    }

    private fun envelopeFor(
        scopeId: SyncScopeId,
        sourceId: String,
        key: String,
        value: SourcePreferenceValue,
    ): SyncCommandEnvelope? = try {
        SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = deviceId,
            clientMutationId = mutationIds.next(),
            scopeId = scopeId,
            entityType = entityType,
            command = kind.command(sourceId, key, value),
        )
    } catch (_: IllegalArgumentException) {
        // A setting the contract cannot carry stays on this device.
        null
    }

    private fun Database.hasBlockingMutation(scopeId: String, entityId: String, observedVersion: Long): Boolean =
        aethon_syncQueries.hasBlockingMutationForObservedVersion(
            scopeId = scopeId,
            entityType = entityType.value,
            entityId = entityId,
            observedServerVersion = observedVersion,
        ).executeAsOne()

    private fun Database.upsertAgreement(scopeId: String, entityId: String, agreement: SourcePreferenceAgreement, now: Long) {
        epigraph_source_preferenceQueries.upsertSourcePreferenceAgreement(
            scopeId = scopeId,
            entityId = entityId,
            fingerprint = agreement.fingerprint,
            coreServerVersion = agreement.coreVersion,
            updatedAt = now,
        )
    }

    private data class OfferedEntry(val sourceId: String, val preference: OfferedSourcePreference)

    private data class PendingApply(
        val entityId: String,
        val sourceId: String,
        val key: String,
        val value: SourcePreferenceValue,
        val agreement: SourcePreferenceAgreement,
    )

    companion object {
        private val NOTHING = SourcePreferenceSyncResult(0, 0, 0)
    }
}

/** The value both sides last agreed on, and the Core version it was agreed at (0: none yet). */
data class SourcePreferenceAgreement(val fingerprint: String, val coreVersion: Long)

sealed interface SourcePreferenceDecision {
    data object Keep : SourcePreferenceDecision

    /** Records [agreement] without changing the setting or sending anything. */
    data class Agree(val agreement: SourcePreferenceAgreement) : SourcePreferenceDecision

    /** Sends the local value and records it as agreed at the current Core version. */
    data class Emit(val agreement: SourcePreferenceAgreement) : SourcePreferenceDecision

    /** Writes the Core value here, then records [agreement]. */
    data class ApplyCore(val agreement: SourcePreferenceAgreement) : SourcePreferenceDecision
}

/**
 * The decision for one setting with no pending local mutation. [local] and [core] are value
 * fingerprints (null: no value the extension here accepts / no Core record); [coreAccepted] says
 * whether the installed extension offers the Core value.
 */
fun decideSourcePreference(
    local: String?,
    core: String?,
    coreVersion: Long?,
    agreement: SourcePreferenceAgreement?,
    coreAccepted: Boolean,
): SourcePreferenceDecision {
    if (core == null || coreVersion == null) {
        // Never in the Core: a value chosen here is sent once (this also backfills settings chosen
        // before pairing). It is not sent again while the Core has not stored it yet.
        return if (local != null && agreement?.fingerprint != local) {
            SourcePreferenceDecision.Emit(SourcePreferenceAgreement(local, 0))
        } else {
            SourcePreferenceDecision.Keep
        }
    }
    val coreAgreement = SourcePreferenceAgreement(core, coreVersion)
    if (local == core) {
        return if (agreement != coreAgreement) SourcePreferenceDecision.Agree(coreAgreement) else SourcePreferenceDecision.Keep
    }
    // From here the Core holds a value that differs from the one here (or there is none here).
    val takeCore = when {
        local == null -> true
        // First comparison (for example a new pairing): the Core's value wins.
        agreement == null -> true
        // The desktop changed it since the last agreement: newest wins.
        agreement.coreVersion != coreVersion -> true
        else -> false
    }
    if (takeCore) {
        return when {
            coreAccepted -> SourcePreferenceDecision.ApplyCore(coreAgreement)
            // This extension does not offer that value (an older version, or not installed): keep
            // the value here without sending it, until either side changes again.
            local != null -> SourcePreferenceDecision.Agree(SourcePreferenceAgreement(local, coreVersion))
            else -> SourcePreferenceDecision.Keep
        }
    }
    return if (local != agreement?.fingerprint) {
        SourcePreferenceDecision.Emit(SourcePreferenceAgreement(local!!, coreVersion))
    } else {
        SourcePreferenceDecision.Keep
    }
}

private val recordJson = Json { ignoreUnknownKeys = true }

private fun decodeRecord(kind: SourcePreferenceKind, entityId: String, json: String): SourcePreferenceValue? {
    if (json.encodeToByteArray().size > SourcePreferenceRules.MAX_RECORD_BYTES) return null
    val record = runCatching { recordJson.parseToJsonElement(json).jsonObject }.getOrNull() ?: return null
    return kind.recordValue(entityId, record)
}
