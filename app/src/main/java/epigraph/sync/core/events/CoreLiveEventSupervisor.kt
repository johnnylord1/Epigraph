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
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
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
) {
    private val logger = Logger.withTag(LOG_TAG)
    private val connectivity = context.applicationContext
        .getSystemService(ConnectivityManager::class.java)
    private val started = AtomicBoolean(false)

    /** Starts at most one process-lifetime supervisor. Cancellation is owned by [scope]. */
    fun start(scope: CoroutineScope) {
        if (!started.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO + CoroutineName("aethon-core-live-events")) {
            runSupervisor()
        }
    }

    private suspend fun runSupervisor() {
        while (currentCoroutineContext().isActive) {
            val session = runCatching { credentialsStore.load() }
                .onFailure { logger.w { "Could not load Core credentials" } }
                .getOrNull()
            if (session == null) {
                delay(NO_SESSION_RETRY_MS)
                continue
            }

            try {
                runAuthenticatedSession(session)
            } catch (cancelled: CancellationException) {
                throw cancelled
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

    private suspend fun runAuthenticatedSession(credentials: CoreCredentialSession) {
        val endpoint = endpointResolver.resolve(credentials)
        val sessionTransports = transports.create(credentials, endpoint.origin)
        val capabilities = when (val response = sessionTransports.http.capabilities()) {
            is CoreHttpResult.Success -> response.value
            is CoreHttpResult.Failure -> error("Core capabilities failed: ${response.statusCode}")
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
            policy.selectedScopes.map { scopeId ->
                launch(CoroutineName("aethon-core-events-$scopeId")) {
                    runScope(
                        credentials = credentials,
                        capabilities = capabilities,
                        scopeId = scopeId,
                        sessionTransports = sessionTransports,
                    )
                }
            }.joinAll()
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
        val reconnect = ExponentialCoreReconnectGate()
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
                        // A 401/403 must make the parent reload the encrypted credential. Do not
                        // spin on a revoked token and do not expose the token in logs.
                        scheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
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

    private class ExponentialCoreReconnectGate : CoreReconnectGate {
        override suspend fun awaitRetry(attempt: Int, reason: CoreReconnectReason) {
            val exponent = (attempt - 1).coerceIn(0, 5)
            delay((1_000L shl exponent).coerceAtMost(MAX_RECONNECT_DELAY_MS))
        }
    }

    private class CoreLiveEventNeedsUserAction(statusCode: Int) :
        IllegalStateException("Core event stream requires user action ($statusCode)")

    private companion object {
        const val LOG_TAG = "EpigraphCoreLiveEvents"
        const val NETWORK_POLL_MS = 2_000L
        const val NO_SESSION_RETRY_MS = 5_000L
        const val NO_SELECTED_SCOPE_RETRY_MS = 15_000L
        const val SCOPE_RETRY_MS = 5_000L
        const val SESSION_RETRY_MS = 10_000L
        const val MAX_RECONNECT_DELAY_MS = 30_000L
    }
}
