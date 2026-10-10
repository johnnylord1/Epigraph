package epigraph.sync.core.session

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.util.Log
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.pairing.BootstrapBundleParser
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import okhttp3.HttpUrl.Companion.toHttpUrl

data class CoreEndpoint(
    val origin: String,
    val discovered: Boolean,
)

fun interface CoreEndpointResolver {
    suspend fun resolve(session: CoreCredentialSession): CoreEndpoint
}

class AndroidCoreEndpointResolver(
    context: Context,
    private val tlsClients: EpigraphCoreTlsClientFactory,
    private val clientVersion: String,
) : CoreEndpointResolver {
    private val nsd = context.applicationContext.getSystemService(NsdManager::class.java)

    override suspend fun resolve(session: CoreCredentialSession): CoreEndpoint {
        val candidates = pairedEndpointCandidates(session)
        Log.w(LOG_TAG, "endpoint candidates: ${candidates.joinToString()}")
        candidates.forEachIndexed { index, origin ->
            if (probe(origin, session)) return CoreEndpoint(origin, discovered = false)
            Log.w(LOG_TAG, "paired endpoint probe failed: candidate=${index + 1}")
        }
        require(session.serverId != LEGACY_UNBOUND_SERVER_ID) {
            "Legacy Core session must be revalidated before endpoint discovery"
        }
        val discovered = withTimeoutOrNull(DISCOVERY_TIMEOUT_MS) {
            discover(session)
        } ?: error("Paired Epigraph Core endpoint was not discovered")
        check(probe(discovered, session)) { "Discovered Epigraph Core endpoint failed authentication" }
        return CoreEndpoint(discovered, discovered = true)
    }

    private suspend fun probe(origin: String, session: CoreCredentialSession): Boolean =
        try {
            val client = EpigraphCoreHttpClient(
                tlsClients.create(session.tlsCertSha256),
                origin.toHttpUrl(),
                clientVersion,
            )
            session.withAccessTokenString { token ->
                when (val response = client.session(token)) {
                    is CoreHttpResult.Success -> {
                        val identityMatches =
                            (session.serverId == LEGACY_UNBOUND_SERVER_ID ||
                                response.value.serverId == session.serverId) &&
                                response.value.profileId == session.profileId &&
                                response.value.tlsCertSha256.equals(
                                    session.tlsCertSha256,
                                    ignoreCase = true,
                                )
                        if (!identityMatches) {
                            Log.w(LOG_TAG, "paired endpoint identity mismatch")
                        }
                        identityMatches
                    }
                    is CoreHttpResult.Failure -> {
                        if (response.statusCode == 401 || response.statusCode == 403) {
                            // Every candidate shares this credential; a revoked token cannot
                            // recover by retrying another origin.
                            throw CorePairingStaleException(
                                "Paired Core rejected the session token (HTTP ${response.statusCode}).",
                            )
                        }
                        Log.w(
                            LOG_TAG,
                            "paired endpoint rejected session: status=${response.statusCode} " +
                                "code=${response.errorEnvelope?.error?.code ?: "none"}",
                        )
                        false
                    }
                }
            }
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (stale: CorePairingStaleException) {
            throw stale
        } catch (error: Throwable) {
            if (error.hasFingerprintMismatch()) {
                throw CorePairingStaleException(
                    "Paired Core certificate fingerprint does not match the pinned pairing.",
                )
            }
            Log.w(
                LOG_TAG,
                "paired endpoint transport failed: ${error::class.simpleName}: ${error.message}",
            )
            Log.w(LOG_TAG, "paired endpoint transport stack: ${Log.getStackTraceString(error)}")
            false
        }

    private fun Throwable.hasFingerprintMismatch(): Boolean =
        generateSequence<Throwable>(this) { failure -> failure.cause?.takeIf { cause -> cause !== failure } }
            .take(MAX_CAUSE_DEPTH)
            .any { failure -> failure.message?.contains(FINGERPRINT_MISMATCH_MESSAGE) == true }

    private suspend fun discover(session: CoreCredentialSession): String {
        val serviceTypes = listOf(
            canonicalServiceType(session.mdnsServiceName),
            DEFAULT_SERVICE_TYPE,
            LEGACY_SERVICE_TYPE,
        ).distinct()
        val attemptTimeout = DISCOVERY_TIMEOUT_MS / serviceTypes.size
        serviceTypes.forEach { serviceType ->
            withTimeoutOrNull(attemptTimeout) {
                discoverServiceType(session, serviceType)
            }?.let { return it }
        }
        error("Epigraph Core discovery failed")
    }

    private suspend fun discoverServiceType(session: CoreCredentialSession, serviceType: String): String? =
        suspendCancellableCoroutine { continuation ->
            val completed = AtomicBoolean(false)
            val resolving = AtomicBoolean(false)
            lateinit var listener: NsdManager.DiscoveryListener

            fun finish(value: String?) {
                if (!completed.compareAndSet(false, true)) return
                runCatching { nsd.stopServiceDiscovery(listener) }
                continuation.resume(value)
            }

            listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(regType: String) = Unit
                override fun onServiceLost(service: NsdServiceInfo) = Unit
                override fun onDiscoveryStopped(serviceType: String) = Unit
                override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = finish(null)
                override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit

                override fun onServiceFound(service: NsdServiceInfo) {
                    if (!resolving.compareAndSet(false, true)) return
                    @Suppress("DEPRECATION")
                    nsd.resolveService(service, object : NsdManager.ResolveListener {
                        override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                            resolving.set(false)
                        }

                        override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                            val serverId = serviceInfo.attributes["sid"]?.toString(Charsets.UTF_8)
                            val fingerprint = serviceInfo.attributes["tls_sha256"]?.toString(Charsets.UTF_8)
                            if (serverId != session.serverId ||
                                !fingerprint.equals(session.tlsCertSha256, ignoreCase = true)
                            ) {
                                resolving.set(false)
                                return
                            }
                            val host = serviceInfo.host?.hostAddress?.substringBefore('%')
                            val renderedHost = if (host?.contains(':') == true) "[$host]" else host
                            val candidate = runCatching {
                                BootstrapBundleParser.normalizeLanHttpsOrigin(
                                    "https://$renderedHost:${serviceInfo.port}",
                                )
                            }.getOrNull()
                            if (candidate == null) resolving.set(false) else finish(candidate)
                        }
                    })
                }
            }
            continuation.invokeOnCancellation {
                if (completed.compareAndSet(false, true)) {
                    runCatching { nsd.stopServiceDiscovery(listener) }
                }
            }
            nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener)
        }

    private fun canonicalServiceType(value: String?): String {
        val type = value?.trim().orEmpty().ifEmpty { DEFAULT_SERVICE_TYPE }
            .removeSuffix("local.")
        require(type.startsWith("_") && type.contains("._tcp.")) {
            "Invalid Epigraph Core discovery service type"
        }
        return type
    }

    private companion object {
        const val LOG_TAG = "EpigraphCoreSync"
        const val DEFAULT_SERVICE_TYPE = "_epigraph-sync._tcp."
        const val LEGACY_SERVICE_TYPE = "_aethon-sync._tcp."
        const val DISCOVERY_TIMEOUT_MS = 5_000L
        const val FINGERPRINT_MISMATCH_MESSAGE = "fingerprint does not match"
        const val MAX_CAUSE_DEPTH = 8
    }
}

/**
 * Adds the Core's stable default port as a recovery candidate for an already-pinned host.
 *
 * Debug and migration builds have historically paired on alternate ports. A later normal desktop
 * launch returns to 4777, while Android emulators frequently cannot receive multicast DNS. The
 * fallback cannot connect to an unrelated Core silently: every probe still verifies the pinned
 * leaf certificate, server id, profile and authenticated session before accepting the endpoint.
 */
internal fun pairedEndpointCandidates(session: CoreCredentialSession): List<String> = buildList {
    val configured = listOf(session.lastKnownEndpoint, session.origin).distinct()
    addAll(configured)
    configured.forEach { origin ->
        runCatching {
            val url = origin.toHttpUrl()
            // A development Core keeps its own port and data; never probe the installed one for it.
            if (url.port != EPIGRAPH_CORE_DEFAULT_PORT && url.port != EPIGRAPH_CORE_DEV_PORT) {
                add(url.newBuilder().port(EPIGRAPH_CORE_DEFAULT_PORT).build().toString().removeSuffix("/"))
            }
        }
    }
}.distinct()

private const val EPIGRAPH_CORE_DEFAULT_PORT = 4777
private const val EPIGRAPH_CORE_DEV_PORT = 4787
