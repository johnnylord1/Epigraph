package epigraph.sync.core.events

import epigraph.sync.core.credentials.CoreCredentialSession
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreLiveEventSupervisorTest {
    @Test
    fun `rejected credential is parked until it changes or the recheck window passes`() {
        var now = 0L
        val gate = RejectedCoreCredentialGate(recheckMs = 1_000, nowMs = { now })
        val revoked = liveCredentialKey(session(tokenId = "token-1"))

        assertTrue(gate.allows(revoked))
        assertTrue(gate.reject(revoked))
        assertFalse(gate.reject(revoked), "the worker is woken once per rejection")
        assertFalse(gate.allows(revoked))

        now = 999
        assertFalse(gate.allows(revoked))
        assertTrue(gate.allows(liveCredentialKey(session(tokenId = "token-2"))))
        assertTrue(gate.allows(revoked), "a new credential clears the parked one")

        gate.reject(revoked)
        now += 1_000
        assertTrue(gate.allows(revoked))
    }

    @Test
    fun `refreshed scopes produce a new credential key without exposing the token`() {
        val before = session(scopes = listOf("novels:profile:main"))
        val after = session(scopes = listOf("comics:profile:main", "novels:profile:main"))

        assertTrue(liveCredentialKey(before) != liveCredentialKey(after))
        assertFalse(liveCredentialKey(before).contains("secret-token"))
    }

    @Test
    fun `live session restarts on token server profile or selected scope changes`() {
        val running = session()
        val scopes = setOf("comics:profile:main")

        assertFalse(liveSessionChanged(running, scopes, session(), scopes))
        assertTrue(liveSessionChanged(running, scopes, session(tokenId = "token-2"), scopes))
        assertTrue(liveSessionChanged(running, scopes, session(serverId = "server-b"), scopes))
        assertTrue(liveSessionChanged(running, scopes, session(profileId = "other"), scopes))
        assertTrue(
            liveSessionChanged(running, scopes, session(), scopes + "novels:profile:main"),
        )
    }

    private fun session(
        tokenId: String = "token-1",
        serverId: String = "server-a",
        profileId: String = "main",
        scopes: List<String> = listOf("comics:profile:main"),
    ) = CoreCredentialSession(
        origin = "https://192.168.1.20:4777",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3",
        profileId = profileId,
        tokenId = tokenId,
        scopes = scopes,
        inactivityExpiresAtMs = 99_999,
        serverId = serverId,
        accessTokenUtf8 = "secret-token".toByteArray(),
    )
}
