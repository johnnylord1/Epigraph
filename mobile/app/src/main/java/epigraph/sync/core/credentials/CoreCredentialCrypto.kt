package epigraph.sync.core.credentials

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import java.security.InvalidKeyException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class SealedCredential(
    val nonce: ByteArray,
    val ciphertext: ByteArray,
)

interface CoreCredentialCipher {
    @Throws(CoreCredentialException::class)
    fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential

    @Throws(CoreCredentialException::class)
    fun open(sealed: SealedCredential, authenticatedData: ByteArray): ByteArray
}

/** Android Keystore AES/GCM implementation supported from API 23. */
class AndroidKeystoreCoreCredentialCipher(
    private val keyAlias: String = DEFAULT_KEY_ALIAS,
) : CoreCredentialCipher {
    override fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential =
        translateCryptoFailures {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
            cipher.updateAAD(authenticatedData)
            SealedCredential(cipher.iv.copyOf(), cipher.doFinal(plaintext))
        }

    override fun open(
        sealed: SealedCredential,
        authenticatedData: ByteArray,
    ): ByteArray = translateCryptoFailures {
        val key = loadKey()
            ?: throw CoreCredentialException(CoreCredentialFailure.KEY_INVALIDATED)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, sealed.nonce))
        cipher.updateAAD(authenticatedData)
        cipher.doFinal(sealed.ciphertext)
    }

    private fun getOrCreateKey(): SecretKey = loadKey() ?: run {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            keyAlias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        generator.generateKey()
    }

    private fun loadKey(): SecretKey? {
        val store = KeyStore.getInstance(KEYSTORE)
        store.load(null)
        return store.getKey(keyAlias, null) as? SecretKey
    }

    private inline fun <T> translateCryptoFailures(block: () -> T): T = try {
        block()
    } catch (error: CoreCredentialException) {
        throw error
    } catch (error: Throwable) {
        val failure = when {
            error.hasCause<KeyPermanentlyInvalidatedException>() ||
                error.hasCause<UnrecoverableKeyException>() ||
                error.hasCause<InvalidKeyException>() -> CoreCredentialFailure.KEY_INVALIDATED
            error.hasCause<AEADBadTagException>() -> CoreCredentialFailure.CORRUPTED
            else -> CoreCredentialFailure.IO
        }
        throw CoreCredentialException(failure, error)
    }

    private inline fun <reified T : Throwable> Throwable.hasCause(): Boolean {
        var current: Throwable? = this
        while (current != null) {
            if (current is T) return true
            current = current.cause
        }
        return false
    }

    companion object {
        const val DEFAULT_KEY_ALIAS = "epigraph.syncd.core.session.v1"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
    }
}
