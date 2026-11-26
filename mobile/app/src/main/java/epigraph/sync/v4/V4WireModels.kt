package epigraph.sync.v4

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull

@Serializable
data class V4CapabilitiesResponse(
    val protocolVersion: Int = 4,
    val minClientVersion: String = "",
    val profileId: String,
    val deviceId: String,
    val serverSeq: Long,
    val minReplayableSeq: Long,
    val serverTimeMs: Long,
    val maxBulkItems: Int = 50_000,
    val maxDeltaItems: Int = 500,
    val maxChangesLimit: Int = 2_000,
    val supportsGzipBodies: Boolean = true,
    val supportsConditionalBulk: Boolean = false,
    val supportsExtensionLanCache: Boolean = true,
    val supportsTrackerCredentials: Boolean = false,
    val supportsPagedSnapshot: Boolean = false,
    val maxSnapshotPageItems: Int = 0,
    val tlsCertSha256: String = "",
)

@Serializable
data class V4OutgoingItem(
    val clientMutationId: String? = null,
    val domain: String,
    val entityType: String,
    val entityKey: String,
    val deleted: Boolean = false,
    val hlc: V4Hlc,
    val payload: JsonElement = JsonNull,
)

@Serializable
data class V4WireRecord(
    val serverSeq: Long,
    val domain: String,
    val entityType: String,
    val entityKey: String,
    val deleted: Boolean = false,
    val hlc: V4Hlc,
    val originDeviceId: String,
    val payload: JsonElement = JsonNull,
    val updatedAtMs: Long = 0L,
)

@Serializable
data class V4RejectedItem(
    val index: Int,
    val clientMutationId: String? = null,
    val entityType: String,
    val entityKey: String,
    val code: String,
    val message: String,
)

@Serializable
data class V4WriteSummary(
    val serverSeq: Long,
    val serverTimeMs: Long,
    val acceptedCount: Int,
    val mergedCount: Int,
    val deduplicatedCount: Int,
    val noopCount: Int,
    val rejected: List<V4RejectedItem> = emptyList(),
)

@Serializable
data class V4BatchRequest(
    val items: List<V4OutgoingItem>,
    val expectedServerSeq: Long? = null,
    val finalBatch: Boolean = true,
)

@Serializable
data class V4SnapshotResponse(
    val protocolVersion: Int = 4,
    val profileId: String,
    val serverSeq: Long,
    val minReplayableSeq: Long,
    val serverTimeMs: Long,
    val recordCount: Int,
    val records: List<V4WireRecord>,
    /** Paged snapshots only: more records follow after [nextAfterSeq]. Older Cores omit both. */
    val hasMore: Boolean = false,
    val nextAfterSeq: Long = 0L,
)

@Serializable
data class V4ChangesResponse(
    val protocolVersion: Int = 4,
    val profileId: String,
    val serverSeq: Long,
    val minReplayableSeq: Long,
    val nextSeq: Long,
    val hasMore: Boolean,
    val serverTimeMs: Long,
    val changes: List<V4WireRecord>,
)

@Serializable
data class V4ExtensionPackageMeta(
    val kind: String,
    val packageId: String,
    val version: String,
    val sha256: String,
    val byteSize: Long,
    val mimeType: String,
    val uploadedAtMs: Long,
)
