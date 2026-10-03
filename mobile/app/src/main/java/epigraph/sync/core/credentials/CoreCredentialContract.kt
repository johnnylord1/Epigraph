package epigraph.sync.core.credentials

import java.io.Closeable
import java.nio.charset.StandardCharsets

/** Failures are intentionally coarse so neither logs nor UI need credential contents. */
enum class CoreCredentialFailure {
    CORRUPTED,
    KEY_INVALIDATED,
    IO,
    INVALID_INPUT,
}

class CoreCredentialException(
    val failure: CoreCredentialFailure,
    cause: Throwable? = null,
) : Exception(failure.name, cause)

/**
 * An authenticated Epigraph Core session.
 *
 * The bearer token is never included in properties or string representations. Callers receive a
 * short-lived copy through [useAccessToken] and must not retain or log it.
 */
class CoreCredentialSession(
    val origin: String,
    val tlsCertSha256: String,
    val pairingSessionId: String,
    val profileId: String,
    val tokenId: String,
    scopes: List<String>,
    val inactivityExpiresAtMs: Long,
    val serverId: String = LEGACY_UNBOUND_SERVER_ID,
    val lastKnownEndpoint: String = origin,
    val mdnsServiceName: String? = null,
    val endpointGeneration: Long = 0,
    accessTokenUtf8: ByteArray,
) : Closeable {
    val scopes: List<String> = scopes.toList()
    private val accessToken = accessTokenUtf8.copyOf()
    private var closed = false

    @Synchronized
    fun <T> useAccessToken(block: (ByteArray) -> T): T {
        check(!closed) { "Credential session is closed" }
        val copy = accessToken.copyOf()
        return try {
            block(copy)
        } finally {
            copy.fill(0)
        }
    }

    /**
     * Borrows the token for one suspending HTTP/SSE operation.
     *
     * The UTF-8 byte copy is wiped when the operation finishes. The callback must not retain or
     * log the temporary String; it exists only because OkHttp header APIs accept Strings.
     */
    suspend fun <T> withAccessTokenString(block: suspend (String) -> T): T {
        val copy = synchronized(this) {
            check(!closed) { "Credential session is closed" }
            accessToken.copyOf()
        }
        return try {
            block(String(copy, StandardCharsets.UTF_8))
        } finally {
            copy.fill(0)
        }
    }

    @Synchronized
    override fun close() {
        if (!closed) {
            accessToken.fill(0)
            closed = true
        }
    }

    override fun toString(): String =
        "CoreCredentialSession(origin=$origin, tlsCertSha256=$tlsCertSha256, " +
            "serverId=$serverId, pairingSessionId=$pairingSessionId, profileId=$profileId, tokenId=$tokenId, " +
            "scopes=$scopes, inactivityExpiresAtMs=$inactivityExpiresAtMs, " +
            "accessToken=<redacted>)"

    internal fun copySecretForPersistence(): ByteArray = synchronized(this) {
        check(!closed) { "Credential session is closed" }
        accessToken.copyOf()
    }

    internal fun copyWithServerMetadata(
        origin: String = this.origin,
        serverId: String = this.serverId,
        scopes: List<String> = this.scopes,
        inactivityExpiresAtMs: Long = this.inactivityExpiresAtMs,
        mdnsServiceName: String? = this.mdnsServiceName,
        endpointGeneration: Long = this.endpointGeneration,
        lastKnownEndpoint: String = origin,
    ): CoreCredentialSession {
        val secret = copySecretForPersistence()
        return try {
            CoreCredentialSession(
                origin = origin,
                tlsCertSha256 = tlsCertSha256,
                pairingSessionId = pairingSessionId,
                profileId = profileId,
                tokenId = tokenId,
                scopes = scopes,
                inactivityExpiresAtMs = inactivityExpiresAtMs,
                serverId = serverId,
                lastKnownEndpoint = lastKnownEndpoint,
                mdnsServiceName = mdnsServiceName,
                endpointGeneration = endpointGeneration,
                accessTokenUtf8 = secret,
            )
        } finally {
            secret.fill(0)
        }
    }
}

const val LEGACY_UNBOUND_SERVER_ID = "legacy_unbound"

data class CoreServerIdentity(
    val serverId: String,
    val tlsFingerprint: String,
)

data class CoreRemoteIdentity(
    val serverId: String,
    val profileId: String,
    val remoteId: String,
)

interface CoreCredentialStore {
    /** Replaces the complete current session, including rotations that reuse the same tokenId. */
    @Throws(CoreCredentialException::class)
    fun replace(session: CoreCredentialSession)

    @Throws(CoreCredentialException::class)
    fun load(): CoreCredentialSession?

    @Throws(CoreCredentialException::class)
    fun delete()
}
