package epigraph.novel.plugin

import java.security.MessageDigest
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NovelPluginArtifactVerifierTest {
    @Test
    fun `accepts exact LNReader artifact evidence`() {
        val bytes = "plugin-code".encodeToByteArray()

        assertTrue(NovelPluginArtifactVerifier.matches(bytes, bytes.sha256(), bytes.size.toLong()))
    }

    @Test
    fun `rejects hash or size mismatch before plugin execution`() {
        val bytes = "plugin-code".encodeToByteArray()

        assertFalse(NovelPluginArtifactVerifier.matches(bytes, "0".repeat(64), bytes.size.toLong()))
        assertFalse(NovelPluginArtifactVerifier.matches(bytes, bytes.sha256(), bytes.size + 1L))
    }

    private fun ByteArray.sha256(): String = MessageDigest.getInstance("SHA-256")
        .digest(this)
        .joinToString("") { "%02x".format(it) }
}
