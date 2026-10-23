package epigraph.sync.core.trackers

import android.util.Log
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.work.CoreNegotiatedSessionHook
import epigraph.sync.core.work.CoreOutboxSyncConnection

private const val LOG_TAG = "EpigraphTrackerSync"

/**
 * Tracker work for one negotiated sync session: remember what the Core advertises for offline
 * writers, then converge tracker logins when (and only when) the Core advertises
 * `trackerCredentialsV1`. Credentials use the connection's pinned, paired TLS channel. Every
 * session retries what failed, so a login that could not be sent goes out on the next one.
 */
class TrackerSyncSessionHook(
    private val capabilities: CoreCapabilityObserver,
    private val credentials: TrackerCredentialSyncer,
) : CoreNegotiatedSessionHook {
    override suspend fun onNegotiated(capabilities: CoreCapabilities, connection: CoreOutboxSyncConnection) {
        this.capabilities.onNegotiated(capabilities)
        if (!capabilities.supportsTrackerCredentialsV1) {
            Log.i(LOG_TAG, "tracker logins skipped: Core does not offer them")
            return
        }
        val channel = connection.trackerCredentials() ?: run {
            Log.w(LOG_TAG, "tracker logins skipped: no credential channel")
            return
        }
        val report = credentials.synchronize(channel)
        // Counts, tracker keys and HTTP statuses only; values never reach the log.
        val summary = "tracker logins: sent=${report.pushed} received=${report.applied} " +
            "conflicts=${report.conflicts} failed=${report.failed}"
        if (report.failed > 0) {
            Log.w(LOG_TAG, "$summary (${report.failures.joinToString()})")
        } else {
            Log.i(LOG_TAG, summary)
        }
    }
}
