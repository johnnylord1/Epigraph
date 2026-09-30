package epigraph.sync.core.pairing

import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class PairingPinResolverTest {
    private val now = System.currentTimeMillis()

    @Test
    fun `verification code matches the desktop FNV-1a vectors`() {
        assertEquals("4341", pairingVerificationCode("a".repeat(64)))
        assertEquals("5256", pairingVerificationCode(LIVE_FINGERPRINT))
        assertEquals("5256", pairingVerificationCode("  ${LIVE_FINGERPRINT.uppercase()}  "))
        assertEquals("6261", pairingVerificationCode(""))
    }

    @Test
    fun `pin derivation and normalization match the desktop host`() {
        assertEquals("377299", PairingPin.derive("0192A7C4E5F1"))
        assertEquals("152805", PairingPin.derive(" 019F777E758B "))
        assertEquals("123456", PairingPin.normalize(" 123-456 "))
        assertNull(PairingPin.normalize("12345"))
        assertNull(PairingPin.normalize("1234567"))
        assertNull(PairingPin.normalize("12a456"))
        assertNull(PairingPin.normalize("١٢٣٤٥٦"))
    }

    @Test
    fun `resolved PIN becomes a bundle the strict parser accepts`() = runTest {
        val requests = mutableListOf<Triple<String, String, String>>()
        val resolver = PairingPinResolver { endpoint, fingerprint, pin ->
            requests += Triple(endpoint.origin, fingerprint, pin)
            payload()
        }

        val raw = resolver.resolve(HOST, "377 299")
        val parsed = BootstrapBundleParser(PairingClock { now }).parse(raw)

        assertEquals(listOf(Triple(HOST.origins.first(), FINGERPRINT, "377299")), requests)
        assertEquals("server-a", parsed.bundle.serverId)
        assertEquals(2, parsed.bundle.schemaVersion)
        assertEquals("DESKTOP-EPIGRAPH", parsed.bundle.deviceName)
        assertEquals("https://192.168.1.20:4777", parsed.endpoint.origin)
        assertEquals(FINGERPRINT, parsed.bundle.tlsCertSha256)
    }

    @Test
    fun `network failure falls through to the next advertised origin only`() = runTest {
        val tried = mutableListOf<String>()
        val resolver = PairingPinResolver { endpoint, _, _ ->
            tried += endpoint.origin
            if (tried.size == 1) throw failure(PairingErrorCode.NETWORK)
            payload()
        }
        val host = HOST.copy(origins = listOf("https://192.168.1.21:4777", "https://192.168.1.20:4777"))

        resolver.resolve(host, "377299")

        assertEquals(host.origins, tried)

        val notFound = PairingPinResolver { endpoint, _, _ ->
            tried += endpoint.origin
            throw failure(PairingErrorCode.PIN_NOT_FOUND)
        }
        tried.clear()
        assertEquals(PairingErrorCode.PIN_NOT_FOUND, codeOf { notFound.resolve(host, "000000") })
        assertEquals(listOf(host.origins.first()), tried)

        val offline = PairingPinResolver { _, _, _ -> throw failure(PairingErrorCode.NETWORK) }
        assertEquals(PairingErrorCode.NETWORK, codeOf { offline.resolve(host, "000000") })
        assertEquals(
            PairingErrorCode.HOST_NOT_FOUND,
            codeOf { offline.resolve(host.copy(origins = emptyList()), "000000") },
        )
    }

    @Test
    fun `rejects invalid PIN and payloads for another certificate or server`() = runTest {
        val untouched = PairingPinResolver { _, _, _ -> error("must not send an invalid PIN") }
        assertEquals(PairingErrorCode.PIN_INVALID, codeOf { untouched.resolve(HOST, "12345") })

        val otherCert = PairingPinResolver { _, _, _ -> payload(fingerprint = "b".repeat(64)) }
        assertEquals(PairingErrorCode.TLS_MISMATCH, codeOf { otherCert.resolve(HOST, "377299") })

        val otherServer = PairingPinResolver { _, _, _ -> payload(serverId = "server-b") }
        assertEquals(PairingErrorCode.INVALID_RESPONSE, codeOf { otherServer.resolve(HOST, "377299") })
    }

    @Test
    fun `discovered hosts require sid and fingerprint and merge both service types`() {
        val txt = mapOf(
            "sid" to "server-a".toByteArray(),
            "tls_sha256" to FINGERPRINT.uppercase().toByteArray(),
            "origin" to "https://192.168.1.20:4777".toByteArray(),
        )
        val current = DiscoveredCoreHost.fromResolvedService("epigraph-syncd-a", txt, "fe80::1%wlan0", 4777)
        val legacy = DiscoveredCoreHost.fromResolvedService("epigraph-syncd-a", txt, "192.168.1.20", 4777)

        assertEquals(FINGERPRINT, current?.tlsCertSha256)
        assertEquals("https://192.168.1.20:4777", current?.origins?.last())
        assertEquals(listOf("https://192.168.1.20:4777"), legacy?.origins)
        assertNull(DiscoveredCoreHost.fromResolvedService("x", txt - "sid", "192.168.1.20", 4777))
        assertNull(DiscoveredCoreHost.fromResolvedService("x", txt - "tls_sha256", "192.168.1.20", 4777))
        assertNull(
            DiscoveredCoreHost.fromResolvedService("x", txt - "origin", "8.8.8.8", 4777),
        )

        val merged = DiscoveredCoreHost.merge(listOfNotNull(legacy, current))
        assertEquals(1, merged.size)
        assertEquals(legacy!!.origins.first(), merged.single().origins.first())
        assertEquals(pairingVerificationCode(FINGERPRINT), merged.single().verificationCode)
    }

    private fun payload(
        fingerprint: String = FINGERPRINT,
        serverId: String = "server-a",
    ) = BootstrapPayloadResponse(
        schemaVersion = 2,
        serverId = serverId,
        pairingSessionId = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3",
        pairingCode = "0192A7C4E5F1",
        syncdBaseUrl = "https://192.168.1.20:4777",
        claimUrl = "https://192.168.1.20:4777/v1/pairing/claim",
        profileId = "main",
        expiresAtMs = now + 60_000,
        tlsCertSha256 = fingerprint,
        mdnsServiceName = "_epigraph-sync._tcp.local.",
        deviceName = "DESKTOP-EPIGRAPH",
    )

    private suspend fun codeOf(block: suspend () -> Unit): PairingErrorCode = try {
        block()
        error("expected a pairing failure")
    } catch (failure: PairingTransportException) {
        failure.error.code
    }

    private fun failure(code: PairingErrorCode) = PairingTransportException(PairingError(code))

    private companion object {
        val FINGERPRINT = "a".repeat(64)
        const val LIVE_FINGERPRINT = "83923cf1436c630881dad44fcc610dc3e8b86d3261ee67d43f9f6bebc0b1cdd6"
        val HOST = DiscoveredCoreHost(
            instanceName = "epigraph-syncd-a",
            serverId = "server-a",
            tlsCertSha256 = FINGERPRINT,
            origins = listOf("https://192.168.1.20:4777"),
        )
    }
}
