package epigraph.sync.core.work

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.assets.BookAssetCoordinator
import epigraph.sync.core.assets.BookAssetDrainReport
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.EpigraphCoreMutationGateway
import epigraph.sync.core.outbox.CoreLamportSource
import epigraph.sync.core.outbox.CoreOutboxAuthorization
import epigraph.sync.core.outbox.CoreOutboxDrainConfig
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.outbox.CoreOutboxDrainer
import epigraph.sync.core.outbox.CoreOutboxRetryPlanner
import epigraph.sync.core.outbox.CoreOutboxStore
import epigraph.sync.core.outbox.CoreRequestIdSource
import epigraph.sync.core.outbox.CoreV1OutboxAdapter
import epigraph.sync.core.outbox.CredentialCoreAccessTokenLease
import epigraph.sync.core.pairing.AndroidPairingDeviceProvider
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreCompatibility
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.policy.EffectiveSyncPolicy
import epigraph.sync.core.policy.SyncPolicyResolver
import epigraph.sync.core.replica.CoreReplicaApplier
import epigraph.sync.core.replica.CoreReplicaCheckpointReader
import epigraph.sync.core.replica.CoreReplicaCheckpointResetter
import epigraph.sync.core.replica.fetchAndApplySnapshot
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport
import epigraph.sync.core.suwayomi.SuwayomiMutationQueueDrainer
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import epigraph.sync.core.trackers.TrackerCredentialChannel
import epigraph.contract.ClientMutationId
import epigraph.sync.EpigraphMutationCoordinator
import android.util.Log
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import yokai.data.DatabaseHandler
import java.util.UUID

private val coreSyncLogger = Logger.withTag("EpigraphCoreSync")

interface CorePendingOutbox {
    /** Rows that still need submission. This count controls the drain loop. */
    suspend fun count(): Long

    /** Submitted rows plus accepted mutations still waiting for their canonical replica. */
    suspend fun unsettledCount(): Long = count()

    suspend fun countActive(policy: EffectiveSyncPolicy): Long = count()

    suspend fun unsettledCountActive(policy: EffectiveSyncPolicy): Long = unsettledCount()

    /** Unsettled rows parked for a user decision, which no sync run sends until the user acts. */
    suspend fun blockedCountActive(policy: EffectiveSyncPolicy): Long = 0

    /**
     * Unsent library rows (entries, folders, assignments) without reading state or blocked rows;
     * null when unknown. Once it reaches zero the desktop's first run can let the user continue.
     */
    suspend fun libraryCountActive(policy: EffectiveSyncPolicy): Long? = null

    /** Queues again the parked rows this version can now repair, before the run counts them. */
    suspend fun retryRepairable(nowEpochMillis: Long) = Unit
}

class CoordinatorPendingOutbox(
    private val coordinator: EpigraphMutationCoordinator,
    private val database: DatabaseHandler,
) : CorePendingOutbox {
    override suspend fun count(): Long = coordinator.pendingCount() + database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() +
            aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
            aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
    }

    override suspend fun unsettledCount(): Long = coordinator.unsettledCount() + database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() +
            aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
            aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
    }

    override suspend fun countActive(policy: EffectiveSyncPolicy): Long =
        coordinator.pendingCount(policy.selectedScopes) + database.await {
            (if (policy.syncComics) {
                aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne()
            } else {
                0
            }) + (if (policy.transferBookAssets) {
                aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
                    aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
            } else {
                0
            })
        }

    override suspend fun blockedCountActive(policy: EffectiveSyncPolicy): Long =
        coordinator.blockedCount(policy.selectedScopes)

    override suspend fun libraryCountActive(policy: EffectiveSyncPolicy): Long =
        coordinator.pendingLibraryCount(policy.selectedScopes) + if (policy.syncComics) {
            database.await { aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() }
        } else {
            0
        }

    override suspend fun retryRepairable(nowEpochMillis: Long) {
        coordinator.retryRepairablePageCounts(nowEpochMillis) { ClientMutationId(UUID.randomUUID().toString()) }
        coordinator.retryCoreServedComicIds(nowEpochMillis) { ClientMutationId(UUID.randomUUID().toString()) }
    }

    override suspend fun unsettledCountActive(policy: EffectiveSyncPolicy): Long =
        coordinator.unsettledCount(policy.selectedScopes) + database.await {
            (if (policy.syncComics) {
                aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne()
            } else {
                0
            }) + (if (policy.transferBookAssets) {
                aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
                    aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
            } else {
                0
            })
        }
}

fun interface CoreDeviceIdentityProvider {
    fun currentDeviceId(): String
}

class AndroidCoreDeviceIdentityProvider(
    private val provider: AndroidPairingDeviceProvider,
) : CoreDeviceIdentityProvider {
    override fun currentDeviceId(): String = provider.current().id
}

class CoreOutboxDrainerFactory(
    private val store: CoreOutboxStore,
    private val adapter: CoreV1OutboxAdapter,
    private val lamports: CoreLamportSource,
    private val requestIds: CoreRequestIdSource,
    private val retryPlanner: CoreOutboxRetryPlanner,
    private val config: CoreOutboxDrainConfig = CoreOutboxDrainConfig(),
) {
    fun create(http: EpigraphCoreHttpClient): CoreOutboxDrainer = CoreOutboxDrainer(
        store = store,
        adapter = adapter,
        gateway = EpigraphCoreMutationGateway(http),
        lamports = lamports,
        requestIds = requestIds,
        retryPlanner = retryPlanner,
        config = config,
    )
}

interface CoreOutboxSyncConnection {
    /** The Core origin that answered the endpoint probe and opened this connection. */
    val openedOrigin: String

    suspend fun sessionMetadata(): CoreHttpResult<epigraph.sync.core.protocol.CoreSessionResponse>? = null

    suspend fun capabilities(): CoreHttpResult<CoreCapabilities>

    /**
     * Optional server-side projection readiness; older Core versions return null. [pendingUploads]
     * tells the Core what this device still has to send after the run, and [pendingLibraryUploads]
     * how much of it is library rather than reading state; null leaves the Core's last count.
     */
    suspend fun syncStatus(
        scopeId: String,
        pendingUploads: Long? = null,
        pendingLibraryUploads: Long? = null,
    ): CoreHttpResult<epigraph.sync.core.protocol.CoreSyncStatus>? = null

    suspend fun drainBookAssets(nowEpochMillis: Long): BookAssetDrainReport =
        BookAssetDrainReport(0, 0, 0, 0)

    suspend fun drainSuwayomi(
        nowEpochMillis: Long,
        canonicalProjectionEnabled: Boolean,
    ): SuwayomiMutationDrainReport

    suspend fun drain(
        authorization: CoreOutboxAuthorization,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreOutboxDrainReport

    /** Tracker credential endpoints on this paired session; null when the connection has none. */
    fun trackerCredentials(): TrackerCredentialChannel? = null

    /** Direct Suwayomi commands on this paired session; null when the connection has none. */
    fun suwayomiCommands(): SuwayomiCommandChannel? = null
}

/** Direct Suwayomi mutation commands on a paired Core session. */
interface SuwayomiCommandChannel {
    val serverId: String
    val profileId: String
    suspend fun command(request: SuwayomiCommandRequest): CoreHttpResult<SuwayomiCommandResponse>
}

/**
 * Runs after a sync connection negotiated compatible capabilities. Hooks are best effort: a
 * failure never fails the outbox or replica run.
 */
fun interface CoreNegotiatedSessionHook {
    suspend fun onNegotiated(capabilities: CoreCapabilities, connection: CoreOutboxSyncConnection)
}

/**
 * Runs after a replica pass applied the Core state, before the run counts what is still unsettled,
 * so work queued here is reported and drained by the next run. Best effort, like
 * [CoreNegotiatedSessionHook].
 */
fun interface CoreReplicaAppliedHook {
    suspend fun onReplicaApplied(nowEpochMillis: Long)
}

/**
 * Runs once the device's sync selection is resolved, before the outbox drains, so work queued here
 * honors the user's choices and leaves in the same run. Best effort, like [CoreNegotiatedSessionHook].
 */
fun interface CoreSyncPolicyHook {
    suspend fun onPolicyResolved(policy: EffectiveSyncPolicy)
}

fun interface CoreOutboxSyncConnectionFactory {
    suspend fun open(credentials: CoreCredentialSession): CoreOutboxSyncConnection
}

class PinnedCoreOutboxSyncConnectionFactory(
    private val transports: CoreSessionTransportFactory,
    private val drainers: CoreOutboxDrainerFactory,
    private val suwayomiMutations: SuwayomiMutationQueueDrainer,
    private val endpointResolver: epigraph.sync.core.session.CoreEndpointResolver,
    private val bookAssets: BookAssetCoordinator,
) : CoreOutboxSyncConnectionFactory {
    override suspend fun open(credentials: CoreCredentialSession): CoreOutboxSyncConnection {
        val endpoint = endpointResolver.resolve(credentials)
        val transport = transports.create(credentials, endpoint.origin)
        val http = transport.http
        val drainer = drainers.create(http)
        return object : CoreOutboxSyncConnection {
            override val openedOrigin: String = endpoint.origin

            override suspend fun sessionMetadata(): CoreHttpResult<epigraph.sync.core.protocol.CoreSessionResponse> =
                credentials.withAccessTokenString(http::session)

            override suspend fun capabilities(): CoreHttpResult<CoreCapabilities> = http.capabilities()

            override suspend fun syncStatus(
                scopeId: String,
                pendingUploads: Long?,
                pendingLibraryUploads: Long?,
            ): CoreHttpResult<epigraph.sync.core.protocol.CoreSyncStatus> =
                credentials.withAccessTokenString { token ->
                    http.syncStatus(token, scopeId, pendingUploads, pendingLibraryUploads)
                }

            override suspend fun drainBookAssets(nowEpochMillis: Long): BookAssetDrainReport =
                bookAssets.drainPendingTransfers(transport.assets, credentials, nowEpochMillis)

            override suspend fun drainSuwayomi(
                nowEpochMillis: Long,
                canonicalProjectionEnabled: Boolean,
            ): SuwayomiMutationDrainReport = suwayomiMutations.drain(
                credentials,
                transport.suwayomi,
                nowEpochMillis,
                canonicalProjectionEnabled,
            )

            override suspend fun drain(
                authorization: CoreOutboxAuthorization,
                capabilities: CoreCapabilities,
                nowEpochMillis: Long,
            ): CoreOutboxDrainReport = drainer.drain(authorization, capabilities, nowEpochMillis)

            override fun trackerCredentials(): TrackerCredentialChannel = object : TrackerCredentialChannel {
                override suspend fun list() = credentials.withAccessTokenString(http::trackerCredentials)

                override suspend fun put(trackerKey: String, write: CoreTrackerCredentialWrite) =
                    credentials.withAccessTokenString { token -> http.putTrackerCredential(token, trackerKey, write) }

                override suspend fun delete(trackerKey: String, delete: CoreTrackerCredentialDelete) =
                    credentials.withAccessTokenString { token ->
                        http.deleteTrackerCredential(token, trackerKey, delete)
                    }
            }

            override fun suwayomiCommands(): SuwayomiCommandChannel? {
                val scopeId = "comics:profile:${credentials.profileId}"
                if (scopeId !in credentials.scopes) return null
                return object : SuwayomiCommandChannel {
                    override val serverId: String = credentials.serverId
                    override val profileId: String = credentials.profileId
                    override suspend fun command(request: SuwayomiCommandRequest) =
                        transport.suwayomi.command(credentials, request)
                }
            }
        }
    }
}

/** Explicit hand-off point for snapshot/replay integration owned by the replica layer. */
fun interface CoreReplicaSyncPort {
    suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome
}

enum class CoreReplicaSyncOutcome {
    APPLIED,
    DEFERRED,
    RETRY,
    NEEDS_USER_ACTION,
}

object DeferredCoreReplicaSync : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome = CoreReplicaSyncOutcome.DEFERRED
}

/**
 * Core-v1 replica synchronization. The first pass for a scope is authoritative; subsequent passes
 * replay `/v1/changes` from the durable cursor and fall back to a scope snapshot when replay has
 * expired. The local outbox is outside the replica tables and remains untouched.
 */
class SnapshotCoreReplicaSync(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: epigraph.sync.core.session.CoreEndpointResolver,
    private val applier: CoreReplicaApplier,
    private val checkpoints: CoreReplicaCheckpointReader,
    private val historyResetter: CoreReplicaCheckpointResetter? = null,
) : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        require(nowEpochMillis >= 0) { "sync timestamp must be epoch milliseconds" }
        if (!capabilities.supportsSnapshot) return CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        val scopes = credentials.scopes.distinct()
        if (scopes.isEmpty()) return CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        val endpoint = try {
            endpoints.resolve(credentials).origin
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return CoreReplicaSyncOutcome.RETRY
        }
        val http = transports.create(credentials, endpoint).http
        return credentials.withAccessTokenString { accessToken ->
            for (scopeId in scopes) {
                try {
                    val coverage = CoreReplayCoverage.Filtered(scopeId)
                    val checkpoint = checkpoints.latestCheckpoint(coverage)
                    val response = checkpoint?.let {
                        http.changes(accessToken, it.lastGlobalEventId, scopeId)
                    }
                    // A Core whose change log was rewound publishes versions below cursors this
                    // phone already holds. Every new change would then look already applied, so the
                    // whole replica history is forgotten and each scope is rebuilt from a snapshot.
                    val publishedVersion = when (response) {
                        is CoreHttpResult.Success -> response.value.currentServerVersion
                        is CoreHttpResult.Failure -> response.errorEnvelope?.error?.currentServerVersion
                        null -> null
                    }
                    if (
                        checkpoint != null &&
                        publishedVersion != null &&
                        publishedVersion < checkpoint.lastGlobalEventId &&
                        historyResetter != null
                    ) {
                        historyResetter.reset()
                        when (
                            val snapshot = applier.fetchAndApplySnapshot(http, accessToken, scopeId, capabilities, credentials.serverId)
                        ) {
                            is CoreHttpResult.Success -> Unit
                            is CoreHttpResult.Failure -> return@withAccessTokenString snapshot.toReplicaOutcome()
                        }
                        continue
                    }
                    when (response) {
                        is CoreHttpResult.Success -> applier.applyChanges(
                            response.value,
                            coverage,
                            capabilities,
                            credentials.serverId,
                        )
                        is CoreHttpResult.Failure -> {
                            // A replay response can exceed the client's bounded JSON envelope
                            // even when the Core is healthy (the comics scope can contain a
                            // large history). Treat the bounded-response signal like an expired
                            // cursor and bootstrap from the authoritative snapshot instead of
                            // surfacing a misleading NEEDS_USER_ACTION state. The snapshot is
                            // independently bounded and remains the complete source of truth.
                            if (!response.isReplayWindowExpired && response.statusCode != 413) {
                                if (BuildConfig.DEBUG) {
                                    runCatching {
                                        Log.d(
                                            "EpigraphCoreSync",
                                            "replay rejected: scope=$scopeId status=${response.statusCode} " +
                                                "code=${response.errorEnvelope?.error?.code}",
                                        )
                                    }
                                }
                                return@withAccessTokenString response.toReplicaOutcome()
                            }
                            if (BuildConfig.DEBUG) {
                                runCatching {
                                    Log.d(
                                        "EpigraphCoreSync",
                                        "replay bootstrap via snapshot: scope=$scopeId " +
                                            "reason=${if (response.isReplayWindowExpired) "expired" else "bounded"}",
                                    )
                                }
                            }
                            when (
                                val snapshot = applier.fetchAndApplySnapshot(http, accessToken, scopeId, capabilities, credentials.serverId)
                            ) {
                                is CoreHttpResult.Success -> Unit
                                is CoreHttpResult.Failure -> return@withAccessTokenString snapshot.toReplicaOutcome()
                            }
                        }
                        null -> when (
                            val snapshot = applier.fetchAndApplySnapshot(http, accessToken, scopeId, capabilities, credentials.serverId)
                        ) {
                            is CoreHttpResult.Success -> Unit
                            is CoreHttpResult.Failure -> return@withAccessTokenString snapshot.toReplicaOutcome()
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    reportCoreSyncFailure(
                        "replica.${scopeId.substringBefore(':')}",
                        failure,
                    )
                    throw failure
                }
            }
            CoreReplicaSyncOutcome.APPLIED
        }
    }
}

/**
 * Runs confirmed Core state and the read-only Suwayomi catalog flow independently. Suwayomi stays
 * authoritative for comic catalog/content, while Core snapshot/replay carries confirmed comic
 * reading state (history, bookmarks and chapter state) alongside novels and books.
 */
class CompositeCoreReplicaSync(
    private val replica: CoreReplicaSyncPort,
    private val catalog: CoreReplicaSyncPort,
    private val extensionInventory: CoreReplicaSyncPort = DeferredCoreReplicaSync,
    private val novelPlugins: CoreReplicaSyncPort = DeferredCoreReplicaSync,
    private val policyResolver: SyncPolicyResolver? = null,
    private val devices: CoreDeviceIdentityProvider? = null,
    private val portableManifest: CoreReplicaSyncPort = DeferredCoreReplicaSync,
    private val portableNovelManifest: CoreReplicaSyncPort = DeferredCoreReplicaSync,
    private val revisions: CoreCatalogRevisionGate? = null,
) : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome = coroutineScope {
        val policy = policyResolver?.let { resolver ->
            devices?.let { provider -> resolver.resolve(credentials, capabilities, provider.currentDeviceId()) }
        }
        val hasComicScope = credentials.scopes.any { it == "comics:profile:${credentials.profileId}" }
        val hasNovelScope = credentials.scopes.any { it == "novels:profile:${credentials.profileId}" }
        val hasBookScope = "books:global" in credentials.scopes
        val replicaScopes = credentials.scopes.filter { scope ->
            (scope == "books:global" && (policy?.syncBooks ?: hasBookScope)) ||
                (scope == "novels:profile:${credentials.profileId}" && (policy?.syncNovels ?: hasNovelScope)) ||
                (scope == "comics:profile:${credentials.profileId}" && (policy?.syncComics ?: hasComicScope))
        }
        // One status read tells which comic stages the desktop changed since this device applied
        // them; without it every stage runs.
        val revisionPass = if (hasComicScope) revisions?.open(credentials, capabilities) else null
        suspend fun gated(
            stage: CoreCatalogStage,
            synchronize: suspend () -> CoreReplicaSyncOutcome,
        ): CoreReplicaSyncOutcome = revisionPass?.run(stage, nowEpochMillis, synchronize) ?: synchronize()
        // The novel manifest shares nothing with the comic stages, so it runs beside them instead
        // of delaying the comic catalog; the replica stage still waits for it.
        val portableNovel = if (policy?.syncNovels ?: hasNovelScope) async {
            synchronizeSafely(
                name = "portableNovelManifest",
                port = portableNovelManifest,
                credentials = credentials,
                capabilities = capabilities,
                nowEpochMillis = nowEpochMillis,
            )
        } else null
        // Bootstrap dependency metadata before materializing library rows. The extension/plugin
        // stages are read/review-only; no repository is added and no APK is installed silently.
        val extensionOutcome = if (
            policy?.let { it.reconcileComicRepositories || it.reconcileComicExtensions } ?: hasComicScope
        ) gated(CoreCatalogStage.EXTENSIONS) {
            synchronizeSafely(
                name = "extensions",
                port = extensionInventory,
                credentials = credentials,
                capabilities = capabilities,
                nowEpochMillis = nowEpochMillis,
            )
        } else CoreReplicaSyncOutcome.DEFERRED

        val portableOutcome = if (policy?.syncComics ?: hasComicScope) gated(CoreCatalogStage.PORTABLE_MANIFEST) {
            synchronizeSafely(
                name = "portableManifest",
                port = portableManifest,
                credentials = credentials,
                capabilities = capabilities,
                nowEpochMillis = nowEpochMillis,
            )
        } else CoreReplicaSyncOutcome.DEFERRED
        // Resolve provider-owned identities before projecting catalog metadata. A BOUND V3 work
        // can then use the native Mihon row; unresolved works retain the Legacy Core source.
        val catalogOutcome = if (policy?.syncComics ?: hasComicScope) gated(CoreCatalogStage.CATALOG) {
            synchronizeSafely(
                name = "catalog",
                port = catalog,
                credentials = credentials,
                capabilities = capabilities,
                nowEpochMillis = nowEpochMillis,
            )
        } else CoreReplicaSyncOutcome.DEFERRED
        val portableNovelOutcome = portableNovel?.await() ?: CoreReplicaSyncOutcome.DEFERRED
        val replicaOutcome = if (replicaScopes.isEmpty()) {
            CoreReplicaSyncOutcome.DEFERRED
        } else {
            credentials.copyWithServerMetadata(
                scopes = replicaScopes,
                lastKnownEndpoint = credentials.lastKnownEndpoint,
            ).use { selected ->
                synchronizeSafely(
                    name = "replica",
                    port = replica,
                    credentials = selected,
                    capabilities = capabilities,
                    nowEpochMillis = nowEpochMillis,
                )
            }
        }
        // LNReader declarations are read from the replica mirror, so the inventory is built only
        // after this pass committed them; otherwise the first sync after pairing sees no repos.
        val novelPluginOutcome = if (
            policy?.let { it.reconcileNovelRepositories || it.reconcileNovelPlugins } ?: hasNovelScope
        ) synchronizeSafely(
            name = "novelPlugins",
            port = novelPlugins,
            credentials = credentials,
            capabilities = capabilities,
            nowEpochMillis = nowEpochMillis,
        ) else CoreReplicaSyncOutcome.DEFERRED
        revisionPass?.finish()
        when {
            replicaOutcome == CoreReplicaSyncOutcome.RETRY -> replicaOutcome
            portableOutcome == CoreReplicaSyncOutcome.RETRY -> portableOutcome
            portableNovelOutcome == CoreReplicaSyncOutcome.RETRY -> portableNovelOutcome
            catalogOutcome == CoreReplicaSyncOutcome.RETRY -> catalogOutcome
            extensionOutcome == CoreReplicaSyncOutcome.RETRY -> extensionOutcome
            novelPluginOutcome == CoreReplicaSyncOutcome.RETRY -> novelPluginOutcome
            replicaOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> replicaOutcome
            portableOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> portableOutcome
            portableNovelOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> portableNovelOutcome
            catalogOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> catalogOutcome
            extensionOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> extensionOutcome
            novelPluginOutcome == CoreReplicaSyncOutcome.NEEDS_USER_ACTION -> novelPluginOutcome
            replicaOutcome == CoreReplicaSyncOutcome.APPLIED ||
                portableOutcome == CoreReplicaSyncOutcome.APPLIED ||
                portableNovelOutcome == CoreReplicaSyncOutcome.APPLIED ||
                catalogOutcome == CoreReplicaSyncOutcome.APPLIED ||
                extensionOutcome == CoreReplicaSyncOutcome.APPLIED ||
                novelPluginOutcome == CoreReplicaSyncOutcome.APPLIED -> CoreReplicaSyncOutcome.APPLIED
            else -> CoreReplicaSyncOutcome.DEFERRED
        }
    }

    private suspend fun synchronizeSafely(
        name: String,
        port: CoreReplicaSyncPort,
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        val startedAt = System.nanoTime()
        val outcome = try {
            port.synchronize(credentials, capabilities, nowEpochMillis)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            reportCoreSyncFailure(name, failure)
            CoreReplicaSyncOutcome.RETRY
        }
        if (BuildConfig.DEBUG) {
            val elapsedMs = (System.nanoTime() - startedAt) / 1_000_000
            runCatching { Log.d("EpigraphCoreSync", "$name sync outcome: ${outcome.name} in ${elapsedMs}ms") }
        }
        return outcome
    }
}

private fun reportCoreSyncFailure(stage: String, failure: Throwable) {
    val failureType = failure::class.simpleName ?: "UnknownFailure"
    coreSyncLogger.w { "$stage sync failed: $failureType" }
    if (BuildConfig.DEBUG) {
        // Debug-only and deliberately payload-free: enough to identify a failing stage without
        // persisting credentials, endpoints, entity IDs, or server responses.
        runCatching { Log.w("EpigraphCoreSync", "$stage sync failed: $failureType") }
    }
}

private fun CoreHttpResult.Failure.toReplicaOutcome(): CoreReplicaSyncOutcome =
    if (statusCode.isTransientHttpStatus()) {
        CoreReplicaSyncOutcome.RETRY
    } else {
        CoreReplicaSyncOutcome.NEEDS_USER_ACTION
    }

sealed interface CoreOutboxSyncOutcome {
    data class OutboxDrained(
        val report: CoreOutboxDrainReport,
        val replica: CoreReplicaSyncOutcome,
    ) : CoreOutboxSyncOutcome

    data class OutboxDeferred(
        val report: CoreOutboxDrainReport,
        val replica: CoreReplicaSyncOutcome,
        val pendingCount: Long,
    ) : CoreOutboxSyncOutcome

    data class Retry(
        val pendingCount: Long,
        val reason: CoreOutboxRetryReason,
    ) : CoreOutboxSyncOutcome

    data class NeedsPairing(
        val pendingCount: Long,
        val reason: CorePairingRequirement,
    ) : CoreOutboxSyncOutcome

    data class NeedsUserAction(
        val pendingCount: Long,
        val reason: CoreUserActionReason,
    ) : CoreOutboxSyncOutcome
}

enum class CoreOutboxRetryReason {
    CREDENTIAL_IO,
    CONNECTION,
    CAPABILITIES,
    OUTBOX_PENDING,
    REPLICA,

    /** Only comic (Suwayomi) rows failed transiently; book/novel rows and assets were drained. */
    SUWAYOMI,
}

enum class CorePairingRequirement {
    NOT_PAIRED,
    TOKEN_EXPIRED,
    CREDENTIAL_UNREADABLE,
    IDENTITY_MISMATCH,
}

enum class CoreUserActionReason {
    CORE_INCOMPATIBLE,
    CAPABILITIES_REJECTED,
    AUTHORIZATION_REQUIRED,
    REPLICA_REJECTED,

    /** Desktop `/v1/sync/status` reports only blocked Suwayomi projections (nothing pending). */
    REMOTE_PROJECTION_BLOCKED,
}

internal enum class CoreRemoteProjectionState { READY, IN_PROGRESS, BLOCKED }

/** Mirrors syncd `routes/status.rs`: `ready = pending == 0 && blocked == 0 && inFlight == 0`. */
/**
 * What this device reports it still has to upload. Rows parked for a user decision stay unsettled
 * here, but no run sends them on its own, so they must not hold a desktop's first run forever.
 */
internal fun uploadsStillToSend(unsettled: Long, blocked: Long): Long = (unsettled - blocked).coerceIn(0, unsettled)

internal fun CoreSyncStatus.remoteProjectionState(): CoreRemoteProjectionState = when {
    ready -> CoreRemoteProjectionState.READY
    suwayomiProjectionPending > 0 || suwayomiProjectionInFlight > 0 -> CoreRemoteProjectionState.IN_PROGRESS
    suwayomiProjectionBlocked > 0 -> CoreRemoteProjectionState.BLOCKED
    else -> CoreRemoteProjectionState.IN_PROGRESS
}

/**
 * Product-level execution boundary used by WorkManager.
 *
 * Capabilities are loaded and validated before any row is claimed. Completion only means the
 * outbox is empty; replica state remains explicit and is never silently labelled synchronized.
 */
class CoreOutboxSyncRunner(
    private val credentials: CoreCredentialStore,
    private val devices: CoreDeviceIdentityProvider,
    private val connections: CoreOutboxSyncConnectionFactory,
    private val pendingOutbox: CorePendingOutbox,
    private val replica: CoreReplicaSyncPort,
    private val policies: SyncPolicyResolver,
    private val negotiatedHooks: List<CoreNegotiatedSessionHook> = emptyList(),
    private val replicaAppliedHooks: List<CoreReplicaAppliedHook> = emptyList(),
    private val policyHooks: List<CoreSyncPolicyHook> = emptyList(),
) {
    suspend fun run(
        nowEpochMillis: Long,
        synchronizeReplica: Boolean = true,
    ): CoreOutboxSyncOutcome = run(nowEpochMillis, synchronizeReplica, restartAfterLegacyUpgrade = true)

    private suspend fun run(
        nowEpochMillis: Long,
        synchronizeReplica: Boolean,
        restartAfterLegacyUpgrade: Boolean,
    ): CoreOutboxSyncOutcome {
        require(nowEpochMillis >= 0) { "sync timestamp must be epoch milliseconds" }
        pendingOutbox.retryRepairable(nowEpochMillis)
        val pendingBefore = pendingOutbox.unsettledCount().also { require(it >= 0) }
        val credential = try {
            credentials.load()
        } catch (failure: CoreCredentialException) {
            return when (failure.failure) {
                CoreCredentialFailure.IO -> CoreOutboxSyncOutcome.Retry(
                    pendingBefore,
                    CoreOutboxRetryReason.CREDENTIAL_IO,
                )
                CoreCredentialFailure.CORRUPTED,
                CoreCredentialFailure.KEY_INVALIDATED,
                CoreCredentialFailure.INVALID_INPUT,
                -> CoreOutboxSyncOutcome.NeedsPairing(
                    pendingBefore,
                    CorePairingRequirement.CREDENTIAL_UNREADABLE,
                )
            }
        }
        if (credential == null) {
            return if (pendingBefore == 0L) {
                CoreOutboxSyncOutcome.OutboxDrained(EMPTY_REPORT, CoreReplicaSyncOutcome.DEFERRED)
            } else {
                CoreOutboxSyncOutcome.NeedsPairing(pendingBefore, CorePairingRequirement.NOT_PAIRED)
            }
        }

        credential.use { session ->
            var effectiveGrantedScopes: List<String> = session.scopes
            if (BuildConfig.DEBUG) {
                Log.w(
                    "EpigraphCoreSync",
                    "session origin=${session.origin} lastKnown=${session.lastKnownEndpoint} " +
                        "gen=${session.endpointGeneration} server=${session.serverId.take(8)}",
                )
            }
            val connection = try {
                connections.open(session)
            } catch (stale: epigraph.sync.core.session.CorePairingStaleException) {
                // The desktop identity rotated (certificate or token). Retrying can never
                // succeed; surface re-pairing instead of looping silently.
                return CoreOutboxSyncOutcome.NeedsPairing(
                    pendingBefore,
                    CorePairingRequirement.IDENTITY_MISMATCH,
                )
            } catch (failure: Throwable) {
                reportCoreSyncFailure("connection.open", failure)
                return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CONNECTION)
            }
            when (val metadata = try {
                connection.sessionMetadata()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                reportCoreSyncFailure("connection.session", failure)
                return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CONNECTION)
            }) {
                is CoreHttpResult.Success -> {
                    val value = metadata.value
                    if (
                        value.profileId != session.profileId ||
                        value.tokenId != session.tokenId ||
                        !value.tlsCertSha256.equals(session.tlsCertSha256, ignoreCase = true) ||
                        (session.serverId != epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID &&
                            value.serverId != session.serverId)
                    ) {
                        return CoreOutboxSyncOutcome.NeedsPairing(
                            pendingBefore,
                            CorePairingRequirement.CREDENTIAL_UNREADABLE,
                        )
                    }
                    session.copyWithServerMetadata(
                        // The server's effectiveBaseUrl may advertise an origin that the device
                        // cannot reach (e.g. desktop loopback while the mobile uses a LAN or
                        // emulator address). Keep the origin that actually answered the probe as
                        // the lastKnownEndpoint so future runs can fall back to it, and treat the
                        // server-advertised URL only as a secondary candidate.
                        origin = value.effectiveBaseUrl,
                        lastKnownEndpoint = connection.openedOrigin,
                        serverId = value.serverId,
                        scopes = value.scopes,
                        inactivityExpiresAtMs = value.inactivityExpiresAtMs,
                        mdnsServiceName = value.mdnsServiceName,
                        endpointGeneration = session.endpointGeneration +
                            if (value.effectiveBaseUrl == connection.openedOrigin) 0 else 1,
                    ).use(credentials::replace)
                    effectiveGrantedScopes = value.scopes
                    if (
                        restartAfterLegacyUpgrade &&
                        session.serverId == epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID &&
                        value.serverId != epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
                    ) {
                        // The credential was just bound to the real desktop id. Restart with it so
                        // nothing in this run is written under legacy_unbound ids (that duplicated
                        // every comic folder).
                        return run(nowEpochMillis, synchronizeReplica, restartAfterLegacyUpgrade = false)
                    }
                }
                is CoreHttpResult.Failure -> {
                    if (BuildConfig.DEBUG) {
                        Log.w("EpigraphCoreSync", "connection.session http=${metadata.statusCode}")
                    }
                    if (metadata.statusCode == 401 || metadata.statusCode == 403) {
                        return CoreOutboxSyncOutcome.NeedsPairing(
                            pendingBefore,
                            CorePairingRequirement.TOKEN_EXPIRED,
                        )
                    }
                    return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CONNECTION)
                }
                null -> Unit
            }
            val capabilities = try {
                when (val result = connection.capabilities()) {
                    is CoreHttpResult.Success -> result.value
                    is CoreHttpResult.Failure -> {
                        return if (result.statusCode.isTransientHttpStatus()) {
                            CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CAPABILITIES)
                        } else {
                            CoreOutboxSyncOutcome.NeedsUserAction(
                                pendingBefore,
                                CoreUserActionReason.CAPABILITIES_REJECTED,
                            )
                        }
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CAPABILITIES)
            }
            if (EpigraphCoreCompatibilityEvaluator.evaluate(capabilities) !is CoreCompatibility.Compatible) {
                return CoreOutboxSyncOutcome.NeedsUserAction(
                    pendingBefore,
                    CoreUserActionReason.CORE_INCOMPATIBLE,
                )
            }
            negotiatedHooks.forEach { hook ->
                try {
                    hook.onNegotiated(capabilities, connection)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    reportCoreSyncFailure("negotiated.hook", failure)
                }
            }

            val policy = try {
                policies.resolve(
                    credentials = session,
                    capabilities = capabilities,
                    deviceId = devices.currentDeviceId(),
                    grantedScopes = effectiveGrantedScopes,
                )
            } catch (_: IllegalArgumentException) {
                return CoreOutboxSyncOutcome.NeedsUserAction(
                    pendingBefore,
                    CoreUserActionReason.CAPABILITIES_REJECTED,
                )
            }
            if (policy.selectedScopes.isEmpty()) {
                return CoreOutboxSyncOutcome.NeedsUserAction(
                    pendingBefore,
                    CoreUserActionReason.AUTHORIZATION_REQUIRED,
                )
            }
            policyHooks.forEach { hook ->
                try {
                    hook.onPolicyResolved(policy)
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    reportCoreSyncFailure("policy.hook", failure)
                }
            }

            val authorization = try {
                CoreOutboxAuthorization(
                    authenticatedDeviceId = devices.currentDeviceId(),
                    grantedScopes = policy.selectedScopes,
                    tokenLease = CredentialCoreAccessTokenLease(session),
                )
            } catch (_: IllegalArgumentException) {
                return CoreOutboxSyncOutcome.NeedsPairing(
                    pendingBefore,
                    CorePairingRequirement.CREDENTIAL_UNREADABLE,
                )
            } catch (_: IllegalStateException) {
                return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.CREDENTIAL_IO)
            }

            // The desktop's first run lets the user continue once the library and folders are in,
            // so say so as soon as only reading state is left instead of after all of it.
            var libraryReported = false
            val reportLibraryUploaded: suspend () -> Unit = report@{
                if (libraryReported || !EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) {
                    return@report
                }
                if (pendingOutbox.libraryCountActive(policy) != 0L) return@report
                libraryReported = true
                try {
                    connection.syncStatus(
                        "comics:profile:${session.profileId}",
                        pendingUploads = null,
                        pendingLibraryUploads = 0,
                    )
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    reportCoreSyncFailure("connection.syncStatus", failure)
                }
            }

            val drain = try {
                reportLibraryUploaded()
                drainCoreBacklog(
                    countPending = { pendingOutbox.countActive(policy) },
                    onBatchWithMorePending = reportLibraryUploaded,
                    drainBatch = {
                        val assets = if (policy.transferBookAssets) {
                            connection.drainBookAssets(nowEpochMillis)
                        } else {
                            BookAssetDrainReport(0, 0, 0, 0)
                        }
                        val core = connection.drain(authorization, capabilities, nowEpochMillis)
                        val suwayomi = if (policy.syncComics) {
                            connection.drainSuwayomi(
                                nowEpochMillis,
                                canonicalProjectionEnabled =
                                    EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(capabilities),
                            )
                        } else {
                            SuwayomiMutationDrainReport(0, 0, 0, 0, 0)
                        }
                        CoreDrainBatch(assets = assets, suwayomi = suwayomi, core = core)
                    },
                )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                reportCoreSyncFailure("connection.drain", failure)
                return CoreOutboxSyncOutcome.Retry(
                    pendingOutbox.unsettledCountActive(policy).also { require(it >= 0) },
                    CoreOutboxRetryReason.CONNECTION,
                )
            }
            val replicaOutcome = if (synchronizeReplica) {
                try {
                    // Keep the working endpoint when deriving the stage session; the
                    // copyWithServerMetadata default resets lastKnownEndpoint to the
                    // server-advertised origin, which may be unreachable from mobile.

                    session.copyWithServerMetadata(
                        scopes = policy.selectedScopes.sorted(),
                        lastKnownEndpoint = session.lastKnownEndpoint,
                    ).use { selected ->
                        replica.synchronize(selected, capabilities, nowEpochMillis)
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    CoreReplicaSyncOutcome.RETRY
                }
            } else {
                CoreReplicaSyncOutcome.DEFERRED
            }
            if (replicaOutcome == CoreReplicaSyncOutcome.APPLIED) {
                replicaAppliedHooks.forEach { hook ->
                    try {
                        hook.onReplicaApplied(nowEpochMillis)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Throwable) {
                        reportCoreSyncFailure("replica.hook", failure)
                    }
                }
            }
            val unsettledAfter = pendingOutbox.unsettledCountActive(policy).also { require(it >= 0) }
            val uploadsLeft = uploadsStillToSend(unsettledAfter, pendingOutbox.blockedCountActive(policy))
            val libraryUploadsLeft = pendingOutbox.libraryCountActive(policy)?.coerceAtLeast(0)
            val remoteProjection = if (
                EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities) &&
                    policy.syncComics
            ) {
                val scopeId = "comics:profile:${session.profileId}"
                try {
                    when (
                        val status = connection.syncStatus(
                            scopeId,
                            pendingUploads = uploadsLeft,
                            pendingLibraryUploads = libraryUploadsLeft,
                        )
                    ) {
                        null -> CoreRemoteProjectionState.READY
                        is CoreHttpResult.Success -> {
                            if (status.value.comicAuthorityMode != "suwayomi-confirmed-v1") {
                                return CoreOutboxSyncOutcome.NeedsUserAction(
                                    unsettledAfter,
                                    CoreUserActionReason.CAPABILITIES_REJECTED,
                                )
                            }
                            status.value.remoteProjectionState()
                        }
                        is CoreHttpResult.Failure -> {
                            if (status.statusCode.isTransientHttpStatus()) {
                                return CoreOutboxSyncOutcome.Retry(
                                    unsettledAfter,
                                    CoreOutboxRetryReason.CONNECTION,
                                )
                            }
                            return CoreOutboxSyncOutcome.NeedsUserAction(
                                unsettledAfter,
                                CoreUserActionReason.CAPABILITIES_REJECTED,
                            )
                        }
                    }
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (failure: Throwable) {
                    reportCoreSyncFailure("connection.syncStatus", failure)
                    return CoreOutboxSyncOutcome.Retry(
                        unsettledAfter,
                        CoreOutboxRetryReason.CONNECTION,
                    )
                }
            } else {
                if (EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) {
                    // Comics are off here, but a desktop's first run still waits for this
                    // device's upload report; send it and ignore the projection answer.
                    try {
                        connection.syncStatus(
                            "comics:profile:${session.profileId}",
                            pendingUploads = uploadsLeft,
                            pendingLibraryUploads = libraryUploadsLeft,
                        )
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (failure: Throwable) {
                        reportCoreSyncFailure("connection.syncStatus", failure)
                    }
                }
                CoreRemoteProjectionState.READY
            }
            when (remoteProjection) {
                CoreRemoteProjectionState.READY -> Unit
                // The local mutation receipt may already be settled, but the authoritative
                // Suwayomi projection is not. Keep the worker in a retryable state so UI layers
                // cannot display a fully synchronized badge prematurely.
                CoreRemoteProjectionState.IN_PROGRESS -> return CoreOutboxSyncOutcome.Retry(
                    unsettledAfter,
                    CoreOutboxRetryReason.OUTBOX_PENDING,
                )
                // Nothing is queued or in flight on the desktop, only rows Suwayomi refused.
                // Retrying from the phone cannot unblock them; surface it instead of looping.
                CoreRemoteProjectionState.BLOCKED -> return CoreOutboxSyncOutcome.NeedsUserAction(
                    unsettledAfter,
                    CoreUserActionReason.REMOTE_PROJECTION_BLOCKED,
                )
            }
            if (drain.transientFailure && drain.pendingCount > 0) {
                // Comic rows failing alone means the desktop's Suwayomi side is degraded (e.g.
                // 503 SUWAYOMI_CATALOG_UNAVAILABLE), not that Core is unreachable.
                return CoreOutboxSyncOutcome.Retry(
                    unsettledAfter,
                    if (drain.coreTransientFailure) {
                        CoreOutboxRetryReason.CONNECTION
                    } else {
                        CoreOutboxRetryReason.SUWAYOMI
                    },
                )
            }
            return when (replicaOutcome) {
                CoreReplicaSyncOutcome.RETRY ->
                    CoreOutboxSyncOutcome.Retry(unsettledAfter, CoreOutboxRetryReason.REPLICA)
                CoreReplicaSyncOutcome.NEEDS_USER_ACTION ->
                    CoreOutboxSyncOutcome.NeedsUserAction(
                        unsettledAfter,
                        CoreUserActionReason.REPLICA_REJECTED,
                    )
                CoreReplicaSyncOutcome.APPLIED,
                CoreReplicaSyncOutcome.DEFERRED,
                -> if (unsettledAfter == 0L) {
                    CoreOutboxSyncOutcome.OutboxDrained(drain.report, replicaOutcome)
                } else {
                    CoreOutboxSyncOutcome.OutboxDeferred(
                        report = drain.report,
                        replica = replicaOutcome,
                        pendingCount = unsettledAfter,
                    )
                }
            }
        }
    }

    private companion object {
        val EMPTY_REPORT = CoreOutboxDrainReport(0, 0, 0, 0, 0)
    }
}

internal data class CoreDrainBatch(
    val assets: BookAssetDrainReport = BookAssetDrainReport(0, 0, 0, 0),
    val suwayomi: SuwayomiMutationDrainReport,
    val core: CoreOutboxDrainReport,
)

internal data class CoreDrainLoopResult(
    val report: CoreOutboxDrainReport,
    val pendingCount: Long,
    val transientFailure: Boolean,
    /** Book assets or Core rows failed transiently; comic (Suwayomi) rows alone leave this false. */
    val coreTransientFailure: Boolean,
)

/** Drains every currently-ready batch; delayed rows remain durable without forcing WorkManager backoff. */
internal suspend fun drainCoreBacklog(
    countPending: suspend () -> Long,
    drainBatch: suspend () -> CoreDrainBatch,
    onBatchWithMorePending: suspend () -> Unit = {},
): CoreDrainLoopResult {
    var aggregate = CoreOutboxDrainReport(0, 0, 0, 0, 0)
    var transientFailure = false
    var coreTransientFailure = false
    while (true) {
        val batch = drainBatch()
        aggregate += batch.core
        coreTransientFailure = coreTransientFailure ||
            batch.assets.retryScheduled > 0 || batch.core.retryScheduled > 0
        transientFailure = coreTransientFailure || transientFailure || batch.suwayomi.retryScheduled > 0

        val pending = countPending().also { require(it >= 0) }
        if (pending == 0L) return CoreDrainLoopResult(aggregate, 0, transientFailure, coreTransientFailure)

        // A blocked asset remains unsettled until the user relinks the immutable file or a later
        // wake succeeds. Counting it as progress would spin this loop and could publish metadata
        // whose bytes are still unavailable on Core.
        val settled = batch.assets.succeeded +
            batch.suwayomi.succeeded + batch.suwayomi.blocked +
            batch.core.acknowledged + batch.core.blocked
        if (settled == 0) {
            return CoreDrainLoopResult(aggregate, pending, transientFailure, coreTransientFailure)
        }
        onBatchWithMorePending()
    }
}

private operator fun CoreOutboxDrainReport.plus(other: CoreOutboxDrainReport) = CoreOutboxDrainReport(
    claimed = claimed + other.claimed,
    submitted = submitted + other.submitted,
    acknowledged = acknowledged + other.acknowledged,
    retryScheduled = retryScheduled + other.retryScheduled,
    blocked = blocked + other.blocked,
)

private fun Int.isTransientHttpStatus(): Boolean = this == 408 || this == 425 || this == 429 || this >= 500
