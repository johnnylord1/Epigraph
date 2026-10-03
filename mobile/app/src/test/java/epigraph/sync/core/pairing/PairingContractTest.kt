package epigraph.sync.core.pairing

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class PairingContractTest {
    @Test
    fun `claim request matches syncd camel case and enum wire values`() {
        val encoded = Json.encodeToString(
            PairingClaimRequest(
                sessionId = "session",
                pairingCode = "CODE",
                deviceId = "android-id",
                deviceName = "Pixel",
                platform = PairingPlatform.ANDROID,
                clientVersion = "0.1.0",
                clientProtocolVersion = 1,
            ),
        )

        assertEquals(
            "{\"sessionId\":\"session\",\"pairingCode\":\"CODE\",\"deviceId\":\"android-id\"," +
                "\"deviceName\":\"Pixel\",\"platform\":\"android\",\"clientVersion\":\"0.1.0\"," +
                "\"clientProtocolVersion\":1}",
            encoded,
        )
    }

    @Test
    fun `claim request serializes the selected scopes without changing legacy payloads`() {
        val encoded = Json.encodeToString(
            PairingClaimRequest(
                sessionId = "session",
                pairingCode = "CODE",
                deviceId = "android-id",
                deviceName = "Pixel",
                platform = PairingPlatform.ANDROID,
                clientVersion = "0.1.0",
                clientProtocolVersion = 1,
                requestedScopes = listOf("books:global", "comics:profile:main"),
            ),
        )

        assertTrue(encoded.contains("\"requestedScopes\":[\"books:global\",\"comics:profile:main\"]"))
    }

    @Test
    fun `status event uses exact snake case syncd names`() {
        val encoded = Json.encodeToString(
            PairingStatusEvent(
                type = PairingStatusEventType.FINAL_TOKEN_READY,
                sessionId = "session",
                profileId = "main",
                status = PairingSessionStatus.APPROVED,
                expiresAtMs = 10,
                claimedDeviceId = "android-id",
            ),
        )

        assertTrue(encoded.contains("\"type\":\"final_token_ready\""))
        assertTrue(encoded.contains("\"status\":\"approved\""))
    }

    @Test
    fun `token is redacted from every enclosing string representation`() {
        val token = token("super-secret")
        val session = PairedCoreSession("https://pc.local:4777", "aa", "session", "main", token)

        assertFalse(token.toString().contains("super-secret"))
        assertFalse(session.toString().contains("super-secret"))
        assertTrue(token.toString().contains("<redacted>"))
        assertTrue(session.toString().contains("<redacted>"))
    }

    private fun token(secret: String) = PairingTokenResponse(
        accessToken = secret,
        tokenId = "token-id",
        profileId = "main",
        scopes = listOf("books:global"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        grantedVia = PairingGrantVia.QR,
    )
}
