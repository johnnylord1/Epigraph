package epigraph.sync.core.pairing

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import epigraph.sync.core.session.CoreEndpointResolver
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
    ) : CorePairingUiState

    data class Pairing(
        val stage: PairingStage,
        val expiresAtMs: Long? = null,
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

enum class PairingStage {
    VALIDATING,
    CLAIMING,
    WAITING_FOR_DESKTOP,
    EXCHANGING_TOKEN,
    SAVING_CREDENTIAL,
}

/** Lifecycle-independent state holder used by the Settings screen and later QR deep links. */
class EpigraphCorePairingController(
    private val activation: EpigraphCorePairingActivation,
    private val credentials: CoreCredentialStore,
    private val deviceProvider: AndroidPairingDeviceProvider,
    private val syncScheduler: CoreBackgroundSyncScheduler,
    private val selections: DeviceSyncSelectionStore,
    private val endpoints: CoreEndpointResolver,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lifetimeScope = CoroutineScope(SupervisorJob() + ioDispatcher)
    private val operation = Mutex()
    private val mutableState = MutableStateFlow<CorePairingUiState>(CorePairingUiState.Loading)
    val state: StateFlow<CorePairingUiState> = mutableState.asStateFlow()
    private val mutableSelection = MutableStateFlow<DeviceSyncSelectionV1?>(null)
    val selection: StateFlow<DeviceSyncSelectionV1?> = mutableSelection.asStateFlow()
    private var pendingBootstrapBundle: String? = null

    suspend fun refresh() = operation.withLock {
        mutableState.value = readPersistedState()
        mutableSelection.value = readPersistedSelection()
    }

    /** Pairing survives navigation and configuration changes for the lifetime of this singleton. */
    fun startPairing(rawBootstrapBundle: String) {
        lifetimeScope.launch { preparePairing(rawBootstrapBundle) }
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
                mutableState.value = readPersistedState()
            }
        }
    }

    fun startDisconnect() {
        lifetimeScope.launch { disconnect() }
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
            mutableState.value = CorePairingUiState.PairingFailed(
                PairingErrorCode.INVALID_BUNDLE,
                failure.failure,
            )
            return@withLock
        }
        pendingBootstrapBundle = rawBootstrapBundle
        mutableState.value = CorePairingUiState.Selecting(
            serverId = bundle.serverId,
            profileId = bundle.profileId,
            expiresAtMs = bundle.expiresAtMs,
        )
    }

    suspend fun pair(
        rawBootstrapBundle: String,
        selection: PairingSyncSelection = PairingSyncSelection.defaults(),
    ) = operation.withLock {
        mutableState.value = CorePairingUiState.Pairing(PairingStage.VALIDATING)
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
            withContext(ioDispatcher) { credentials.delete() }
            CorePairingUiState.Unpaired
        } catch (failure: CoreCredentialException) {
            CorePairingUiState.CredentialFailed(failure.failure)
        }
    }

    private suspend fun readPersistedState(): CorePairingUiState = try {
        withContext(ioDispatcher) { credentials.load() }?.use { session ->
            val verifiedEndpoint = runCatching { endpoints.resolve(session) }.getOrNull()
            CorePairingUiState.Paired(
                origin = verifiedEndpoint?.origin ?: session.origin,
                profileId = session.profileId,
                scopes = session.scopes,
                inactivityExpiresAtMs = session.inactivityExpiresAtMs,
                verifiedInThisProcess = verifiedEndpoint != null,
            )
        } ?: CorePairingUiState.Unpaired
    } catch (failure: CoreCredentialException) {
        CorePairingUiState.CredentialFailed(failure.failure)
    }

    private suspend fun readPersistedSelection(): DeviceSyncSelectionV1? = try {
        withContext(ioDispatcher) { credentials.load() }?.use { session ->
            selections.load(session.serverId, session.profileId, deviceProvider.current().id)
                ?: DeviceSyncSelectionV1.defaults(
                    serverId = session.serverId,
                    profileId = session.profileId,
                    deviceId = deviceProvider.current().id,
                ).also(selections::upsert)
        }
    } catch (_: Exception) {
        null
    }

    private fun PairingState.toUiState(): CorePairingUiState = when (this) {
        PairingState.ValidatingBundle -> CorePairingUiState.Pairing(PairingStage.VALIDATING)
        is PairingState.Claiming -> CorePairingUiState.Pairing(PairingStage.CLAIMING)
        is PairingState.AwaitingDesktopApproval ->
            CorePairingUiState.Pairing(PairingStage.WAITING_FOR_DESKTOP, expiresAtMs)
        is PairingState.ApprovalObserved,
        is PairingState.ExchangingToken,
        -> CorePairingUiState.Pairing(PairingStage.EXCHANGING_TOKEN)
        is PairingState.Paired -> CorePairingUiState.Pairing(PairingStage.SAVING_CREDENTIAL)
        is PairingState.Rejected -> CorePairingUiState.PairingFailed(PairingErrorCode.REJECTED)
        is PairingState.Expired -> CorePairingUiState.PairingFailed(PairingErrorCode.EXPIRED)
        is PairingState.Failed -> CorePairingUiState.PairingFailed(error.code)
        PairingState.Cancelled -> CorePairingUiState.Unpaired
    }
}
