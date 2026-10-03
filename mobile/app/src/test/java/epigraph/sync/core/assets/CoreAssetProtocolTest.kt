package epigraph.sync.core.assets

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreAssetProtocolTest {
    @Test
    fun `canonicalizes asset identity and builds the exact syncd request contract`() {
        val id = CoreAssetId.parse("AB".repeat(32))
        val request = CoreAssetHttpRequest(
            method = CoreAssetMethod.GET,
            assetId = id,
            scopeId = "novels:profile:main profile",
            session = CoreAssetSession("secret", "0.1.0", 1),
            rangeStart = 42,
        )

        assertEquals("ab".repeat(32), id.value)
        assertEquals("\"${"ab".repeat(32)}\"", id.etag)
        assertEquals("/v1/assets/${id.value}?scopeId=novels%3Aprofile%3Amain%20profile", request.pathAndQuery)
        assertEquals("Bearer secret", request.headers()["Authorization"])
        assertEquals("0.1.0", request.headers()[EpigraphCoreWireProtocol.CLIENT_VERSION_HEADER])
        assertEquals("1", request.headers()[EpigraphCoreWireProtocol.CLIENT_PROTOCOL_HEADER])
        assertEquals("0.1.0", request.headers()[EpigraphCoreWireProtocol.LEGACY_CLIENT_VERSION_HEADER])
        assertEquals("1", request.headers()[EpigraphCoreWireProtocol.LEGACY_CLIENT_PROTOCOL_HEADER])
        assertEquals("bytes=42-", request.headers()["Range"])
        assertFalse(request.toString().contains("secret"))
    }

    @Test
    fun `rejects invalid identities scopes and method-specific headers`() {
        val id = CoreAssetId.parse("a".repeat(64))
        val session = CoreAssetSession("token", "0.1.0", 1)

        assertThrows(IllegalArgumentException::class.java) { CoreAssetId.parse("../secret") }
        assertThrows(IllegalArgumentException::class.java) { CoreAssetId.parse("١".repeat(64)) }
        assertThrows(IllegalArgumentException::class.java) {
            CoreAssetHttpRequest(CoreAssetMethod.HEAD, id, "unknown", session)
        }
        assertThrows(IllegalArgumentException::class.java) {
            CoreAssetHttpRequest(CoreAssetMethod.HEAD, id, "books:global", session, rangeStart = 0)
        }
        assertThrows(IllegalArgumentException::class.java) {
            CoreAssetHttpRequest(CoreAssetMethod.GET, id, "books:global", session, contentLength = 10)
        }
    }
}
