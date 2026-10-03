package epigraph.sync.core.credentials

import java.nio.charset.StandardCharsets
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class EncryptedCoreCredentialStoreTest {
    @Test
    fun `round trip never places bearer token in blob or string output`() {
        val blobs = MemoryBlobStore()
        val store = EncryptedCoreCredentialStore(XorCipher(), blobs)
        val source = session(secret = "bearer-do-not-log")

        store.replace(source)
        val restored = checkNotNull(store.load())

        assertFalse(String(blobs.value!!, StandardCharsets.UTF_8).contains("bearer-do-not-log"))
        assertFalse(source.toString().contains("bearer-do-not-log"))
        assertFalse(restored.toString().contains("bearer-do-not-log"))
        restored.useAccessToken { token ->
            assertEquals("bearer-do-not-log", String(token, StandardCharsets.UTF_8))
        }
        assertEquals("token-1", restored.tokenId)
        assertEquals(listOf("books:global", "comics:profile:main"), restored.scopes)
        assertEquals("server-a", restored.serverId)
        assertEquals("https://desktop.local:4777", restored.lastKnownEndpoint)
        assertEquals("_epigraph-sync._tcp.local.", restored.mdnsServiceName)
    }

    @Test
    fun `approved claim rotation atomically replaces secret for the same token id`() {
        val blobs = MemoryBlobStore()
        val store = EncryptedCoreCredentialStore(XorCipher(), blobs)
        store.replace(session(secret = "old-token"))

        store.replace(session(secret = "rotated-token"))

        val restored = checkNotNull(store.load())
        assertEquals("token-1", restored.tokenId)
        restored.useAccessToken { token ->
            assertEquals("rotated-token", String(token, StandardCharsets.UTF_8))
        }
        assertEquals(2, blobs.successfulWrites)
    }

    @Test
    fun `failed replacement leaves previous complete credential readable`() {
        val blobs = MemoryBlobStore()
        val store = EncryptedCoreCredentialStore(XorCipher(), blobs)
        store.replace(session(secret = "old-token"))
        blobs.failNextWrite = true

        val error = assertThrows(CoreCredentialException::class.java) {
            store.replace(session(secret = "new-token"))
        }

        assertEquals(CoreCredentialFailure.IO, error.failure)
        checkNotNull(store.load()).useAccessToken { token ->
            assertEquals("old-token", String(token, StandardCharsets.UTF_8))
        }
    }

    @Test
    fun `detects corrupt envelope without deleting evidence`() {
        val blobs = MemoryBlobStore(byteArrayOf(1, 2, 3, 4))
        val store = EncryptedCoreCredentialStore(XorCipher(), blobs)

        val error = assertThrows(CoreCredentialException::class.java, store::load)

        assertEquals(CoreCredentialFailure.CORRUPTED, error.failure)
        assertTrue(blobs.value!!.contentEquals(byteArrayOf(1, 2, 3, 4)))
    }

    @Test
    fun `surfaces invalidated keystore key distinctly`() {
        val blobs = MemoryBlobStore()
        EncryptedCoreCredentialStore(XorCipher(), blobs).replace(session())
        val store = EncryptedCoreCredentialStore(InvalidatedCipher, blobs)

        val error = assertThrows(CoreCredentialException::class.java, store::load)

        assertEquals(CoreCredentialFailure.KEY_INVALIDATED, error.failure)
    }

    @Test
    fun `delete removes current and partial state idempotently`() {
        val blobs = MemoryBlobStore()
        val store = EncryptedCoreCredentialStore(XorCipher(), blobs)
        store.replace(session())

        store.delete()
        store.delete()

        assertNull(store.load())
    }

    @Test
    fun `closed session rejects persistence and clears access`() {
        val store = EncryptedCoreCredentialStore(XorCipher(), MemoryBlobStore())
        val credential = session()
        credential.close()

        val error = assertThrows(CoreCredentialException::class.java) {
            store.replace(credential)
        }

        assertEquals(CoreCredentialFailure.INVALID_INPUT, error.failure)
        assertThrows(IllegalStateException::class.java) {
            credential.useAccessToken { }
        }
    }

    private fun session(secret: String = "secret-token") = CoreCredentialSession(
        origin = "https://desktop.local:4777",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "bootstrap-019f57b6-1c7b-7862-bc7b-15d17593f9d3",
        profileId = "main",
        tokenId = "token-1",
        scopes = listOf("books:global", "comics:profile:main"),
        inactivityExpiresAtMs = 1_900_000_000_000L,
        serverId = "server-a",
        mdnsServiceName = "_epigraph-sync._tcp.local.",
        accessTokenUtf8 = secret.toByteArray(StandardCharsets.UTF_8),
    )

    private class MemoryBlobStore(initial: ByteArray? = null) : CoreCredentialBlobStore {
        var value: ByteArray? = initial?.copyOf()
        var failNextWrite = false
        var successfulWrites = 0

        override fun read(): ByteArray? = value?.copyOf()

        override fun writeAtomically(value: ByteArray) {
            if (failNextWrite) {
                failNextWrite = false
                throw CoreCredentialException(CoreCredentialFailure.IO)
            }
            this.value = value.copyOf()
            successfulWrites++
        }

        override fun delete() {
            value?.fill(0)
            value = null
        }
    }

    private class XorCipher : CoreCredentialCipher {
        override fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential =
            SealedCredential(
                nonce = ByteArray(12) { 7 },
                ciphertext = plaintext.map { (it.toInt() xor 0x5a).toByte() }.toByteArray(),
            )

        override fun open(
            sealed: SealedCredential,
            authenticatedData: ByteArray,
        ): ByteArray = sealed.ciphertext.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
    }

    private data object InvalidatedCipher : CoreCredentialCipher {
        override fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential =
            error("not used")

        override fun open(
            sealed: SealedCredential,
            authenticatedData: ByteArray,
        ): ByteArray = throw CoreCredentialException(CoreCredentialFailure.KEY_INVALIDATED)
    }
}
