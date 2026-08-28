package epigraph.sync.core.pairing

import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PairingActivationTest {
    @Test
    fun `activation is reported only after the rotated token is persisted`() = runTest {
        val clock = PairingClock { NOW }
        val transport = ApprovedTransport()
        val store = RecordingCredentialStore()
        val activation = EpigraphCorePairingActivation(
            EpigraphCorePairingEngine(transport, clock = clock),
            store,
            RecordingSelectionStore(),
        )

        val result = activation.pairAndPersist(bundleJson(), device())

        val activated = assertInstanceOf(PairingActivationResult.Activated::class.java, result)
        assertEquals(ORIGIN, activated.origin)
        assertEquals(PROFILE_ID, activated.profileId)
        assertEquals(TOKEN_ID, activated.tokenId)
        assertEquals(listOf("books:global"), activated.scopes)
        assertEquals(1, transport.claimCount)
        assertNotNull(store.saved)
        requireNotNull(store.saved).use { saved ->
            assertEquals(TOKEN_ID, saved.tokenId)
            saved.useAccessToken { token -> assertEquals(ACCESS_TOKEN, token.decodeToString()) }
        }
    }

    @Test
    fun `credential failure is not exposed as paired`() = runTest {
        val store = RecordingCredentialStore(CoreCredentialFailure.KEY_INVALIDATED)
        val activation = EpigraphCorePairingActivation(
            EpigraphCorePairingEngine(ApprovedTransport(), clock = PairingClock { NOW }),
            store,
            RecordingSelectionStore(),
        )

        val result = activation.pairAndPersist(bundleJson(), device())

        assertEquals(
            PairingActivationResult.CredentialPersistenceFailed(CoreCredentialFailure.KEY_INVALIDATED),
            result,
        )
        assertTrue(result !is PairingActivationResult.Activated)
    }

    @Test
    fun `failed replacement removes the now invalid credential from the same pairing session`() = runTest {
        val store = RecordingCredentialStore().apply {
            saved = credential(sessionId = SESSION_ID, token = "old-token")
            failWith = CoreCredentialFailure.IO
        }
        val activation = EpigraphCorePairingActivation(
            EpigraphCorePairingEngine(ApprovedTransport(), clock = PairingClock { NOW }),
            store,
            RecordingSelectionStore(),
        )

        val result = activation.pairAndPersist(bundleJson(), device())

        assertInstanceOf(PairingActivationResult.CredentialPersistenceFailed::class.java, result)
        assertEquals(null, store.saved)
    }

    @Test
    fun `failed replacement preserves a credential belonging to another pairing session`() = runTest {
        val store = RecordingCredentialStore().apply {
            saved = credential(sessionId = "another-session", token = "other-token")
            failWith = CoreCredentialFailure.IO
        }
        val activation = EpigraphCorePairingActivation(
            EpigraphCorePairingEngine(ApprovedTransport(), clock = PairingClock { NOW }),
            store,
            RecordingSelectionStore(),
        )

        activation.pairAndPersist(bundleJson(), device())

        assertEquals("another-session", store.saved?.pairingSessionId)
    }

    private class ApprovedTransport : PairingTransport {
        var claimCount = 0

        override suspend fun claim(
            endpoint: SyncdEndpoint,
            tlsCertSha256: String,
            request: PairingClaimRequest,
        ): PairingClaimResponse {
            claimCount++
            return PairingClaimResponse(
                status = PairingClaimStatus.APPROVED,
                sessionId = SESSION_ID,
                profileId = PROFILE_ID,
                claimedDeviceId = DEVICE_ID,
                expiresAtMs = EXPIRES_AT,
                token = PairingTokenResponse(
                    accessToken = ACCESS_TOKEN,
                    tokenId = TOKEN_ID,
                    profileId = PROFILE_ID,
                    scopes = listOf("books:global"),
                    inactivityExpiresAtMs = TOKEN_EXPIRES_AT,
                    grantedVia = PairingGrantVia.QR,
                ),
            )
        }

        override fun statusEvents(
            subscription: PairingStatusSubscription,
            tlsCertSha256: String,
        ): Flow<PairingStatusEvent> = flowOf()
    }

    private class RecordingCredentialStore(
        var failWith: CoreCredentialFailure? = null,
    ) : CoreCredentialStore {
        var saved: CoreCredentialSession? = null

        override fun replace(session: CoreCredentialSession) {
            failWith?.let { throw CoreCredentialException(it) }
            val token = session.useAccessToken { it.copyOf() }
            saved = try {
                CoreCredentialSession(
                    origin = session.origin,
                    tlsCertSha256 = session.tlsCertSha256,
                    pairingSessionId = session.pairingSessionId,
                    profileId = session.profileId,
                    tokenId = session.tokenId,
                    scopes = session.scopes,
                    inactivityExpiresAtMs = session.inactivityExpiresAtMs,
                    accessTokenUtf8 = token,
                )
            } finally {
                token.fill(0)
            }
        }

        override fun load(): CoreCredentialSession? = saved

        override fun delete() {
            saved?.close()
            saved = null
        }
    }

    private class RecordingSelectionStore : DeviceSyncSelectionStore {
        var saved: DeviceSyncSelectionV1? = null

        override fun load(serverId: String, profileId: String, deviceId: String) = saved

        override fun upsert(selection: DeviceSyncSelectionV1) {
            saved = selection
        }

        override fun delete(serverId: String, profileId: String, deviceId: String) {
            saved = null
        }
    }

    private fun credential(sessionId: String, token: String) = CoreCredentialSession(
        origin = ORIGIN,
        tlsCertSha256 = FINGERPRINT,
        pairingSessionId = sessionId,
        profileId = PROFILE_ID,
        tokenId = TOKEN_ID,
        scopes = listOf("books:global"),
        inactivityExpiresAtMs = TOKEN_EXPIRES_AT,
        accessTokenUtf8 = token.encodeToByteArray(),
    )

    private fun bundleJson(): String = Json.encodeToString(
        SyncdBootstrapBundle(
            pairingSessionId = SESSION_ID,
            pairingCode = PAIRING_CODE,
            syncdBaseUrl = ORIGIN,
            profileId = PROFILE_ID,
            expiresAtMs = EXPIRES_AT,
            tlsCertSha256 = FINGERPRINT,
        ),
    )

    private fun device() = PairingDevice(
        id = DEVICE_ID,
        name = "Android test device",
        clientVersion = "0.1.0-alpha.1",
        protocolVersion = 1,
    )

    private companion object {
        const val NOW = 1_000L
        const val EXPIRES_AT = 10_000L
        const val TOKEN_EXPIRES_AT = 20_000L
        const val ORIGIN = "https://192.168.1.10:41337"
        const val SESSION_ID = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3"
        const val PAIRING_CODE = "019F777E758B"
        const val PROFILE_ID = "main"
        const val DEVICE_ID = "android-device"
        const val TOKEN_ID = "token-id"
        const val ACCESS_TOKEN = "secret-access-token"
        const val FINGERPRINT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
}
