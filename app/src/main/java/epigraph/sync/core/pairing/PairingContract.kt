package epigraph.sync.core.pairing

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

internal const val EPIGRAPH_SYNCD_CLIENT_VERSION = "0.1.0"
internal const val EPIGRAPH_SYNCD_PROTOCOL_VERSION = 1

@Serializable
data class SyncdBootstrapBundle(
    val schemaVersion: Int = 1,
    val serverId: String = "legacy_unbound",
    val pairingSessionId: String,
    val pairingCode: String,
    val syncdBaseUrl: String,
    val profileId: String,
    val expiresAtMs: Long,
    val tlsCertSha256: String,
    val mdnsServiceName: String? = null,
    /**
     * Explicit claim endpoint emitted by current Core bootstrap responses.
     *
     * Older QR bundles omitted this field; keeping it optional preserves the v1
     * wire compatibility while the parser still validates it when present.
     */
    val claimUrl: String? = null,
)

@Serializable
data class BootstrapSessionCreateRequest(
    val profileId: String,
)

@Serializable
data class BootstrapSuwayomiHint(
    val baseUrl: String,
    val expiresAtMs: Long,
)

@Serializable
data class BootstrapPayloadResponse(
    val schemaVersion: Int = 1,
    val serverId: String = "legacy_unbound",
    val pairingSessionId: String,
    val pairingCode: String,
    val syncdBaseUrl: String,
    val claimUrl: String,
    val profileId: String,
    val expiresAtMs: Long,
    val tlsCertSha256: String,
    val mdnsServiceName: String? = null,
    val suwayomiHint: BootstrapSuwayomiHint? = null,
)

@Serializable
enum class PairingPlatform {
    @SerialName("android")
    ANDROID,

    @SerialName("desktop")
    DESKTOP,

    @SerialName("unknown")
    UNKNOWN,
}

@Serializable
data class PairingClaimRequest(
    val sessionId: String,
    val pairingCode: String,
    val deviceId: String,
    val deviceName: String,
    val platform: PairingPlatform,
    val clientVersion: String,
    val clientProtocolVersion: Int,
    val requestedScopes: List<String>? = null,
)

@Serializable
enum class PairingClaimStatus {
    @SerialName("pending_approval")
    PENDING_APPROVAL,

    @SerialName("approved")
    APPROVED,

    @SerialName("rejected")
    REJECTED,
}

@Serializable
enum class PairingGrantVia {
    @SerialName("qr")
    QR,

    @SerialName("trusted-pool")
    TRUSTED_POOL,

    @SerialName("local-authority")
    LOCAL_AUTHORITY,
}

/**
 * Wire response containing the one-time clear-text token returned by syncd.
 *
 * It deliberately redacts [accessToken] from [toString]. This layer does not persist or log it;
 * the caller must hand it directly to an encrypted credential store.
 */
@Serializable
class PairingTokenResponse(
    val accessToken: String,
    val tokenId: String,
    val profileId: String,
    val scopes: List<String>,
    val inactivityExpiresAtMs: Long,
    val grantedVia: PairingGrantVia,
) {
    override fun toString(): String =
        "PairingTokenResponse(accessToken=<redacted>, tokenId=$tokenId, profileId=$profileId, " +
            "scopes=$scopes, inactivityExpiresAtMs=$inactivityExpiresAtMs, grantedVia=$grantedVia)"
}

@Serializable
data class PairingClaimResponse(
    val status: PairingClaimStatus,
    val sessionId: String,
    val profileId: String,
    val claimedDeviceId: String? = null,
    val expiresAtMs: Long,
    val token: PairingTokenResponse? = null,
)

@Serializable
enum class PairingSessionStatus {
    @SerialName("pending")
    PENDING,

    @SerialName("claimed")
    CLAIMED,

    @SerialName("approved")
    APPROVED,

    @SerialName("rejected")
    REJECTED,

    @SerialName("expired")
    EXPIRED,
}

@Serializable
enum class PairingStatusEventType {
    @SerialName("hello")
    HELLO,

    @SerialName("subscribed")
    SUBSCRIBED,

    @SerialName("status_changed")
    STATUS_CHANGED,

    @SerialName("approved")
    APPROVED,

    @SerialName("rejected")
    REJECTED,

    @SerialName("expired")
    EXPIRED,

    @SerialName("final_token_ready")
    FINAL_TOKEN_READY,
}

@Serializable
data class PairingStatusEvent(
    @SerialName("type")
    val type: PairingStatusEventType,
    val sessionId: String,
    val profileId: String,
    val status: PairingSessionStatus,
    val expiresAtMs: Long,
    val claimedDeviceId: String? = null,
)

data class PairingDevice(
    val id: String,
    val name: String,
    val clientVersion: String = EPIGRAPH_SYNCD_CLIENT_VERSION,
    val protocolVersion: Int = EPIGRAPH_SYNCD_PROTOCOL_VERSION,
)

data class PairingStatusSubscription(
    val endpoint: SyncdEndpoint,
    val sessionId: String,
    val pairingCode: String,
    val expiresAtMs: Long,
)

/** A normalized HTTPS origin. Paths are supplied separately by [PairingTransport]. */
class SyncdEndpoint internal constructor(val origin: String) {
    val claimPath: String = "/v1/pairing/claim"
    val webSocketOrigin: String = "wss://${origin.removePrefix("https://")}"

    fun liveStatusPath(sessionId: String): String =
        "/v1/bootstrap/session/$sessionId/live"
}
