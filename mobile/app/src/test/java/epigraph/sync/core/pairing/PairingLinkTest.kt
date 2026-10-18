package epigraph.sync.core.pairing

import okio.ByteString.Companion.encodeUtf8
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class PairingLinkTest {
    private val json = """{"schemaVersion":2,"serverId":"server-a","deviceName":"DÉSKTOP ~?"}"""
    private val data = json.encodeUtf8().base64Url().trimEnd('=')

    @Test
    fun `unwraps the page link the camera opens and the app link the page hands over`() {
        assertEquals(json, PairingLink.bundleJson("https://johnnylord1.github.io/Epigraph/pair/#$data"))
        assertEquals(json, PairingLink.bundleJson("https://johnnylord1.github.io/Epigraph/pair/index.html#$data"))
        assertEquals(json, PairingLink.bundleJson("epigraph://pair?b=$data"))
    }

    @Test
    fun `leaves raw bundles and foreign or broken links for the parser to reject`() {
        assertEquals(json, PairingLink.bundleJson(json))
        listOf(
            "https://example.com/Epigraph/pair/#$data",
            "https://johnnylord1.github.io/Epigraph/pair/?$data",
            "https://johnnylord1.github.io/Epigraph/pair/#",
            "epigraph://pair?b=%%%",
            "epigraph://pair?b=${"not json".encodeUtf8().base64Url()}",
        ).forEach { assertEquals(it, PairingLink.bundleJson(it)) }
    }
}
