package epigraph.sync.core.protocol

import kotlinx.serialization.Serializable

/**
 * One tracker login as stored by the paired Core (`tracker.credential`). The Core keeps a
 * monotonically increasing [revision] per tracker; a deleted credential is a tombstone that still
 * carries its revision so every device converges on the logout.
 *
 * Secret fields are excluded from [toString]. They travel only inside the pinned TLS session and
 * are never part of snapshots, change feeds, or backups.
 */
@Serializable
data class CoreTrackerCredential(
    val trackerKey: String,
    val revision: Long,
    val deleted: Boolean = false,
    val username: String = "",
    val password: String = "",
    val token: String = "",
    val updatedAtMs: Long = 0,
) {
    override fun toString(): String =
        "CoreTrackerCredential(trackerKey=$trackerKey, revision=$revision, deleted=$deleted, secrets=<redacted>)"
}

@Serializable
data class CoreTrackerCredentialList(
    val schemaVersion: Int = 1,
    val credentials: List<CoreTrackerCredential> = emptyList(),
)

/** Compare-and-set write. The Core answers 409 when [baseRevision] is not its current revision. */
@Serializable
data class CoreTrackerCredentialWrite(
    val baseRevision: Long,
    val deviceId: String,
    val username: String,
    val password: String,
    val token: String,
) {
    override fun toString(): String =
        "CoreTrackerCredentialWrite(baseRevision=$baseRevision, deviceId=$deviceId, secrets=<redacted>)"
}

@Serializable
data class CoreTrackerCredentialDelete(
    val baseRevision: Long,
    val deviceId: String,
)
