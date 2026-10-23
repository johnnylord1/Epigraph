package epigraph.sync.core.session

import epigraph.sync.core.credentials.CoreCredentialSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Tells the paired desktop this device is forgetting it, so the desktop revokes it and drops it
 * from its devices list. Best effort: an unreachable or older desktop never keeps the device from
 * forgetting, and the desktop can still revoke it from its own list.
 */
fun interface CoreSessionEnder {
    suspend fun endSession(session: CoreCredentialSession)
}

class HttpCoreSessionEnder(
    private val endpoints: CoreEndpointResolver,
    private val transports: CoreSessionTransportFactory,
    private val timeoutMs: Long = END_SESSION_TIMEOUT_MS,
) : CoreSessionEnder {
    override suspend fun endSession(session: CoreCredentialSession) {
        try {
            withTimeoutOrNull(timeoutMs) {
                val endpoint = endpoints.resolve(session)
                val http = transports.create(session, endpoint.origin).http
                session.withAccessTokenString { token -> http.endSession(token) }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The desktop is off or unreachable; forgetting goes ahead locally.
        }
    }

    private companion object {
        const val END_SESSION_TIMEOUT_MS = 5_000L
    }
}
