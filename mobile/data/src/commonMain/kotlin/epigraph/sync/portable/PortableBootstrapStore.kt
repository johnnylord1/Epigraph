package epigraph.sync.portable

import epigraph.contract.PortableEcosystem
import yokai.data.Database

enum class PortableBootstrapPhase {
    NEGOTIATING,
    RECEIVING_MANIFEST,
    RESOLVING_DEPENDENCIES,
    WAITING_TRUST,
    IMPORTING_REFERENCES,
    HYDRATING_LIBRARY,
    RESOLVING_CHAPTERS,
    APPLYING_STATE,
    COMPLETED,
    PARTIAL,
    CANCELLED,
    FAILED,
}

data class PortableBootstrapRecord(
    val serverId: String,
    val profileId: String,
    val ecosystem: PortableEcosystem,
    val bootstrapId: String,
    val phase: PortableBootstrapPhase,
    val manifestFingerprint: String? = null,
    val currentItem: String? = null,
    val attemptCount: Long = 0,
    val lastReason: String? = null,
    val updatedAt: Long,
)

class SqlDelightPortableBootstrapStore(
    private val database: Database,
) {
    fun upsert(record: PortableBootstrapRecord) {
        validate(record)
        database.aethon_syncQueries.upsertPortableBootstrapV3(
            serverId = record.serverId,
            profileId = record.profileId,
            ecosystem = record.ecosystem.name,
            bootstrapId = record.bootstrapId,
            phase = record.phase.name,
            manifestFingerprint = record.manifestFingerprint,
            currentItem = record.currentItem,
            attemptCount = record.attemptCount,
            lastReason = record.lastReason,
            updatedAt = record.updatedAt,
        )
    }

    fun load(serverId: String, profileId: String, ecosystem: PortableEcosystem): PortableBootstrapRecord? {
        requireCanonical(serverId, "server ID")
        requireCanonical(profileId, "profile ID")
        return database.aethon_syncQueries.selectPortableBootstrapV3(serverId, profileId, ecosystem.name)
            .executeAsOneOrNull()
            ?.let { row ->
                PortableBootstrapRecord(
                    serverId = row.server_id,
                    profileId = row.profile_id,
                    ecosystem = PortableEcosystem.valueOf(row.ecosystem),
                    bootstrapId = row.bootstrap_id,
                    phase = PortableBootstrapPhase.valueOf(row.phase),
                    manifestFingerprint = row.manifest_fingerprint,
                    currentItem = row.current_item,
                    attemptCount = row.attempt_count,
                    lastReason = row.last_reason,
                    updatedAt = row.updated_at,
                )
            }
    }

    private fun validate(record: PortableBootstrapRecord) {
        requireCanonical(record.serverId, "server ID")
        requireCanonical(record.profileId, "profile ID")
        requireCanonical(record.bootstrapId, "bootstrap ID")
        record.manifestFingerprint?.let { requireCanonical(it, "manifest fingerprint") }
        record.currentItem?.let { requireBounded(it, "current item") }
        record.lastReason?.let { requireBounded(it, "last reason") }
        require(record.attemptCount >= 0)
        require(record.updatedAt >= 0)
    }

    private fun requireCanonical(value: String, label: String) {
        require(value.isNotBlank() && value == value.trim()) { "$label must be canonical" }
        require(value.length <= MAX_IDENTIFIER_LENGTH) { "$label is too long" }
        require(value.none(Char::isISOControl)) { "$label contains control characters" }
    }

    private fun requireBounded(value: String, label: String) {
        require(value.length <= MAX_DETAIL_LENGTH) { "$label is too long" }
        require(value.none(Char::isISOControl)) { "$label contains control characters" }
    }

    private companion object {
        const val MAX_IDENTIFIER_LENGTH = 512
        const val MAX_DETAIL_LENGTH = 1_024
    }
}
