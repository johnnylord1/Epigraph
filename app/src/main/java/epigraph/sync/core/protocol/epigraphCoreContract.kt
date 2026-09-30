package epigraph.sync.core.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Wire protocol spoken by the legacy-compatible Syncd daemon.
 *
 * This is deliberately independent from `EpigraphSyncProtocol`, which versions
 * the local domain commands stored in the Android outbox.
 */
object EpigraphCoreWireProtocol {
    const val CURRENT_VERSION = 1
    const val MIN_SNAPSHOT_SCHEMA_VERSION = 2
    const val SNAPSHOT_SCHEMA_VERSION = 3
    const val CLIENT_VERSION_HEADER = "X-Epigraph-Client-Version"
    const val CLIENT_PROTOCOL_HEADER = "X-Epigraph-Client-Protocol-Version"
    const val LEGACY_CLIENT_VERSION_HEADER = "X-Aethon-Client-Version"
    const val LEGACY_CLIENT_PROTOCOL_HEADER = "X-Aethon-Client-Protocol-Version"
    const val ASSET_SHA256_HEADER = "X-Epigraph-Asset-Sha256"
    const val LEGACY_ASSET_SHA256_HEADER = "X-Aethon-Asset-Sha256"
    const val AUTHORIZATION_HEADER = "Authorization"
}

@Serializable
data class CoreCapabilities(
    val serverProtocolVersion: Int,
    val minClientVersion: String,
    val supportedScopes: List<String>,
    val supportsSseReplay: Boolean,
    val supportsManualIpFallback: Boolean,
    val supportsOwnerTransfer: Boolean,
    val supportsSnapshot: Boolean,
    val supportsAssets: Boolean,
    val supportsNovelChapterAssets: Boolean,
    val supportsNovelPluginSync: Boolean,
    val supportsSuwayomiProxy: Boolean,
    val supportsCausalMutationsV3: Boolean = false,
    /** Portable identities are a separate opt-in capability from causal mutation receipts. */
    val supportsPortableSyncV3: Boolean = false,
    /** Distinguishes the bounded catalog bridge from the generic GraphQL proxy. */
    val supportsSuwayomiCatalog: Boolean = false,
    /** Typed details, chapters, and pages operations are available. */
    val supportsSuwayomiContent: Boolean = false,
    /** The Core can expose the loaded extension/source inventory for parity and relinking. */
    val supportsSuwayomiExtensionInventory: Boolean = false,
    val supportsSuwayomiWebsocketProxy: Boolean,
    val suwayomiProxyPathTemplate: String,
    val snapshotSchemaVersion: Int,
    val snapshotEntityTypes: Set<String>,
    val tlsCertSha256: String,
    val mdnsServiceName: String,
    val currentServerVersion: Long,
    val minReplayableServerVersion: Long,
    /** The managed Suwayomi instance remains authoritative for comic catalog state. */
    val comicAuthorityMode: String? = null,
    /** The Core can acknowledge Suwayomi commands only after upstream confirmation. */
    val supportsConfirmedSuwayomiCommandsV1: Boolean = false,
    /** Aggregate readiness is opt-in; older Cores must not be treated as fully synced. */
    val supportsSyncStatusV1: Boolean = false,
    /**
     * Tracker credentials may be exchanged over this paired session. Older Cores never receive or
     * return credentials; see docs/audit/TRACKER_SYNC_CONTRACT.md.
     */
    val supportsTrackerCredentialsV1: Boolean = false,
)

@Serializable
data class CoreSessionResponse(
    val schemaVersion: Int,
    val serverId: String,
    val profileId: String,
    val tokenId: String,
    val scopes: List<String>,
    val inactivityExpiresAtMs: Long,
    val effectiveBaseUrl: String,
    val tlsCertSha256: String,
    val mdnsServiceName: String,
)

@Serializable
data class CoreSnapshot(
    val schemaVersion: Int,
    val snapshotId: String? = null,
    val complete: Boolean? = null,
    val entityCount: Int? = null,
    val tombstoneCount: Int? = null,
    val scopeId: String,
    val snapshotVersion: Long,
    val minReplayableServerVersion: Long,
    val entities: List<CoreSnapshotEntity>,
    val tombstones: List<CoreSnapshotTombstone>,
)

@Serializable
data class CoreSnapshotEntity(
    val entityType: String,
    val entityId: String,
    val serverVersion: Long,
    val lamport: Long,
    val record: JsonElement,
)

@Serializable
data class CoreSnapshotTombstone(
    val entityType: String,
    val entityId: String,
    val serverVersion: Long,
    val lamport: Long,
    val deletedAtMs: Long,
    val reasonCode: String,
)

@Serializable
data class CoreChangesResponse(
    val currentServerVersion: Long,
    val minReplayableServerVersion: Long,
    val changes: List<CoreChangeEnvelope>,
)

@Serializable
data class CoreSyncStatus(
    val scopeId: String,
    val currentServerVersion: Long,
    val minReplayableServerVersion: Long,
    val comicAuthorityMode: String,
    val suwayomiProjectionPending: Long,
    val suwayomiProjectionBlocked: Long,
    val suwayomiProjectionInFlight: Long,
    val ready: Boolean,
)

@Serializable
data class CoreChangeEnvelope(
    val serverVersion: Long,
    val scopeId: String,
    val profileId: String? = null,
    val entityType: String,
    val entityId: String,
    val op: String,
    val lamport: Long,
    val patch: JsonElement? = null,
    val appliedAtMs: Long,
)

@Serializable
data class CoreMutationsRequest(
    val requestId: String,
    val mutations: List<CoreMutationInput>,
)

/** Flat tagged mutation accepted by Syncd v1 (not the nested Android outbox envelope). */
@Serializable
data class CoreMutationInput(
    val entityType: String,
    val clientMutationId: String,
    val scopeId: String,
    val entityId: String,
    val op: CoreMutationOperation = CoreMutationOperation.MERGE,
    val lamport: Long,
    val eventClock: CoreEventClock? = null,
    val patch: JsonObject? = null,
) {
    init {
        require(entityType.isNotBlank())
        require(clientMutationId.isNotBlank())
        require(scopeId.isNotBlank())
        require(entityId.isNotBlank())
        require(lamport >= 0) { "lamport must not be negative" }
        require(op != CoreMutationOperation.DELETE || patch == null) {
            "delete mutations must not carry a patch"
        }
    }
}

@Serializable
data class CoreEventClock(
    val physicalMs: Long,
    val logical: Long,
    val deviceGenerationId: String,
) {
    init {
        require(physicalMs >= 0) { "event clock physical time must not be negative" }
        require(logical >= 0) { "event clock logical counter must not be negative" }
        require(deviceGenerationId.isNotBlank()) { "event clock device generation must not be blank" }
    }
}

@Serializable
data class CoreMutationsResponse(
    val requestId: String,
    val currentServerVersion: Long,
    val results: List<CoreMutationResult>,
)

@Serializable
data class CoreMutationResult(
    val clientMutationId: String,
    val entityType: String,
    val entityId: String,
    val canonicalEntityId: String? = null,
    val scopeId: String,
    val op: CoreMutationOperation,
    val status: CoreMutationResultStatus,
    val appliedServerVersion: Long? = null,
    val appliedLamport: Long? = null,
    val eventClock: CoreEventClock? = null,
    val record: JsonElement? = null,
    val error: CoreErrorDetail? = null,
)

@Serializable
enum class CoreMutationOperation {
    @SerialName("merge")
    MERGE,

    @SerialName("delete")
    DELETE,
}

@Serializable
enum class CoreMutationResultStatus {
    @SerialName("applied")
    APPLIED,

    @SerialName("superseded")
    SUPERSEDED,

    @SerialName("conflict")
    CONFLICT,

    @SerialName("retry")
    RETRY,

    @SerialName("rejected")
    REJECTED,
}

@Serializable
data class CoreErrorEnvelope(val error: CoreErrorDetail)

@Serializable
data class CoreErrorDetail(
    val code: String,
    val message: String,
    val retryable: Boolean? = null,
    val minClientVersion: String? = null,
    val currentServerVersion: Long? = null,
    val minReplayableServerVersion: Long? = null,
    val requiredAction: String? = null,
    val details: JsonElement? = null,
)
