package epigraph.sync.core.trackers

import android.content.Context
import epigraph.sync.core.credentials.AndroidKeystoreCoreCredentialCipher
import epigraph.sync.core.credentials.CoreCredentialBlobStore
import epigraph.sync.core.credentials.CoreCredentialCipher
import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.PrivateAtomicCoreCredentialFile
import epigraph.sync.core.credentials.SealedCredential
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.charset.StandardCharsets
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/** One tracker login. Values are never part of [toString] and must never be logged. */
class TrackerSecret(
    val username: String,
    val password: String,
    val token: String,
) {
    init {
        require(
            listOf(username, password, token).all { it.toByteArray(StandardCharsets.UTF_8).size <= MAX_FIELD_BYTES },
        ) { "tracker credential field is too large" }
    }

    val isEmpty: Boolean
        get() = username.isEmpty() && password.isEmpty() && token.isEmpty()

    val isLogin: Boolean
        get() = username.isNotEmpty() && password.isNotEmpty()

    override fun equals(other: Any?): Boolean =
        other is TrackerSecret && username == other.username && password == other.password && token == other.token

    override fun hashCode(): Int = (username.hashCode() * 31 + password.hashCode()) * 31 + token.hashCode()

    override fun toString(): String = "TrackerSecret(<redacted>)"

    companion object {
        const val MAX_FIELD_BYTES = 8 * 1024
    }
}

/**
 * What this device last agreed with the Core for one tracker: the Core [revision] and the login
 * value at that revision (`null` for a logout). [receivedFromCore] marks logins that arrived from
 * another device and must be removed again when this device is unpaired.
 */
data class TrackerCredentialVaultEntry(
    val revision: Long,
    val secret: TrackerSecret?,
    val receivedFromCore: Boolean,
)

/**
 * Keystore-sealed record of synchronized tracker logins. It lives in `noBackupFilesDir` under its
 * own key alias, so neither Android Auto Backup nor the app backup can ever carry it, and deleting
 * the Keystore key makes a copied file useless.
 */
class TrackerCredentialVault(
    private val cipher: CoreCredentialCipher,
    private val blobs: CoreCredentialBlobStore,
) {
    private val lock = Any()

    @Throws(CoreCredentialException::class)
    fun read(): Map<String, TrackerCredentialVaultEntry> = synchronized(lock) {
        val envelope = blobs.read() ?: return emptyMap()
        val sealed = decodeEnvelope(envelope)
        val plaintext = cipher.open(sealed, AUTHENTICATED_DATA)
        try {
            val stored = runCatching {
                json.decodeFromString(StoredVault.serializer(), plaintext.toString(StandardCharsets.UTF_8))
            }.getOrElse { throw CoreCredentialException(CoreCredentialFailure.CORRUPTED, it) }
            if (stored.version != PLAINTEXT_VERSION) throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            stored.entries.associate { entry ->
                val secret = runCatching { entry.secret?.let { TrackerSecret(it.username, it.password, it.token) } }
                    .getOrElse { throw CoreCredentialException(CoreCredentialFailure.CORRUPTED, it) }
                entry.trackerKey to TrackerCredentialVaultEntry(entry.revision, secret, entry.receivedFromCore)
            }
        } finally {
            plaintext.fill(0)
        }
    }

    @Throws(CoreCredentialException::class)
    fun write(entries: Map<String, TrackerCredentialVaultEntry>): Unit = synchronized(lock) {
        if (entries.isEmpty()) {
            blobs.delete()
            return
        }
        val stored = StoredVault(
            version = PLAINTEXT_VERSION,
            entries = entries.toSortedMap().map { (trackerKey, entry) ->
                StoredEntry(
                    trackerKey = trackerKey,
                    revision = entry.revision,
                    receivedFromCore = entry.receivedFromCore,
                    secret = entry.secret?.let { StoredSecret(it.username, it.password, it.token) },
                )
            },
        )
        val plaintext = json.encodeToString(StoredVault.serializer(), stored).toByteArray(StandardCharsets.UTF_8)
        try {
            blobs.writeAtomically(encodeEnvelope(cipher.seal(plaintext, AUTHENTICATED_DATA)))
        } finally {
            plaintext.fill(0)
        }
    }

    @Throws(CoreCredentialException::class)
    fun clear() = synchronized(lock) { blobs.delete() }

    private fun encodeEnvelope(sealed: SealedCredential): ByteArray {
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { output ->
            output.writeInt(ENVELOPE_VERSION)
            output.writeInt(sealed.nonce.size)
            output.write(sealed.nonce)
            output.writeInt(sealed.ciphertext.size)
            output.write(sealed.ciphertext)
        }
        return bytes.toByteArray()
    }

    private fun decodeEnvelope(envelope: ByteArray): SealedCredential = try {
        DataInputStream(ByteArrayInputStream(envelope)).use { input ->
            if (input.readInt() != ENVELOPE_VERSION) throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            val nonceLength = input.readInt()
            if (nonceLength !in MIN_NONCE_BYTES..MAX_NONCE_BYTES) {
                throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            }
            val nonce = ByteArray(nonceLength).also(input::readFully)
            val ciphertextLength = input.readInt()
            if (ciphertextLength !in 1..envelope.size) throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            val ciphertext = ByteArray(ciphertextLength).also(input::readFully)
            if (input.available() != 0) throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            SealedCredential(nonce, ciphertext)
        }
    } catch (failure: CoreCredentialException) {
        throw failure
    } catch (failure: Exception) {
        throw CoreCredentialException(CoreCredentialFailure.CORRUPTED, failure)
    }

    @Serializable
    private data class StoredVault(val version: Int, val entries: List<StoredEntry>)

    @Serializable
    private data class StoredEntry(
        val trackerKey: String,
        val revision: Long,
        val receivedFromCore: Boolean,
        val secret: StoredSecret? = null,
    )

    @Serializable
    private class StoredSecret(val username: String, val password: String, val token: String)

    companion object {
        const val KEY_ALIAS = "epigraph.syncd.tracker.credentials.v1"
        private const val FILE_NAME = "tracker-credentials-v1.bin"
        private const val ENVELOPE_VERSION = 1
        private const val PLAINTEXT_VERSION = 1
        private const val MIN_NONCE_BYTES = 12
        private const val MAX_NONCE_BYTES = 32
        private val AUTHENTICATED_DATA = "app.epigraph.mobile/aethon-syncd/tracker-credentials/v1"
            .toByteArray(StandardCharsets.US_ASCII)
        private val json = Json { ignoreUnknownKeys = true }

        /** Uses noBackupFilesDir so tracker logins never enter Android Auto Backup. */
        fun create(context: Context) = TrackerCredentialVault(
            cipher = AndroidKeystoreCoreCredentialCipher(KEY_ALIAS),
            blobs = PrivateAtomicCoreCredentialFile(File(context.noBackupFilesDir, "aethon-sync"), FILE_NAME),
        )
    }
}
