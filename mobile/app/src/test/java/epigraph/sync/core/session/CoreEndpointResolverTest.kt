package epigraph.sync.core.session

import epigraph.sync.core.credentials.CoreCredentialSession
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreEndpointResolverTest {
    @Test
    fun `paired alternate ports recover through the pinned default Core port`() {
        val session = fixture(
            origin = "https://192.168.15.3:4795",
            lastKnown = "https://10.0.2.2:4795",
        )

        assertEquals(
            listOf(
                "https://10.0.2.2:4795",
                "https://192.168.15.3:4795",
                "https://10.0.2.2:4777",
                "https://192.168.15.3:4777",
            ),
            pairedEndpointCandidates(session),
        )
    }

    @Test
    fun `default Core origins are not duplicated`() {
        val session = fixture(
            origin = "https://192.168.15.3:4777",
            lastKnown = "https://192.168.15.3:4777",
        )

        assertEquals(
            listOf("https://192.168.15.3:4777"),
            pairedEndpointCandidates(session),
        )
    }

    private fun fixture(origin: String, lastKnown: String) = CoreCredentialSession(
        origin = origin,
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = "main",
        tokenId = "token",
        scopes = listOf("books:global"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = "server",
        lastKnownEndpoint = lastKnown,
        mdnsServiceName = "_epigraph-sync._tcp.",
        accessTokenUtf8 = "secret".encodeToByteArray(),
    )
}
