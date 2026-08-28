package epigraph.sync.core.suwayomi

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.CoreEndpointResolver
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Authenticated, on-demand cover fetcher for catalog rows materialized from the Core. */
fun interface CoreCoverByteSource {
    suspend fun fetch(reference: String): CoreHttpResult<ByteArray>
}

class EpigraphCoreCoverClient(
    private val credentials: CoreCredentialStore,
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
) : CoreCoverByteSource {
    private val endpointMutex = Mutex()
    @Volatile
    private var cachedEndpoint: CachedEndpoint? = null

    override suspend fun fetch(reference: String): CoreHttpResult<ByteArray> {
        val parsed = SuwayomiCoreThumbnailReference.parse(reference)
            ?: return CoreHttpResult.Failure(400, null)
        val session = try {
            credentials.load()
        } catch (_: CoreCredentialException) {
            return CoreHttpResult.Failure(401, null)
        } ?: return CoreHttpResult.Failure(401, null)

        session.use {
            val expectedScope = "comics:profile:${parsed.profileId}"
            if (
                parsed.serverId != null && parsed.serverId != session.serverId ||
                session.profileId != parsed.profileId ||
                expectedScope !in session.scopes
            ) {
                return CoreHttpResult.Failure(403, null)
            }
            val endpoint = runCatching { resolveEndpoint(session) }.getOrElse {
                return CoreHttpResult.Failure(503, null)
            }
            val result = session.withAccessTokenString { token ->
                transports.create(session, endpoint).http.suwayomiThumbnail(
                    accessToken = token,
                    profileId = session.profileId,
                    mangaId = parsed.mangaId,
                )
            }
            if (result is CoreHttpResult.Failure && result.statusCode in SESSION_INVALIDATING_STATUSES) {
                cachedEndpoint = null
            }
            return result
        }
    }

    private suspend fun resolveEndpoint(session: CoreCredentialSession): String {
        val now = System.currentTimeMillis()
        cachedEndpoint?.takeIf {
            it.serverId == session.serverId &&
                it.profileId == session.profileId &&
                it.expiresAtMs > now
        }?.let { return it.origin }
        return endpointMutex.withLock {
            val lockedNow = System.currentTimeMillis()
            cachedEndpoint?.takeIf {
                it.serverId == session.serverId &&
                    it.profileId == session.profileId &&
                    it.expiresAtMs > lockedNow
            }?.origin ?: endpoints.resolve(session).origin.also { origin ->
                cachedEndpoint = CachedEndpoint(
                    serverId = session.serverId,
                    profileId = session.profileId,
                    origin = origin,
                    expiresAtMs = lockedNow + ENDPOINT_CACHE_MS,
                )
            }
        }
    }

    private data class CachedEndpoint(
        val serverId: String,
        val profileId: String,
        val origin: String,
        val expiresAtMs: Long,
    )

    private companion object {
        const val ENDPOINT_CACHE_MS = 60_000L
        // Gateway failures describe the Suwayomi upstream, not the authenticated Core endpoint.
        val SESSION_INVALIDATING_STATUSES = setOf(401, 403)
    }
}
