package epigraph.sync.core.trackers

import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.work.CoreNegotiatedSessionHook
import epigraph.sync.core.work.CoreOutboxSyncConnection

/**
 * Tracker work for one negotiated sync session: remember what the Core advertises for offline
 * writers, then converge tracker logins when (and only when) the Core advertises
 * `trackerCredentialsV1`. Credentials use the connection's pinned, paired TLS channel.
 */
class TrackerSyncSessionHook(
    private val capabilities: CoreCapabilityObserver,
    private val credentials: TrackerCredentialSyncer,
) : CoreNegotiatedSessionHook {
    override suspend fun onNegotiated(capabilities: CoreCapabilities, connection: CoreOutboxSyncConnection) {
        this.capabilities.onNegotiated(capabilities)
        if (!capabilities.supportsTrackerCredentialsV1) return
        val channel = connection.trackerCredentials() ?: return
        credentials.synchronize(channel)
    }
}
