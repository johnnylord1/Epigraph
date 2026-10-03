package epigraph.sync.core.pairing

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Collects every desktop Core announced during a short browse window.
 *
 * Resolves are serialized: older NsdManager versions allow only one resolve at a time and reject
 * the rest with FAILURE_ALREADY_ACTIVE. Emulators usually cannot receive multicast, in which case
 * the list is empty and the user falls back to QR or pasting the bundle.
 */
class AndroidCoreHostDiscovery(
    context: Context,
    private val browseWindowMs: Long = BROWSE_WINDOW_MS,
) : CoreHostDiscovery {
    private val nsd = context.applicationContext.getSystemService(NsdManager::class.java)

    override suspend fun discover(): List<DiscoveredCoreHost> {
        val found = Channel<NsdServiceInfo>(Channel.UNLIMITED)
        val listeners = SERVICE_TYPES.map { browseListener(found) }
        val hosts = mutableListOf<DiscoveredCoreHost>()
        try {
            SERVICE_TYPES.zip(listeners).forEach { (serviceType, listener) ->
                runCatching { nsd.discoverServices(serviceType, NsdManager.PROTOCOL_DNS_SD, listener) }
            }
            withTimeoutOrNull(browseWindowMs) {
                coroutineScope {
                    launch {
                        val seen = mutableSetOf<String>()
                        for (service in found) {
                            val key = "${service.serviceType}/${service.serviceName}"
                            if (!seen.add(key)) continue
                            resolve(service)?.let(hosts::add)
                        }
                    }
                }
            }
        } finally {
            listeners.forEach { listener -> runCatching { nsd.stopServiceDiscovery(listener) } }
            found.close()
        }
        return DiscoveredCoreHost.merge(hosts)
    }

    private fun browseListener(found: Channel<NsdServiceInfo>) = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(regType: String) = Unit
        override fun onServiceLost(service: NsdServiceInfo) = Unit
        override fun onDiscoveryStopped(serviceType: String) = Unit
        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) = Unit
        override fun onServiceFound(service: NsdServiceInfo) {
            found.trySend(service)
        }
    }

    private suspend fun resolve(service: NsdServiceInfo): DiscoveredCoreHost? =
        withTimeoutOrNull(RESOLVE_TIMEOUT_MS) {
            suspendCancellableCoroutine { continuation ->
                val listener = object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        if (continuation.isActive) continuation.resume(null)
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        if (!continuation.isActive) return
                        continuation.resume(
                            DiscoveredCoreHost.fromResolvedService(
                                instanceName = serviceInfo.serviceName.orEmpty(),
                                txt = serviceInfo.attributes.orEmpty(),
                                resolvedHost = serviceInfo.host?.hostAddress,
                                port = serviceInfo.port,
                            ),
                        )
                    }
                }
                try {
                    @Suppress("DEPRECATION")
                    nsd.resolveService(service, listener)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    if (continuation.isActive) continuation.resume(null)
                }
            }
        }

    private companion object {
        val SERVICE_TYPES = listOf("_epigraph-sync._tcp.", "_aethon-sync._tcp.")
        const val BROWSE_WINDOW_MS = 4_000L
        const val RESOLVE_TIMEOUT_MS = 2_000L
    }
}
