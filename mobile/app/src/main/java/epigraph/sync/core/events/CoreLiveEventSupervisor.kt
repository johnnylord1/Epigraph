package epigraph.sync.core.events

import android.content.Context
import android.net.ConnectivityManager
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.policy.SyncPolicyResolver
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.replica.CoreReplicaApplier
import epigraph.sync.core.replica.CoreReplicaCheckpointReader
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreReplaySession
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.work.CoreDeviceIdentityProvider
import epigraph.sync.core.work.CoreSyncPause
import epigraph.sync.core.work.InMemoryCoreSyncPause
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import co.touchlab.kermit.Logger

/**
 * Keeps the authenticated Core event feed alive while the Android process is alive.
 *
 * WorkManager remains the durable wake-up path when the process is killed. This supervisor is
 * the low-latency path for a foreground/background process: every selected scope has a filtered
 * SSE stream, and [CoreDurableChangeSink] acknowledges an event only after the replica and its
 * checkpoint commit in the same SQLDelight transaction.
 *
 * Nothing in this class installs an extension or plugin. Dependency inventory is deliberately
 * read/review-only; the existing settings activities remain the only place where a user can
 * approve repositories or start an individual/all installation flow.
 */
class CoreLiveEventSupervisor(
    context: Context,
    private val credentialsStore: CoreCredentialStore,
    private val endpointResolver: CoreEndpointResolver,
    private val transports: CoreSessionTransportFactory,
    private val policyResolver: SyncPolicyResolver,
    private val devices: CoreDeviceIdentityProvider,
    private val checkpoints: CoreReplicaCheckpointReader,
    private val applier: CoreReplicaApplier,
    private val scheduler: CoreBackgroundSyncScheduler,
    private val syncPause: CoreSyncPause = InMemoryCoreSyncPause(),
    private val catalogRevisions: CoreCatalogRevisionWatcher? = null,
) {
    private val logger = Logger.withTag(LOG_TAG)
    private val connectivity = context.applicationContext
        .getSystemService(ConnectivityManager::class.java)
    private val started = AtomicBoolean(false)
    private val rejectedCredentials = RejectedCoreCredentialGate(REJECTED_CREDENTIAL_RECHECK_MS)

    /** Starts at most one process-lifetime supervisor. Cancellation is owned by [scope]. */
    fun start(scope: CoroutineScope) {
        if (!started.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO + CoroutineName("epigraph-core-live-events")) {
            runSupervisor()
        }
    }

    private suspend fun runSupervisor() {
        while (currentCoroutineContext().isActive) {
            // Disconnected from Settings: hold the feed closed until sync is reconnected.
            syncPause.paused.first { paused -> !paused }
            val session = runCatching { credentialsStore.load() }
                .onFailure { logger.w { "Could not load Core credentials" } }
                .getOrNull()
            if (session == null) {
                delay(NO_SESSION_RETRY_MS)
                continue
            }
            if (!rejectedCredentials.allows(liveCredentialKey(session))) {
                // Core rejected exactly this credential. Wait for re-pairing or for the worker to
                // store refreshed scopes instead of hammering the desktop with a revoked token.
                session.close()
                delay(NO_SESSION_RETRY_MS)
                continue
            }

            try {
                runUntilPaused { runAuthenticatedSession(session) }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: CoreLiveSessionChanged) {
                logger.i { "live Core feed restarting: credential or sync selection changed" }
            } catch (needsUserAction: CoreLiveEventNeedsUserAction) {
                logger.w { needsUserAction.message.orEmpty() }
                if (rejectedCredentials.reject(liveCredentialKey(session))) {
                    // One worker run turns the rejection into a visible re-pair/authorization state.
                    scheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
                }
            } catch (failure: Throwable) {
                logger.w {
                    "live Core feed stopped: ${failure::class.simpleName ?: "UnknownFailure"}"
                }
                // The WorkManager path retries the outbox and performs a full replica pass. The
                // live path only needs a short quiet period before reloading the credential and
                // endpoint, which also handles token rotation/revocation without retaining it.
                delay(SESSION_RETRY_MS)
            } finally {
                session.close()
            }
        }
    }

    /** Runs [block], closing it as soon as sync is disconnected so the feed drops right away. */
    private suspend fun runUntilPaused(block: suspend () -> Unit) {
        coroutineScope {
            val live = launch { block() }
            val pauseWatch = launch {
                syncPause.paused.first { paused -> paused }
                live.cancel()
            }
            live.join()
            pauseWatch.cancel()
        }
    }

    private suspend fun runAuthenticatedSession(credentials: CoreCredentialSession) {
        val endpoint = endpointResolver.resolve(credentials)
        val sessionTransports = transports.create(credentials, endpoint.origin)
        val capabilities = when (val response = sessionTransports.http.capabilities()) {
            is CoreHttpResult.Success -> response.value
            is CoreHttpResult.Failure -> {
                if (response.statusCode.isAuthorizationFailure()) {
                    throw CoreLiveEventNeedsUserAction(response.statusCode)
                }
                error("Core capabilities failed: ${response.statusCode}")
            }
        }
        val policy = policyResolver.resolve(
            credentials = credentials,
            capabilities = capabilities,
            deviceId = devices.currentDeviceId(),
        )
        if (policy.selectedScopes.isEmpty()) {
            delay(NO_SELECTED_SCOPE_RETRY_MS)
            return
        }

        // A revoked token in one scope invalidates the credential session for all scopes. Use a
        // regular scope so the parent reloads the encrypted credential instead of leaving other
        // streams attached to a session that Core has rejected.
        coroutineScope {
            policy.selectedScopes.forEach { scopeId ->
                launch(CoroutineName("epigraph-core-events-$scopeId")) {
                    runScope(
                        credentials = credentials,
                        capabilities = capabilities,
                        scopeId = scopeId,
                        sessionTransports = sessionTransports,
                    )
                }
            }
            launch(CoroutineName("epigraph-core-events-watch")) {
                watchSession(credentials, capabilities, policy.selectedScopes)
            }
            catalogRevisions?.let { watcher ->
                // Desktop library and extension changes are not on the event feed; see the watcher.
                launch(CoroutineName("epigraph-core-catalog-revisions")) {
                    watcher.watch(credentials, capabilities)
                }
            }
        }
    }

    /**
     * Streams are opened for the scopes granted when the session started. The worker refreshes
     * scopes through `/v1/session`, the user may change the sync selection or disconnect, and a
     * new pairing rotates the token; any of these restarts the feed with the stored credential.
     */
    private suspend fun watchSession(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        selectedScopes: Set<String>,
    ) {
        while (currentCoroutineContext().isActive) {
            delay(SESSION_WATCH_MS)
            val latest = try {
                credentialsStore.load()
            } catch (_: Exception) {
                continue
            } ?: throw CoreLiveSessionChanged()
            val changed = latest.use { stored ->
                val latestScopes = try {
                    policyResolver.resolve(stored, capabilities, devices.currentDeviceId()).selectedScopes
                } catch (_: Exception) {
                    return@use false
                }
                liveSessionChanged(credentials, selectedScopes, stored, latestScopes)
            }
            if (changed) throw CoreLiveSessionChanged()
        }
    }

    private suspend fun runScope(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        scopeId: String,
        sessionTransports: epigraph.sync.core.session.CoreSessionTransports,
    ) {
        val coverage = CoreReplayCoverage.Filtered(scopeId)
        val network = AndroidCoreNetworkGate(connectivity)
        val reconnect = ExponentialCoreReconnectGate(logger, scopeId)
        val sink = CoreDurableChangeSink { change, nextCheckpoint ->
            applier.applyChange(
                change = change,
                nextCheckpoint = nextCheckpoint,
                capabilities = capabilities,
                originServerId = credentials.serverId,
            )
        }
        val bootstrap = CoreFullBootstrap {
            snapshotSession(
                credentials = credentials,
                capabilities = capabilities,
                scopeId = scopeId,
                http = sessionTransports.http,
            )
        }
        val connection = CoreEventConnection { replaySession ->
            credentials.withAccessTokenString { token ->
                sessionTransports.events.collect(token, replaySession, sink)
            }
        }
        val orchestrator = CoreEventOrchestrator(network, reconnect, bootstrap, connection)

        while (currentCoroutineContext().isActive) {
            try {
                val initial = initialSession(
                    credentials = credentials,
                    capabilities = capabilities,
                    scopeId = scopeId,
                    http = sessionTransports.http,
                )
                when (val result = orchestrator.run(initial)) {
                    is CoreEventLoopResult.NeedsUserAction -> {
                        // A 401/403 parks this credential in the parent until it changes. Do not
                        // spin on a revoked token and do not expose the token in logs.
                        throw CoreLiveEventNeedsUserAction(result.statusCode)
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (needsUserAction: CoreLiveEventNeedsUserAction) {
                throw needsUserAction
            } catch (failure: Throwable) {
                logger.w {
                    "scope $scopeId live feed retry: ${failure::class.simpleName ?: "UnknownFailure"}"
                }
                delay(SCOPE_RETRY_MS)
            }
        }
    }

    private suspend fun initialSession(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        scopeId: String,
        http: epigraph.sync.core.http.EpigraphCoreHttpClient,
    ): CoreReplaySession {
        checkpoints.latestCheckpoint(CoreReplayCoverage.Filtered(scopeId))?.let { checkpoint ->
            return CoreReplaySession.afterSnapshot(checkpoint.lastGlobalEventId, checkpoint.coverage)
        }
        return snapshotSession(credentials, capabilities, scopeId, http)
    }

    private suspend fun snapshotSession(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        scopeId: String,
        http: epigraph.sync.core.http.EpigraphCoreHttpClient,
    ): CoreReplaySession = credentials.withAccessTokenString { token ->
        when (val response = http.snapshot(token, scopeId)) {
            is CoreHttpResult.Success -> {
                val applied = applier.applySnapshot(
                    snapshot = response.value,
                    capabilities = capabilities,
                    originServerId = credentials.serverId,
                )
                CoreReplaySession.afterSnapshot(
                    applied.checkpoint.lastGlobalEventId,
                    applied.checkpoint.coverage,
                )
            }
            is CoreHttpResult.Failure -> {
                if (response.statusCode.isAuthorizationFailure()) {
                    throw CoreLiveEventNeedsUserAction(response.statusCode)
                }
                error("Core snapshot failed for $scopeId: ${response.statusCode}")
            }
        }
    }

    private class AndroidCoreNetworkGate(
        private val connectivity: ConnectivityManager?,
    ) : CoreNetworkGate {
        override suspend fun awaitAvailable() {
            while (currentCoroutineContext().isActive) {
                // LAN-only Core deployments may not advertise VALIDATED/INTERNET. An active
                // network is therefore the correct gate; the stream itself handles reachability.
                if (connectivity == null || connectivity.activeNetwork != null) return
                delay(NETWORK_POLL_MS)
            }
        }
    }

    private class ExponentialCoreReconnectGate(
        private val logger: Logger,
        private val scopeId: String,
    ) : CoreReconnectGate {
        override suspend fun awaitRetry(attempt: Int, reason: CoreReconnectReason) {
            val exponent = (attempt - 1).coerceIn(0, 5)
            val delayMs = (1_000L shl exponent).coerceAtMost(MAX_RECONNECT_DELAY_MS)
            logger.i { "scope $scopeId live feed reconnect #$attempt in ${delayMs}ms: $reason" }
            delay(delayMs)
        }
    }

    private class CoreLiveEventNeedsUserAction(statusCode: Int) :
        IllegalStateException("Core event stream requires user action ($statusCode)")

    private class CoreLiveSessionChanged : IllegalStateException("Core live session changed")

    private fun Int.isAuthorizationFailure() = this == 401 || this == 403

    private companion object {
        const val LOG_TAG = "EpigraphCoreLiveEvents"
        const val NETWORK_POLL_MS = 2_000L
        const val NO_SESSION_RETRY_MS = 5_000L
        const val NO_SELECTED_SCOPE_RETRY_MS = 15_000L
        const val SCOPE_RETRY_MS = 5_000L
        const val SESSION_RETRY_MS = 10_000L
        const val SESSION_WATCH_MS = 30_000L
        const val REJECTED_CREDENTIAL_RECHECK_MS = 15 * 60_000L
        const val MAX_RECONNECT_DELAY_MS = 30_000L
    }
}

/** Identity of a stored credential as far as the live feed is concerned; never includes the token. */
internal fun liveCredentialKey(session: CoreCredentialSession): String =
    listOf(session.serverId, session.profileId, session.tokenId, session.scopes.sorted().joinToString(","))
        .joinToString("|")

internal fun liveSessionChanged(
    running: CoreCredentialSession,
    runningScopes: Set<String>,
    stored: CoreCredentialSession,
    storedScopes: Set<String>,
): Boolean = running.tokenId != stored.tokenId ||
    running.serverId != stored.serverId ||
    running.profileId != stored.profileId ||
    runningScopes != storedScopes

/**
 * Remembers the credential Core answered with 401/403. The same credential is not retried until it
 * changes (re-pairing, refreshed scopes) or [recheckMs] passes, so a revoked token costs one worker
 * run instead of a request every few seconds.
 */
internal class RejectedCoreCredentialGate(
    private val recheckMs: Long,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private var rejectedKey: String? = null
    private var rejectedAtMs: Long = 0

    @Synchronized
    fun allows(key: String): Boolean {
        val rejected = rejectedKey ?: return true
        if (rejected != key || nowMs() - rejectedAtMs >= recheckMs) {
            rejectedKey = null
            return true
        }
        return false
    }

    /** Returns true only the first time [key] is rejected in a row. */
    @Synchronized
    fun reject(key: String): Boolean {
        val first = rejectedKey != key
        rejectedKey = key
        rejectedAtMs = nowMs()
        return first
    }
}
