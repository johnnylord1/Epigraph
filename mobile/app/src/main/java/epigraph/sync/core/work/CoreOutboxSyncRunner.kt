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
import epigraph.sync.core.outbox.CoreOutboxRetryPlanner
import epigraph.sync.core.outbox.CoreOutboxStore
import epigraph.sync.core.outbox.CoreRequestIdSource
import epigraph.sync.core.outbox.CoreStagedOutbox
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
import epigraph.sync.core.replica.CoreHeldVersions
import epigraph.sync.core.replica.CoreReplicaCheckpointReader
import epigraph.sync.core.replica.CoreReplicaCheckpointResetter
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import epigraph.sync.core.trackers.TrackerCredentialChannel
import epigraph.contract.ClientMutationId
import epigraph.sync.EpigraphMutationCoordinator
import android.util.Log
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.BuildConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import yokai.data.DatabaseHandler
import java.util.UUID

private val coreSyncLogger = Logger.withTag("EpigraphCoreSync")

interface CorePendingOutbox {
    /** Rows that still need submission. This count controls the drain loop. */
    suspend fun count(): Long

    /** Submitted rows plus accepted mutations still waiting for their canonical replica. */
    suspend fun unsettledCount(): Long = count()

    /**
     * Whether a local change is still waiting to be sent: library and reading rows or comic
     * commands, not asset transfers, which can stay pending for long and wake nothing.
     */
    suspend fun localChangesPending(): Boolean = count() > 0

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
    /** Backfill commands held in memory: pending like outbox rows until Core acknowledges them. */
    private val staged: CoreStagedOutbox? = null,
) : CorePendingOutbox {
    private fun stagedCount(scopeIds: Set<String>? = null): Long = staged?.count(scopeIds) ?: 0

    override suspend fun count(): Long = stagedCount() + coordinator.pendingCount() + database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() +
            aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
            aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
    }

    override suspend fun localChangesPending(): Boolean = stagedCount() > 0 || coordinator.pendingCount() > 0 || database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() > 0
    }

    override suspend fun unsettledCount(): Long = stagedCount() + coordinator.unsettledCount() + database.await {
        aethon_suwayomi_mutation_queueQueries.pendingCount().executeAsOne() +
            aethon_syncQueries.pendingAssetUploadCount().executeAsOne() +
            aethon_syncQueries.pendingBookCoverDownloadCount().executeAsOne()
    }

    override suspend fun countActive(policy: EffectiveSyncPolicy): Long =
        stagedCount(policy.selectedScopes) + coordinator.pendingCount(policy.selectedScopes) + database.await {
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
        coordinator.retryBookEntriesMissingAssets(nowEpochMillis) { ClientMutationId(UUID.randomUUID().toString()) }
    }

    override suspend fun unsettledCountActive(policy: EffectiveSyncPolicy): Long =
        stagedCount(policy.selectedScopes) + coordinator.unsettledCount(policy.selectedScopes) + database.await {
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
/**
 * Rows a run queues once its replica pass has recorded what the Core already holds, such as the
 * reading-progress backfill. The same run sends them while they are being queued.
 */
fun interface CoreRunBackfill {
    /**
     * Queues one pass, calling [onQueued] after each batch it queues, and returns how many rows it
     * queued; null when it must not run in this run.
     */
    suspend fun queue(onQueued: () -> Unit): Int?
}

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
    private val endpointResolver: epigraph.sync.core.session.CoreEndpointResolver,
    private val bookAssets: BookAssetCoordinator,
) : CoreOutboxSyncConnectionFactory {
    override suspend fun open(credentials: CoreCredentialSession): CoreOutboxSyncConnection {
        val endpoint = endpointResolver.resolve(credentials)
        val transport = transports.create(credentials, endpoint.origin)
        val http = transport.http
        return object : CoreOutboxSyncConnection {
            override val openedOrigin: String = endpoint.origin

            // The probe that just proved this endpoint asked the same question with the same token.
            override suspend fun sessionMetadata(): CoreHttpResult<epigraph.sync.core.protocol.CoreSessionResponse> =
                endpoint.probedSession?.let { CoreHttpResult.Success(it) }
                    ?: credentials.withAccessTokenString(http::session)

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

private fun reportCoreSyncFailure(stage: String, failure: Throwable) {
    val failureType = failure::class.simpleName ?: "UnknownFailure"
    coreSyncLogger.w { "$stage sync failed: $failureType" }
    CoreSyncReleaseLog.warn(CoreSyncReleaseLog.formatStageFailure(stage, failureType))
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
        /**
         * Rows the desktop still has to apply to Suwayomi when it answered that it is busy with
         * them; null for every other retry. Lets the worker tell a desktop that is working through
         * this device's upload from one that is stuck, since [pendingCount] stays 0 meanwhile.
         */
        val desktopPendingCount: Long? = null,
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

/**
 * What the desktop's projection state means for this run, or null to finish it normally. Rows only
 * the desktop can settle (blocked projections) stop the run only once this device has nothing left
 * to send: stopping earlier left the rest of a first sync's backlog waiting for the periodic check,
 * while the phone reported a desktop problem the desktop itself did not show.
 */
internal fun remoteProjectionOutcome(
    state: CoreRemoteProjectionState,
    unsettledAfter: Long,
    uploadsLeft: Long,
    desktopPendingCount: Long?,
): CoreOutboxSyncOutcome? = when (state) {
    CoreRemoteProjectionState.READY -> null
    // The local mutation receipt may already be settled, but the authoritative Suwayomi
    // projection is not. Keep the worker in a retryable state so UI layers cannot display a
    // fully synchronized badge prematurely.
    CoreRemoteProjectionState.IN_PROGRESS -> CoreOutboxSyncOutcome.Retry(
        unsettledAfter,
        CoreOutboxRetryReason.OUTBOX_PENDING,
        desktopPendingCount = desktopPendingCount,
    )
    // Nothing is queued or in flight on the desktop, only rows Suwayomi refused. Retrying from
    // the phone cannot unblock them; surface it instead of looping, once this device is done.
    CoreRemoteProjectionState.BLOCKED -> if (uploadsLeft == 0L) {
        CoreOutboxSyncOutcome.NeedsUserAction(unsettledAfter, CoreUserActionReason.REMOTE_PROJECTION_BLOCKED)
    } else {
        null
    }
}

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
    private val policies: SyncPolicyResolver,
    private val negotiatedHooks: List<CoreNegotiatedSessionHook> = emptyList(),
    /**
     * The current time for each drained batch. Rows queued during a run, such as a progress backfill
     * sending while it still scans, are due only from when they were queued; a batch claiming with the
     * run's start time would not see them. Null keeps the run's start time.
     */
    private val clock: (() -> Long)? = null,
    /** Retries what a previous Core refused once this phone syncs with another one. */
    private val queueHandOver: CoreQueueHandOver? = null,
    /** Production Sync V4 coordinator used automatically whenever the Core advertises V4. */
    private val v4Coordinator: epigraph.sync.v4.V4ProductionSyncCoordinator? = null,
    /**
     * Inventory stages run after every completed Sync V4 pass (comic extensions, then LNReader
     * plugins). Best effort: a failing stage never changes the sync outcome.
     */
    private val postV4Stages: List<CoreReplicaSyncPort> = emptyList(),
) {
    @Volatile
    private var lastRunUsedSyncV4: Boolean = false

    fun lastRunUsedV4(): Boolean = lastRunUsedSyncV4

    /** [backfill] runs after the replica pass, when the Core answered this run; see [CoreRunBackfill]. */
    suspend fun run(
        nowEpochMillis: Long,
        synchronizeReplica: Boolean = true,
        backfill: CoreRunBackfill? = null,
    ): CoreOutboxSyncOutcome = run(nowEpochMillis, synchronizeReplica, backfill, restartAfterLegacyUpgrade = true)

    private suspend fun run(
        nowEpochMillis: Long,
        synchronizeReplica: Boolean,
        backfill: CoreRunBackfill?,
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
                        return run(nowEpochMillis, synchronizeReplica, backfill, restartAfterLegacyUpgrade = false)
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
            try {
                queueHandOver?.handTo(session.serverId)?.let { released ->
                    if (BuildConfig.DEBUG) {
                        Log.w(
                            "EpigraphCoreSync",
                            "queue handed to server=${session.serverId.take(8)} " +
                                "requeued=${released.requeued} waits=${released.waits}",
                        )
                    }
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Exception) {
                reportCoreSyncFailure("queue.handover", failure)
                return CoreOutboxSyncOutcome.Retry(pendingBefore, CoreOutboxRetryReason.REPLICA)
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
            if (capabilities.supportsSyncV4 && v4Coordinator != null) {
                lastRunUsedSyncV4 = true
                val stageTime = clock?.invoke()?.coerceAtLeast(nowEpochMillis) ?: nowEpochMillis
                val outcome = v4Coordinator.syncOnce(
                    session = session,
                    openedOrigin = connection.openedOrigin,
                    policy = policy,
                    nowEpochMillis = stageTime,
                    drainBookAssets = connection::drainBookAssets,
                )
                if (
                    outcome is CoreOutboxSyncOutcome.OutboxDrained ||
                    outcome is CoreOutboxSyncOutcome.OutboxDeferred
                ) {
                    postV4Stages.forEach { stage ->
                        try {
                            stage.synchronize(session, capabilities, stageTime)
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (failure: Throwable) {
                            reportCoreSyncFailure("v4.inventory", failure)
                        }
                    }
                }
                return outcome
            }
            lastRunUsedSyncV4 = false
            return CoreOutboxSyncOutcome.NeedsUserAction(
                pendingBefore,
                CoreUserActionReason.CORE_INCOMPATIBLE,
            )
        }
    }

    private companion object {
        val EMPTY_REPORT = CoreOutboxDrainReport(0, 0, 0, 0, 0)
    }
}

private fun Int.isTransientHttpStatus(): Boolean = this == 408 || this == 425 || this == 429 || this >= 500
