package epigraph.sync.core.pairing

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BootstrapBundleParserTest {
    private val now = 1_800_000_000_000L
    private val parser = BootstrapBundleParser(PairingClock { now })

    @Test
    fun `parses the exact desktop bundle and normalizes its private origin`() {
        val parsed = parser.parse(bundle(origin = "https://192.168.001.010:4777/"))

        assertEquals("https://192.168.1.10:4777", parsed.endpoint.origin)
        assertEquals("wss://192.168.1.10:4777", parsed.endpoint.webSocketOrigin)
        assertEquals(parsed.endpoint.origin, parsed.bundle.syncdBaseUrl)
        assertEquals(FINGERPRINT, parsed.bundle.tlsCertSha256)
    }

    @Test
    fun `accepts the current Core bootstrap payload claim url`() {
        val parsed = parser.parse(
            bundle(origin = "https://192.168.1.20:4777")
                .replace(
                    "\"profileId\":\"main\",",
                    "\"claimUrl\":\"https://192.168.1.20:4777/v1/pairing/claim\",\"profileId\":\"main\",",
                ),
        )

        assertEquals(
            "https://192.168.1.20:4777/v1/pairing/claim",
            parsed.bundle.claimUrl,
        )
    }

    @Test
    fun `accepts v2 server identity and discovery metadata`() {
        val raw = bundle(origin = "https://192.168.1.20:4777")
            .replaceFirst(
                "{",
                "{\"schemaVersion\":2,\"serverId\":\"server-a\",\"mdnsServiceName\":\"_epigraph-sync._tcp.local.\",",
            )
            .replace(
                "\"profileId\":\"main\",",
                "\"claimUrl\":\"https://192.168.1.20:4777/v1/pairing/claim\",\"profileId\":\"main\",",
            )

        val parsed = parser.parse(raw)

        assertEquals(2, parsed.bundle.schemaVersion)
        assertEquals("server-a", parsed.bundle.serverId)
        assertEquals("_epigraph-sync._tcp.local.", parsed.bundle.mdnsServiceName)
    }

    @Test
    fun `accepts the current live Core LAN bundle shape`() {
        val expiresAtMs = System.currentTimeMillis() + 60_000
        val raw = """{"pairingSessionId":"bootstrap-019fc7c2-fabb-7b61-a074-7f2a9ae14c35","pairingCode":"019FC7C2FABB","syncdBaseUrl":"https://192.168.15.3:47776","claimUrl":"https://192.168.15.3:47776/v1/pairing/claim","profileId":"main","expiresAtMs":$expiresAtMs,"tlsCertSha256":"83923cf1436c630881dad44fcc610dc3e8b86d3261ee67d43f9f6bebc0b1cdd6"}"""

        val parsed = BootstrapBundleParser(PairingClock { System.currentTimeMillis() }).parse(raw)

        assertEquals("https://192.168.15.3:47776", parsed.endpoint.origin)
    }

    @Test
    fun `accepts the desktop host QR bundle with deviceName`() {
        // Byte shape of serde_json::to_string_pretty(SyncdBootstrapBundle) in syncd_desktop.rs.
        val raw = """
            {
              "pairingSessionId": "$SESSION_ID",
              "pairingCode": "019F777E758B",
              "deviceName": "  DESKTOP-EPIGRAPH\u0007  ",
              "syncdBaseUrl": "https://192.168.1.20:4777",
              "profileId": "main",
              "expiresAtMs": ${now + 60_000},
              "tlsCertSha256": "$FINGERPRINT"
            }
        """.trimIndent()

        val parsed = parser.parse(raw)

        assertEquals("DESKTOP-EPIGRAPH", parsed.bundle.deviceName)
        assertEquals("https://192.168.1.20:4777", parsed.endpoint.origin)
    }

    @Test
    fun `deviceName is optional display metadata on every bundle shape`() {
        val withClaim = bundle()
            .replace(
                "\"profileId\":\"main\",",
                "\"claimUrl\":\"https://192.168.1.20:4777/v1/pairing/claim\",\"deviceName\":\"\",\"profileId\":\"main\",",
            )

        val parsed = parser.parse(withClaim)

        assertEquals(null, parsed.bundle.deviceName)
        assertEquals(null, parser.parse(bundle()).bundle.deviceName)
        assertEquals("x".repeat(128), BootstrapBundleParser.sanitizeDeviceName("x".repeat(300)))
    }

    @Test
    fun `rejects a claim url outside the pinned Core origin`() {
        val raw = bundle(origin = "https://192.168.1.20:4777")
            .replace(
                "\"profileId\":\"main\",",
                "\"claimUrl\":\"https://192.168.1.21:4777/v1/pairing/claim\",\"profileId\":\"main\",",
            )

        assertFailure(PairingBundleFailure.INVALID_ENDPOINT, raw)
    }

    @Test
    fun `accepts mdns single label and private ipv6 LAN endpoints`() {
        assertEquals(
            "https://desktop.local:4777",
            parser.parse(bundle(origin = "HTTPS://DESKTOP.LOCAL.:4777/")).endpoint.origin,
        )
        assertEquals(
            "https://[fd00:0:0:0:0:0:0:1]:4777",
            parser.parse(bundle(origin = "https://[fd00::1]:4777")).endpoint.origin,
        )
        assertEquals(
            "https://aethon-pc:4777",
            parser.parse(bundle(origin = "https://AETHON-PC:4777")).endpoint.origin,
        )
    }

    @Test
    fun `rejects endpoints that are not strict LAN HTTPS origins`() {
        listOf(
            "http://192.168.1.20:4777",
            "https://192.168.1.20",
            "https://127.0.0.1:4777",
            "https://localhost:4777",
            "https://8.8.8.8:4777",
            "https://example.com:4777",
            "https://192.168.1.20:4777/path",
            "https://192.168.1.20:4777?token=x",
            "https://user@192.168.1.20:4777",
        ).forEach { origin ->
            assertThrows(PairingBundleValidationException::class.java) {
                parser.parse(bundle(origin = origin))
            }
        }
    }

    @Test
    fun `rejects unknown missing and duplicated bundle fields`() {
        val unknown = bundle().replaceFirst("{", "{\"extra\":true,")
        assertFailure(PairingBundleFailure.FIELD_SET_MISMATCH, unknown)

        val missing = bundle().replace("\"profileId\":\"main\",", "")
        assertFailure(PairingBundleFailure.FIELD_SET_MISMATCH, missing)

        val duplicate = bundle().replaceFirst("{", "{\"profileId\":\"test\",")
        assertFailure(PairingBundleFailure.DUPLICATE_FIELD, duplicate)
    }

    @Test
    fun `rejects invalid identity code fingerprint and expiry`() {
        assertFailure(
            PairingBundleFailure.INVALID_SESSION_ID,
            bundle().replace(SESSION_ID, "session-1"),
        )
        assertFailure(
            PairingBundleFailure.INVALID_PAIRING_CODE,
            bundle().replace("019F777E758B", "not-a-code"),
        )
        assertFailure(
            PairingBundleFailure.INVALID_FINGERPRINT,
            bundle().replace(FINGERPRINT, "fingerprint"),
        )
        assertFailure(
            PairingBundleFailure.INVALID_EXPIRY,
            bundle(expiresAtMs = now),
        )
    }

    @Test
    fun `rejects malformed non-object and oversized JSON`() {
        assertFailure(PairingBundleFailure.MALFORMED_JSON, "not json")
        assertFailure(PairingBundleFailure.MALFORMED_JSON, "[]")
        assertFailure(PairingBundleFailure.TOO_LARGE, " ".repeat(16 * 1024 + 1))
    }

    private fun assertFailure(expected: PairingBundleFailure, raw: String) {
        val error = assertThrows(PairingBundleValidationException::class.java) {
            parser.parse(raw)
        }
        assertEquals(expected, error.failure)
    }

    private fun bundle(
        origin: String = "https://192.168.1.20:4777",
        expiresAtMs: Long = now + 60_000,
    ): String = """
        {
          "pairingSessionId":"$SESSION_ID",
          "pairingCode":"019F777E758B",
          "syncdBaseUrl":"$origin",
          "profileId":"main",
          "expiresAtMs":$expiresAtMs,
          "tlsCertSha256":"$FINGERPRINT"
        }
    """.trimIndent()

    private companion object {
        const val SESSION_ID = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3"
        const val FINGERPRINT = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
}
