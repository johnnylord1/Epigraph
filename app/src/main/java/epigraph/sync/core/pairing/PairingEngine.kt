package epigraph.sync.core.pairing

import epigraph.sync.core.policy.SyncDomain
import java.util.concurrent.CancellationException
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

fun interface PairingClock {
    fun nowMs(): Long

    companion object {
        val SYSTEM = PairingClock(System::currentTimeMillis)
    }
}

/**
 * Network boundary for the Epigraph Core/syncd protocol.
 *
 * Implementations must pin the SHA-256 of the TLS leaf certificate's DER bytes (not SPKI) to
 * [SyncdBootstrapBundle.tlsCertSha256],
 * must not follow redirects to a different origin, and must never log claim bodies/responses.
 * [statusEvents] connects to syncd's live WebSocket and must remain cancellable.
 */
interface PairingTransport {
    suspend fun claim(
        endpoint: SyncdEndpoint,
        tlsCertSha256: String,
        request: PairingClaimRequest,
    ): PairingClaimResponse

    fun statusEvents(
        subscription: PairingStatusSubscription,
        tlsCertSha256: String,
    ): Flow<PairingStatusEvent>
}

/**
 * `POST /v1/pairing/pin/resolve`: exchanges the six-digit PIN shown by a discovered host for the
 * same bootstrap payload its QR carries. Must be pinned to the fingerprint the host advertised.
 */
fun interface PairingPinTransport {
    suspend fun resolvePin(
        endpoint: SyncdEndpoint,
        tlsCertSha256: String,
        pin: String,
    ): BootstrapPayloadResponse
}

enum class PairingErrorCode {
    INVALID_BUNDLE,
    EXPIRED,
    REJECTED,
    SESSION_NOT_FOUND,
    UNAUTHORIZED,
    ALREADY_CLAIMED,
    APPROVED_FOR_OTHER_DEVICE,
    INVALID_SESSION_STATUS,
    PROTOCOL_MISMATCH,
    CLIENT_UPGRADE_REQUIRED,
    TLS_MISMATCH,
    NETWORK,
    INVALID_RESPONSE,

    /** No open pairing on the host matches the typed PIN. */
    PIN_NOT_FOUND,

    /** The host locked PIN pairing after repeated wrong guesses; reopen "Add device" there. */
    PIN_LOCKED,

    /** The typed PIN is not six digits. */
    PIN_INVALID,

    /** No Epigraph desktop answered on the local network. */
    HOST_NOT_FOUND,
}

data class PairingError(
    val code: PairingErrorCode,
    val bundleFailure: PairingBundleFailure? = null,
)

class PairingTransportException(val error: PairingError) : Exception(error.code.name)

/** Stable translation boundary for syncd's structured pairing errors. */
object PairingTransportErrorMapper {
    fun fromCore(httpStatus: Int, coreCode: String?): PairingError {
        val code = when (coreCode) {
            "PAIRING_SESSION_EXPIRED",
            "BOOTSTRAP_SESSION_EXPIRED",
            -> PairingErrorCode.EXPIRED
            "PAIRING_SESSION_NOT_FOUND",
            "BOOTSTRAP_SESSION_NOT_FOUND",
            -> PairingErrorCode.SESSION_NOT_FOUND
            "PAIRING_SESSION_ALREADY_CLAIMED" -> PairingErrorCode.ALREADY_CLAIMED
            "PAIRING_SESSION_REJECTED" -> PairingErrorCode.REJECTED
            "PAIRING_SESSION_APPROVED_FOR_OTHER_DEVICE" ->
                PairingErrorCode.APPROVED_FOR_OTHER_DEVICE
            "PAIRING_SESSION_INVALID_STATUS" -> PairingErrorCode.INVALID_SESSION_STATUS
            "PROTOCOL_VERSION_MISMATCH" -> PairingErrorCode.PROTOCOL_MISMATCH
            "CLIENT_VERSION_TOO_OLD" -> PairingErrorCode.CLIENT_UPGRADE_REQUIRED
            "PAIRING_PIN_NOT_FOUND" -> PairingErrorCode.PIN_NOT_FOUND
            "PAIRING_PIN_LOCKED" -> PairingErrorCode.PIN_LOCKED
            else -> when (httpStatus) {
                401 -> PairingErrorCode.UNAUTHORIZED
                403 -> PairingErrorCode.REJECTED
                404 -> PairingErrorCode.SESSION_NOT_FOUND
                410 -> PairingErrorCode.EXPIRED
                426 -> PairingErrorCode.CLIENT_UPGRADE_REQUIRED
                else -> PairingErrorCode.INVALID_RESPONSE
            }
        }
        return PairingError(code)
    }
}

sealed interface PairingState {
    data object ValidatingBundle : PairingState
    data class Claiming(val sessionId: String) : PairingState
    data class AwaitingDesktopApproval(val sessionId: String, val expiresAtMs: Long) : PairingState
    data class ApprovalObserved(val sessionId: String) : PairingState
    data class ExchangingToken(val sessionId: String) : PairingState
    data class Paired(val session: PairedCoreSession) : PairingState
    data class Rejected(val sessionId: String) : PairingState
    data class Expired(val sessionId: String?) : PairingState
    data object Cancelled : PairingState
    data class Failed(val error: PairingError) : PairingState
}

sealed interface PairingResult {
    data class Success(val session: PairedCoreSession) : PairingResult
    data class Failure(val error: PairingError) : PairingResult
}

/**
 * The token is intentionally redacted from string representations and is not persisted here.
 * The consumer must atomically replace any credential with the same tokenId using this latest
 * value before starting authenticated requests: each approved claim rotates syncd's token hash.
 */
class PairedCoreSession(
    val origin: String,
    val tlsCertSha256: String,
    val sessionId: String,
    val profileId: String,
    val token: PairingTokenResponse,
    val serverId: String = "legacy_unbound",
    val mdnsServiceName: String? = null,
) {
    override fun toString(): String =
        "PairedCoreSession(origin=$origin, tlsCertSha256=$tlsCertSha256, sessionId=$sessionId, " +
            "profileId=$profileId, token=<redacted>)"
}

class EpigraphCorePairingEngine(
    private val transport: PairingTransport,
    private val clock: PairingClock = PairingClock.SYSTEM,
    private val parser: BootstrapBundleParser = BootstrapBundleParser(clock),
) {
    // An approved claim rotates the clear-text token for the same tokenId in syncd. Serializing
    // the complete handshake prevents this engine from invalidating a token it just returned.
    private val pairingMutex = Mutex()

    /** Validates bootstrap data without starting a claim or exposing its secret fields to UI. */
    fun inspectBootstrap(rawBootstrapBundle: String): SyncdBootstrapBundle =
        parser.parse(rawBootstrapBundle).bundle

    suspend fun pair(
        rawBootstrapBundle: String,
        device: PairingDevice,
        onState: (PairingState) -> Unit = {},
        requestedDomains: Set<SyncDomain> = SyncDomain.entries.toSet(),
    ): PairingResult = pairingMutex.withLock {
        pairLocked(rawBootstrapBundle, device, requestedDomains, onState)
    }

    private suspend fun pairLocked(
        rawBootstrapBundle: String,
        device: PairingDevice,
        requestedDomains: Set<SyncDomain>,
        onState: (PairingState) -> Unit,
    ): PairingResult {
        try {
            onState(PairingState.ValidatingBundle)
            validateDevice(device)?.let { return fail(it, onState) }
            val validated = try {
                parser.parse(rawBootstrapBundle)
            } catch (error: PairingBundleValidationException) {
                return fail(
                    PairingError(PairingErrorCode.INVALID_BUNDLE, error.failure),
                    onState,
                )
            }
            val bundle = validated.bundle
            if (isExpired(bundle.expiresAtMs)) return expired(bundle.pairingSessionId, onState)
            if (requestedDomains.isEmpty()) {
                return fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
            }

            val request = PairingClaimRequest(
                sessionId = bundle.pairingSessionId,
                pairingCode = bundle.pairingCode,
                deviceId = device.id.trim(),
                deviceName = device.name.trim(),
                platform = PairingPlatform.ANDROID,
                clientVersion = device.clientVersion,
                clientProtocolVersion = device.protocolVersion,
                requestedScopes = requestedDomains
                    .map { domain -> domain.scopeId(bundle.profileId) }
                    .sorted(),
            )
            onState(PairingState.Claiming(bundle.pairingSessionId))
            val firstClaim = transport.claim(validated.endpoint, bundle.tlsCertSha256, request)
            validateClaimResponse(firstClaim, bundle, request)?.let { return fail(it, onState) }

            when (firstClaim.status) {
                PairingClaimStatus.APPROVED ->
                    return acceptApproved(firstClaim, validated, onState)
                PairingClaimStatus.REJECTED ->
                    return rejected(bundle.pairingSessionId, onState)
                PairingClaimStatus.PENDING_APPROVAL -> Unit
            }

            onState(PairingState.AwaitingDesktopApproval(bundle.pairingSessionId, bundle.expiresAtMs))
            val remainingMs = bundle.expiresAtMs - clock.nowMs()
            if (remainingMs <= 0) return expired(bundle.pairingSessionId, onState)
            val terminalEvent = try {
                withTimeout(remainingMs) {
                    transport.statusEvents(
                        PairingStatusSubscription(
                            endpoint = validated.endpoint,
                            sessionId = bundle.pairingSessionId,
                            pairingCode = bundle.pairingCode,
                            expiresAtMs = bundle.expiresAtMs,
                        ),
                        bundle.tlsCertSha256,
                    ).firstOrNull { event ->
                        validateStatusEvent(event, bundle, request) != EventDisposition.CONTINUE
                    }
                }
            } catch (_: TimeoutCancellationException) {
                return expired(bundle.pairingSessionId, onState)
            }
            if (terminalEvent == null) {
                return fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
            }
            when (validateStatusEvent(terminalEvent, bundle, request)) {
                EventDisposition.INVALID ->
                    return fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
                EventDisposition.REJECTED ->
                    return rejected(bundle.pairingSessionId, onState)
                EventDisposition.EXPIRED ->
                    return expired(bundle.pairingSessionId, onState)
                EventDisposition.APPROVED -> Unit
                EventDisposition.CONTINUE ->
                    return fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
            }

            onState(PairingState.ApprovalObserved(bundle.pairingSessionId))
            if (isExpired(bundle.expiresAtMs)) return expired(bundle.pairingSessionId, onState)
            onState(PairingState.ExchangingToken(bundle.pairingSessionId))
            val finalClaim = transport.claim(validated.endpoint, bundle.tlsCertSha256, request)
            validateClaimResponse(finalClaim, bundle, request)?.let { return fail(it, onState) }
            return when (finalClaim.status) {
                PairingClaimStatus.APPROVED -> acceptApproved(finalClaim, validated, onState)
                PairingClaimStatus.REJECTED -> rejected(bundle.pairingSessionId, onState)
                PairingClaimStatus.PENDING_APPROVAL ->
                    fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
            }
        } catch (error: PairingTransportException) {
            return fail(error.error, onState)
        } catch (error: CancellationException) {
            onState(PairingState.Cancelled)
            throw error
        }
    }

    private fun acceptApproved(
        response: PairingClaimResponse,
        validated: ValidatedBootstrapBundle,
        onState: (PairingState) -> Unit,
    ): PairingResult {
        val token = response.token
            ?: return fail(PairingError(PairingErrorCode.INVALID_RESPONSE), onState)
        val session = PairedCoreSession(
            origin = validated.endpoint.origin,
            tlsCertSha256 = validated.bundle.tlsCertSha256,
            sessionId = response.sessionId,
            profileId = response.profileId,
            serverId = validated.bundle.serverId,
            mdnsServiceName = validated.bundle.mdnsServiceName,
            token = token,
        )
        onState(PairingState.Paired(session))
        return PairingResult.Success(session)
    }

    private fun validateDevice(device: PairingDevice): PairingError? {
        if (device.id.isBlank() || device.name.isBlank() || device.clientVersion.isBlank()) {
            return PairingError(PairingErrorCode.INVALID_RESPONSE)
        }
        if (device.id.length > 256 || device.name.length > 256 || device.clientVersion.length > 64) {
            return PairingError(PairingErrorCode.INVALID_RESPONSE)
        }
        if (device.protocolVersion <= 0) return PairingError(PairingErrorCode.PROTOCOL_MISMATCH)
        return null
    }

    private fun validateClaimResponse(
        response: PairingClaimResponse,
        bundle: SyncdBootstrapBundle,
        request: PairingClaimRequest,
    ): PairingError? {
        if (
            response.sessionId != bundle.pairingSessionId ||
            response.profileId != bundle.profileId ||
            response.expiresAtMs != bundle.expiresAtMs ||
            response.claimedDeviceId != request.deviceId
        ) {
            return PairingError(PairingErrorCode.INVALID_RESPONSE)
        }
        when (response.status) {
            PairingClaimStatus.PENDING_APPROVAL,
            PairingClaimStatus.REJECTED,
            -> if (response.token != null) return PairingError(PairingErrorCode.INVALID_RESPONSE)
            PairingClaimStatus.APPROVED -> {
                val token = response.token ?: return PairingError(PairingErrorCode.INVALID_RESPONSE)
                if (
                    token.accessToken.isBlank() ||
                    token.tokenId.isBlank() ||
                    token.profileId != bundle.profileId ||
                    token.scopes.isEmpty() ||
                    token.scopes.any(String::isBlank) ||
                    token.inactivityExpiresAtMs <= clock.nowMs()
                ) {
                    return PairingError(PairingErrorCode.INVALID_RESPONSE)
                }
            }
        }
        return null
    }

    private fun validateStatusEvent(
        event: PairingStatusEvent,
        bundle: SyncdBootstrapBundle,
        request: PairingClaimRequest,
    ): EventDisposition {
        if (
            event.sessionId != bundle.pairingSessionId ||
            event.profileId != bundle.profileId ||
            event.expiresAtMs != bundle.expiresAtMs ||
            event.claimedDeviceId != request.deviceId
        ) {
            return EventDisposition.INVALID
        }
        return when (event.type) {
            PairingStatusEventType.HELLO,
            PairingStatusEventType.SUBSCRIBED,
            -> if (event.status == PairingSessionStatus.CLAIMED) {
                EventDisposition.CONTINUE
            } else {
                EventDisposition.INVALID
            }
            PairingStatusEventType.STATUS_CHANGED -> when (event.status) {
                PairingSessionStatus.CLAIMED -> EventDisposition.CONTINUE
                PairingSessionStatus.APPROVED,
                PairingSessionStatus.REJECTED,
                PairingSessionStatus.EXPIRED,
                -> EventDisposition.CONTINUE
                PairingSessionStatus.PENDING -> EventDisposition.INVALID
            }
            PairingStatusEventType.APPROVED,
            PairingStatusEventType.FINAL_TOKEN_READY,
            -> if (event.status == PairingSessionStatus.APPROVED) {
                EventDisposition.APPROVED
            } else {
                EventDisposition.INVALID
            }
            PairingStatusEventType.REJECTED -> if (event.status == PairingSessionStatus.REJECTED) {
                EventDisposition.REJECTED
            } else {
                EventDisposition.INVALID
            }
            PairingStatusEventType.EXPIRED -> if (event.status == PairingSessionStatus.EXPIRED) {
                EventDisposition.EXPIRED
            } else {
                EventDisposition.INVALID
            }
        }
    }

    private fun isExpired(expiresAtMs: Long): Boolean = expiresAtMs <= clock.nowMs()

    private fun fail(error: PairingError, onState: (PairingState) -> Unit): PairingResult.Failure {
        onState(PairingState.Failed(error))
        return PairingResult.Failure(error)
    }

    private fun rejected(sessionId: String, onState: (PairingState) -> Unit): PairingResult.Failure {
        onState(PairingState.Rejected(sessionId))
        return PairingResult.Failure(PairingError(PairingErrorCode.REJECTED))
    }

    private fun expired(sessionId: String?, onState: (PairingState) -> Unit): PairingResult.Failure {
        onState(PairingState.Expired(sessionId))
        return PairingResult.Failure(PairingError(PairingErrorCode.EXPIRED))
    }

    private enum class EventDisposition {
        CONTINUE,
        APPROVED,
        REJECTED,
        EXPIRED,
        INVALID,
    }
}

private fun SyncDomain.scopeId(profileId: String): String = when (this) {
    SyncDomain.COMICS -> "comics:profile:$profileId"
    SyncDomain.NOVELS -> "novels:profile:$profileId"
    SyncDomain.BOOKS -> "books:global"
}
