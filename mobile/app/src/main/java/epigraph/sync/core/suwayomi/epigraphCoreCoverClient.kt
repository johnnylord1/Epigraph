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
    private val unavailableCovers: RecentCoverFailures = RecentCoverFailures(),
) : CoreCoverByteSource {
    private val endpointMutex = Mutex()
    @Volatile
    private var cachedEndpoint: CachedEndpoint? = null

    override suspend fun fetch(reference: String): CoreHttpResult<ByteArray> {
        val parsed = SuwayomiCoreThumbnailReference.parse(reference)
            ?: return CoreHttpResult.Failure(400, null)
        // The Library asks again for every cover each time a sync writes, every few seconds while a
        // sync runs. A cover the desktop cannot serve is not asked for again for a while.
        if (unavailableCovers.isRecent(reference)) return CoreHttpResult.Failure(UNAVAILABLE_COVER, null)
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
            }.let { result ->
                // A dead cover host can leave an HTML page where Suwayomi caches the thumbnail.
                if (result is CoreHttpResult.Success && !result.value.couldBeImage()) {
                    CoreHttpResult.Failure(UNAVAILABLE_COVER, null)
                } else {
                    result
                }
            }
            if (result is CoreHttpResult.Failure && result.statusCode in SESSION_INVALIDATING_STATUSES) {
                cachedEndpoint = null
            }
            if (result is CoreHttpResult.Failure && result.statusCode in UNAVAILABLE_COVER_STATUSES) {
                unavailableCovers.remember(reference)
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
        const val UNAVAILABLE_COVER = 502
        // Gateway failures describe the Suwayomi upstream, not the authenticated Core endpoint.
        val SESSION_INVALIDATING_STATUSES = setOf(401, 403)
        // Answers about the cover itself. Auth, endpoint and rate failures stay retryable at once.
        val UNAVAILABLE_COVER_STATUSES = setOf(404, 410, UNAVAILABLE_COVER)
    }
}

/** False for bytes that are plainly not an image: nothing, or a text, HTML or JSON document. */
internal fun ByteArray.couldBeImage(): Boolean {
    var index = 0
    if (size >= 3 && this[0] == 0xef.toByte() && this[1] == 0xbb.toByte() && this[2] == 0xbf.toByte()) index = 3
    while (index < size && this[index].toInt().toChar().isWhitespace()) index += 1
    if (index >= size) return false
    val first = this[index].toInt().toChar()
    return first != '<' && first != '{' && first != '['
}

/**
 * Covers the desktop recently could not serve, forgotten after [ttlMillis] so a fixed cover shows
 * up without restarting the app. Bounded so a large library cannot grow it without limit.
 */
class RecentCoverFailures(
    private val ttlMillis: Long = DEFAULT_TTL_MS,
    private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
    private val nowMillis: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private val failedAt = object : LinkedHashMap<String, Long>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>) = size > maxEntries
    }

    @Synchronized
    fun isRecent(reference: String): Boolean {
        val at = failedAt[reference] ?: return false
        if (nowMillis() - at < ttlMillis) return true
        failedAt.remove(reference)
        return false
    }

    @Synchronized
    fun remember(reference: String) {
        failedAt[reference] = nowMillis()
    }

    private companion object {
        const val DEFAULT_TTL_MS = 10 * 60 * 1_000L
        const val DEFAULT_MAX_ENTRIES = 2_048
    }
}
