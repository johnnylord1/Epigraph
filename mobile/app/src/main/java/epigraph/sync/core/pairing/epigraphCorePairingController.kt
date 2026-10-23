package epigraph.sync.core.pairing

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionEnder
import epigraph.sync.core.work.CoreSyncPause
import epigraph.sync.core.work.InMemoryCoreSyncPause
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.launch

sealed interface CorePairingUiState {
    data object Loading : CorePairingUiState
    data object Unpaired : CorePairingUiState

    data class Selecting(
        val serverId: String,
        val profileId: String,
        val expiresAtMs: Long,
        /** Must match the four digits the desktop shows; derived from the pinned certificate. */
        val verificationCode: String,
        val desktopName: String? = null,
    ) : CorePairingUiState

    data class Pairing(
        val stage: PairingStage,
        val expiresAtMs: Long? = null,
        val verificationCode: String? = null,
    ) : CorePairingUiState

    data class Paired(
        val origin: String,
        val profileId: String,
        val scopes: List<String>,
        val inactivityExpiresAtMs: Long,
        val verifiedInThisProcess: Boolean,
    ) : CorePairingUiState

    data class PairingFailed(
        val error: PairingErrorCode,
        val bundleFailure: PairingBundleFailure? = null,
    ) : CorePairingUiState
    data class CredentialFailed(val failure: CoreCredentialFailure) : CorePairingUiState
}

sealed interface CoreHostDiscoveryState {
    data object Idle : CoreHostDiscoveryState
    data object Searching : CoreHostDiscoveryState
    data class Found(
        val hosts: List<DiscoveredCoreHost>,
        /** The last address the user typed did not answer as an Epigraph Core. */
        val addressFailed: Boolean = false,
    ) : CoreHostDiscoveryState
}

enum class PairingStage {
    VALIDATING,
    CLAIMING,
    WAITING_FOR_DESKTOP,
    EXCHANGING_TOKEN,
    SAVING_CREDENTIAL,
}

/** Lifecycle-independent state holder used by the Settings screen and later QR deep links. */
/** Called when the pairing that produced negotiated state no longer exists (unpair or re-pair). */
fun interface CorePairingEndedListener {
    suspend fun onPairingEnded()
}

class EpigraphCorePairingController(
    private val activation: EpigraphCorePairingActivation,
    private val credentials: CoreCredentialStore,
    private val deviceProvider: AndroidPairingDeviceProvider,
    private val syncScheduler: CoreBackgroundSyncScheduler,
    private val selections: DeviceSyncSelectionStore,
    private val endpoints: CoreEndpointResolver,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val hostDiscovery: CoreHostDiscovery = CoreHostDiscovery { emptyList() },
    private val pinResolver: PairingPinResolver? = null,
    private val hostProbe: CoreHostProbe = CoreHostProbe { null },
    private val pairingEndedListeners: List<CorePairingEndedListener> = emptyList(),
    private val sessionEnder: CoreSessionEnder = CoreSessionEnder { },
    private val syncPause: CoreSyncPause = InMemoryCoreSyncPause(),
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    private val lifetimeScope = CoroutineScope(SupervisorJob() + ioDispatcher)
    private val operation = Mutex()
    private val mutableState = MutableStateFlow<CorePairingUiState>(CorePairingUiState.Loading)
    val state: StateFlow<CorePairingUiState> = mutableState.asStateFlow()
    private val mutableSelection = MutableStateFlow<DeviceSyncSelectionV1?>(null)
    val selection: StateFlow<DeviceSyncSelectionV1?> = mutableSelection.asStateFlow()
    private var pendingBootstrapBundle: String? = null
    private var activeVerificationCode: String? = null
    private val mutableDiscovery = MutableStateFlow<CoreHostDiscoveryState>(CoreHostDiscoveryState.Idle)
    val discovery: StateFlow<CoreHostDiscoveryState> = mutableDiscovery.asStateFlow()
    val syncPaused: StateFlow<Boolean> = syncPause.paused

    suspend fun refresh() = operation.withLock {
        // An expired QR/PIN bundle cannot be claimed; never reopen its "Choose what to sync" dialog
        // while the persisted state below is still loading.
        val selecting = mutableState.value as? CorePairingUiState.Selecting
        if (selecting != null && selecting.expiresAtMs > nowMs()) {
            // A Core screen recreated meanwhile (returning from the QR scanner can rotate it) must
            // not drop the "Choose what to sync" step that the scan just opened.
            mutableSelection.value = readPersistedSelection()
            return@withLock
        }
        if (selecting != null) {
            pendingBootstrapBundle = null
            activeVerificationCode = null
            mutableState.value = CorePairingUiState.Loading
        }
        // The selection is read first: the endpoint probe in readPersistedState can wait out a
        // connect timeout, and the settings items that need the selection would pop in after it.
        mutableSelection.value = readPersistedSelection()
        mutableState.value = readPersistedState()
    }

    /**
     * Pairing survives navigation and configuration changes for the lifetime of this singleton.
     * Takes the bundle JSON or the pairing link a desktop QR holds.
     */
    fun startPairing(rawBootstrapBundle: String) {
        val bundle = PairingLink.bundleJson(rawBootstrapBundle)
        lifetimeScope.launch { preparePairing(bundle) }
    }

    /** Browses the LAN for desktops showing a pairing PIN. */
    fun discoverHosts() {
        if (mutableDiscovery.value == CoreHostDiscoveryState.Searching) return
        mutableDiscovery.value = CoreHostDiscoveryState.Searching
        lifetimeScope.launch {
            val hosts = try {
                hostDiscovery.discover()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                emptyList()
            }
            mutableDiscovery.value = CoreHostDiscoveryState.Found(hosts)
        }
    }

    /**
     * Looks for a desktop at an address the user typed, when LAN discovery cannot reach it. A host
     * that answers is added to the discovered list, where the user still compares its code.
     */
    fun probeHostAddress(rawAddress: String) {
        val previous = (mutableDiscovery.value as? CoreHostDiscoveryState.Found)?.hosts.orEmpty()
        if (mutableDiscovery.value == CoreHostDiscoveryState.Searching) return
        val origin = CoreHostAddress.toOrigin(rawAddress) ?: run {
            mutableDiscovery.value = CoreHostDiscoveryState.Found(previous, addressFailed = true)
            return
        }
        mutableDiscovery.value = CoreHostDiscoveryState.Searching
        lifetimeScope.launch {
            val host = try {
                hostProbe.probe(origin)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                null
            }
            mutableDiscovery.value = if (host == null) {
                CoreHostDiscoveryState.Found(previous, addressFailed = true)
            } else {
                CoreHostDiscoveryState.Found(DiscoveredCoreHost.merge(previous + host))
            }
        }
    }

    /**
     * Exchanges the PIN shown by [host] for its bootstrap bundle, then continues exactly like a
     * scanned QR: sync selection, claim, and approval on the desktop.
     */
    fun startPinPairing(host: DiscoveredCoreHost, pin: String) {
        lifetimeScope.launch { resolvePinAndPrepare(host, pin) }
    }

    internal suspend fun resolvePinAndPrepare(host: DiscoveredCoreHost, pin: String) {
        val resolver = pinResolver ?: run {
            mutableState.value = CorePairingUiState.PairingFailed(PairingErrorCode.HOST_NOT_FOUND)
            return
        }
        mutableState.value = CorePairingUiState.Pairing(
            PairingStage.VALIDATING,
            verificationCode = host.verificationCode,
        )
        val bundle = try {
            withContext(ioDispatcher) { resolver.resolve(host, pin) }
        } catch (failure: PairingTransportException) {
            mutableState.value = CorePairingUiState.PairingFailed(failure.error.code)
            return
        }
        preparePairing(bundle)
    }

    fun confirmPairing(selection: PairingSyncSelection) {
        lifetimeScope.launch {
            val bundle = operation.withLock {
                val pending = pendingBootstrapBundle
                pendingBootstrapBundle = null
                pending
            } ?: return@launch
            pair(bundle, selection)
        }
    }

    fun cancelPairingSelection() {
        lifetimeScope.launch {
            operation.withLock {
                pendingBootstrapBundle = null
                activeVerificationCode = null
                mutableState.value = readPersistedState()
            }
        }
    }

    fun startDisconnect() {
        lifetimeScope.launch { disconnect() }
    }

    /** Disconnects sync while keeping the pairing; reconnecting syncs what queued meanwhile. */
    fun setSyncPaused(paused: Boolean) {
        lifetimeScope.launch {
            syncPause.setPaused(paused)
            if (!paused) syncScheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
        }
    }

    fun updateSelection(selection: PairingSyncSelection) {
        lifetimeScope.launch {
            operation.withLock {
                try {
                    val session = withContext(ioDispatcher) { credentials.load() } ?: return@withLock
                    session.use {
                        val persisted = selection.toPersistedSelection(
                            serverId = it.serverId,
                            profileId = it.profileId,
                            deviceId = deviceProvider.current().id,
                        )
                        withContext(ioDispatcher) { selections.upsert(persisted) }
                        mutableSelection.value = persisted
                        syncScheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
                    }
                } catch (_: Exception) {
                    mutableState.value = CorePairingUiState.CredentialFailed(CoreCredentialFailure.IO)
                }
            }
        }
    }

    private suspend fun preparePairing(rawBootstrapBundle: String) = operation.withLock {
        mutableState.value = CorePairingUiState.Pairing(PairingStage.VALIDATING)
        val bundle = try {
            withContext(ioDispatcher) { activation.inspectBootstrap(rawBootstrapBundle) }
        } catch (failure: PairingBundleValidationException) {
            pendingBootstrapBundle = null
            activeVerificationCode = null
            mutableState.value = CorePairingUiState.PairingFailed(
                PairingErrorCode.INVALID_BUNDLE,
                failure.failure,
            )
            return@withLock
        }
        pendingBootstrapBundle = rawBootstrapBundle
        val verificationCode = pairingVerificationCode(bundle.tlsCertSha256)
        activeVerificationCode = verificationCode
        mutableState.value = CorePairingUiState.Selecting(
            serverId = bundle.serverId,
            profileId = bundle.profileId,
            expiresAtMs = bundle.expiresAtMs,
            verificationCode = verificationCode,
            desktopName = bundle.deviceName,
        )
    }

    suspend fun pair(
        rawBootstrapBundle: String,
        selection: PairingSyncSelection = PairingSyncSelection.defaults(),
    ) = operation.withLock {
        activeVerificationCode = try {
            pairingVerificationCode(activation.inspectBootstrap(rawBootstrapBundle).tlsCertSha256)
        } catch (_: PairingBundleValidationException) {
            null
        }
        mutableState.value = CorePairingUiState.Pairing(PairingStage.VALIDATING, verificationCode = activeVerificationCode)
        try {
            val result = withContext(ioDispatcher) {
                activation.pairAndPersist(
                    rawBootstrapBundle = rawBootstrapBundle,
                    device = deviceProvider.current(),
                    onState = { pairing -> mutableState.value = pairing.toUiState() },
                    selection = selection,
                )
            }
            mutableState.value = when (result) {
                is PairingActivationResult.Activated -> {
                    mutableSelection.value = result.selection
                    // A new pairing is the user asking to sync, whatever an earlier one was left at.
                    syncPause.setPaused(false)
                    // State negotiated with a previously paired Core must not leak into this one.
                    notifyPairingEnded()
                    syncScheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
                    CorePairingUiState.Paired(
                        origin = result.origin,
                        profileId = result.profileId,
                        scopes = result.scopes,
                        inactivityExpiresAtMs = result.inactivityExpiresAtMs,
                        verifiedInThisProcess = true,
                    )
                }
                is PairingActivationResult.PairingFailed ->
                    CorePairingUiState.PairingFailed(
                        error = result.error.code,
                        bundleFailure = result.error.bundleFailure,
                    )
                is PairingActivationResult.CredentialPersistenceFailed ->
                    CorePairingUiState.CredentialFailed(result.failure)
            }
        } catch (cancelled: CancellationException) {
            mutableState.value = readPersistedState()
            throw cancelled
        } catch (failure: CoreCredentialException) {
            mutableState.value = CorePairingUiState.CredentialFailed(failure.failure)
        } catch (_: IllegalStateException) {
            // Covers a device-identity persistence failure without exposing filesystem details.
            mutableState.value = CorePairingUiState.CredentialFailed(CoreCredentialFailure.IO)
        }
    }

    suspend fun disconnect() = operation.withLock {
        pendingBootstrapBundle = null
        mutableState.value = try {
            withContext(ioDispatcher) {
                endDesktopSession()
                credentials.delete()
            }
            syncPause.setPaused(false)
            notifyPairingEnded()
            CorePairingUiState.Unpaired
        } catch (failure: CoreCredentialException) {
            CorePairingUiState.CredentialFailed(failure.failure)
        }
    }

    /** Revokes this device on the desktop while its token still exists; never blocks forgetting. */
    private suspend fun endDesktopSession() {
        try {
            credentials.load()?.use { session -> sessionEnder.endSession(session) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // An unreadable credential cannot reach the desktop; the desktop can revoke it itself.
        }
    }

    private suspend fun notifyPairingEnded() {
        pairingEndedListeners.forEach { listener ->
            try {
                withContext(ioDispatcher) { listener.onPairingEnded() }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                // Best effort: the credential is already gone, and listeners hold no data a later
                // pairing can reach without their own revision checks.
            }
        }
    }

    private suspend fun readPersistedState(): CorePairingUiState = try {
        withContext(ioDispatcher) { credentials.load() }?.use { session ->
            val stored = CorePairingUiState.Paired(
                origin = session.origin,
                profileId = session.profileId,
                scopes = session.scopes,
                inactivityExpiresAtMs = session.inactivityExpiresAtMs,
                verifiedInThisProcess = false,
            )
            // The endpoint probe can wait out a connect timeout when the desktop is off; show the
            // stored pairing meanwhile instead of a loading state that reads as "not paired".
            if (mutableState.value == CorePairingUiState.Loading) mutableState.value = stored
            val verifiedEndpoint = runCatching { endpoints.resolve(session) }.getOrNull()
            if (verifiedEndpoint == null) stored
            else stored.copy(origin = verifiedEndpoint.origin, verifiedInThisProcess = true)
        } ?: CorePairingUiState.Unpaired
    } catch (failure: CoreCredentialException) {
        CorePairingUiState.CredentialFailed(failure.failure)
    }

    // The selection lives in the app database; reading it on the caller's (UI) thread froze the Core
    // screen whenever a sync query held the connection.
    private suspend fun readPersistedSelection(): DeviceSyncSelectionV1? = try {
        withContext(ioDispatcher) {
            credentials.load()?.use { session ->
                selections.load(session.serverId, session.profileId, deviceProvider.current().id)
                    ?: DeviceSyncSelectionV1.defaults(
                        serverId = session.serverId,
                        profileId = session.profileId,
                        deviceId = deviceProvider.current().id,
                    ).also(selections::upsert)
            }
        }
    } catch (_: Exception) {
        null
    }

    private fun PairingState.toUiState(): CorePairingUiState = when (this) {
        PairingState.ValidatingBundle -> pairingStage(PairingStage.VALIDATING)
        is PairingState.Claiming -> pairingStage(PairingStage.CLAIMING)
        is PairingState.AwaitingDesktopApproval -> pairingStage(PairingStage.WAITING_FOR_DESKTOP, expiresAtMs)
        is PairingState.ApprovalObserved,
        is PairingState.ExchangingToken,
        -> pairingStage(PairingStage.EXCHANGING_TOKEN)
        is PairingState.Paired -> pairingStage(PairingStage.SAVING_CREDENTIAL)
        is PairingState.Rejected -> CorePairingUiState.PairingFailed(PairingErrorCode.REJECTED)
        is PairingState.Expired -> CorePairingUiState.PairingFailed(PairingErrorCode.EXPIRED)
        is PairingState.Failed -> CorePairingUiState.PairingFailed(error.code)
        PairingState.Cancelled -> CorePairingUiState.Unpaired
    }

    private fun pairingStage(stage: PairingStage, expiresAtMs: Long? = null) =
        CorePairingUiState.Pairing(stage, expiresAtMs, activeVerificationCode)
}
