package epigraph.sync.core.pairing

import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.credentials.EncryptedCoreCredentialStore
import epigraph.sync.core.replica.CoreReplicaCheckpointResetter

/**
 * Result exposed to the product layer after the complete pairing transaction.
 *
 * [Activated] means the latest token returned by syncd is already durably encrypted. A successful
 * network claim is never enough to report the device as paired because an approved re-claim
 * rotates the server-side token even when its token ID stays the same.
 */
sealed interface PairingActivationResult {
    data class Activated(
        val origin: String,
        val profileId: String,
        val tokenId: String,
        val scopes: List<String>,
        val inactivityExpiresAtMs: Long,
        val selection: DeviceSyncSelectionV1,
    ) : PairingActivationResult

    data class PairingFailed(val error: PairingError) : PairingActivationResult

    data class CredentialPersistenceFailed(
        val failure: CoreCredentialFailure,
    ) : PairingActivationResult
}

/** Joins the real syncd pairing handshake to the encrypted Android credential boundary. */
class EpigraphCorePairingActivation(
    private val pairingEngine: EpigraphCorePairingEngine,
    private val credentialStore: CoreCredentialStore,
    private val selectionStore: DeviceSyncSelectionStore,
    private val checkpointResetter: CoreReplicaCheckpointResetter? = null,
) {
    fun inspectBootstrap(rawBootstrapBundle: String): SyncdBootstrapBundle =
        pairingEngine.inspectBootstrap(rawBootstrapBundle)

    suspend fun pairAndPersist(
        rawBootstrapBundle: String,
        device: PairingDevice,
        onState: (PairingState) -> Unit = {},
        selection: PairingSyncSelection = PairingSyncSelection.defaults(),
    ): PairingActivationResult = when (
        val pairing = pairingEngine.pair(
            rawBootstrapBundle,
            device,
            onState,
            selection.enabledDomains,
        )
    ) {
        is PairingResult.Failure -> PairingActivationResult.PairingFailed(pairing.error)
        is PairingResult.Success -> persist(pairing.session, device, selection)
    }

    private suspend fun persist(
        session: PairedCoreSession,
        device: PairingDevice,
        selection: PairingSyncSelection,
    ): PairingActivationResult {
        val credential = EncryptedCoreCredentialStore.fromApprovedPairing(session)
        try {
            credentialStore.replace(credential)
        } catch (failure: CoreCredentialException) {
            discardRotatedCredentialIfPresent(session)
            return PairingActivationResult.CredentialPersistenceFailed(failure.failure)
        } finally {
            credential.close()
        }

        val persistedSelection = selection.toPersistedSelection(
            serverId = session.serverId,
            profileId = session.profileId,
            deviceId = device.id.trim(),
        )
        try {
            selectionStore.upsert(persistedSelection)
        } catch (_: Exception) {
            discardRotatedCredentialIfPresent(session)
            return PairingActivationResult.CredentialPersistenceFailed(CoreCredentialFailure.IO)
        }

        // Pairing establishes a new server history. Never carry replay cursors or inbox
        // deduplication from a previous Core; the next worker run will take a complete snapshot.
        try {
            checkpointResetter?.reset()
        } catch (_: Throwable) {
            // Credential and selection are already durable. A later sync can still retry the
            // reset; do not report a false pairing failure after the server approved the device.
        }

        return PairingActivationResult.Activated(
            origin = session.origin,
            profileId = session.profileId,
            tokenId = session.token.tokenId,
            scopes = session.token.scopes.toList(),
            inactivityExpiresAtMs = session.token.inactivityExpiresAtMs,
            selection = persistedSelection,
        )
    }

    /**
     * A successful final claim rotates the server-side token. If durable replacement fails, an
     * older credential for this same pairing session is no longer usable and must not later make
     * the UI look paired. A credential for another Core/session is deliberately preserved.
     */
    private fun discardRotatedCredentialIfPresent(session: PairedCoreSession) {
        val matchesRotatedSession = try {
            credentialStore.load()?.use { stored ->
                stored.origin == session.origin &&
                    stored.profileId == session.profileId &&
                    stored.pairingSessionId == session.sessionId
            } == true
        } catch (_: CoreCredentialException) {
            true
        }
        if (matchesRotatedSession) {
            try {
                credentialStore.delete()
            } catch (_: CoreCredentialException) {
                // The caller still receives CredentialPersistenceFailed and must not report paired.
            }
        }
    }
}
