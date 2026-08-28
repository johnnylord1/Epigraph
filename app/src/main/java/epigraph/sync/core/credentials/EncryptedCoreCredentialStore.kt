package epigraph.sync.core.credentials

import android.content.Context
import epigraph.sync.core.pairing.PairedCoreSession
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.nio.charset.StandardCharsets

class EncryptedCoreCredentialStore(
    private val cipher: CoreCredentialCipher,
    private val blobs: CoreCredentialBlobStore,
) : CoreCredentialStore {
    private val lock = Any()

    override fun replace(session: CoreCredentialSession) = synchronized(lock) {
        validate(session)
        val plaintext = encodePlaintext(session)
        try {
            val sealed = cipher.seal(plaintext, AUTHENTICATED_DATA)
            try {
                val envelope = encodeEnvelope(sealed)
                try {
                    blobs.writeAtomically(envelope)
                } finally {
                    envelope.fill(0)
                }
            } finally {
                sealed.ciphertext.fill(0)
                sealed.nonce.fill(0)
            }
        } finally {
            plaintext.fill(0)
        }
    }

    override fun load(): CoreCredentialSession? = synchronized(lock) {
        val envelope = blobs.read() ?: return@synchronized null
        try {
            val sealed = decodeEnvelope(envelope)
            try {
                val plaintext = cipher.open(sealed, AUTHENTICATED_DATA)
                try {
                    decodePlaintext(plaintext)
                } finally {
                    plaintext.fill(0)
                }
            } finally {
                sealed.nonce.fill(0)
                sealed.ciphertext.fill(0)
            }
        } finally {
            envelope.fill(0)
        }
    }

    override fun delete() = synchronized(lock) {
        blobs.delete()
    }

    /** Persists the rotated token returned by an approved syncd claim and clears its copy. */
    fun replaceApprovedPairing(session: PairedCoreSession) {
        fromApprovedPairing(session).use(::replace)
    }

    private fun validate(session: CoreCredentialSession) {
        val secret = try {
            session.copySecretForPersistence()
        } catch (error: IllegalStateException) {
            throw CoreCredentialException(CoreCredentialFailure.INVALID_INPUT, error)
        }
        try {
            if (
                secret.isEmpty() || secret.size > MAX_SECRET_BYTES ||
                !session.origin.startsWith("https://") ||
                !FINGERPRINT.matches(session.tlsCertSha256) ||
                session.pairingSessionId.isBlank() || session.profileId.isBlank() ||
                session.tokenId.isBlank() || session.serverId.isBlank() ||
                !session.lastKnownEndpoint.startsWith("https://") ||
                session.endpointGeneration < 0 || session.scopes.isEmpty() ||
                session.scopes.size > MAX_SCOPES ||
                session.scopes.any(String::isBlank) || session.inactivityExpiresAtMs <= 0
            ) {
                throw CoreCredentialException(CoreCredentialFailure.INVALID_INPUT)
            }
        } finally {
            secret.fill(0)
        }
    }

    private fun encodePlaintext(session: CoreCredentialSession): ByteArray {
        val secret = session.copySecretForPersistence()
        return try {
            ByteArrayOutputStream().use { bytes ->
                DataOutputStream(bytes).use { output ->
                    output.writeInt(CURRENT_PLAINTEXT_VERSION)
                    output.writeBoundedUtf8(session.origin)
                    output.writeBoundedUtf8(session.tlsCertSha256)
                    output.writeBoundedUtf8(session.pairingSessionId)
                    output.writeBoundedUtf8(session.profileId)
                    output.writeBoundedUtf8(session.tokenId)
                    output.writeLong(session.inactivityExpiresAtMs)
                    output.writeBoundedUtf8(session.serverId)
                    output.writeBoundedUtf8(session.lastKnownEndpoint)
                    output.writeOptionalBoundedUtf8(session.mdnsServiceName)
                    output.writeLong(session.endpointGeneration)
                    output.writeInt(session.scopes.size)
                    session.scopes.forEach { scope -> output.writeBoundedUtf8(scope) }
                    output.writeInt(secret.size)
                    output.write(secret)
                    output.flush()
                }
                bytes.toByteArray()
            }
        } finally {
            secret.fill(0)
        }
    }

    private fun decodePlaintext(value: ByteArray): CoreCredentialSession = decodeSafely {
        DataInputStream(ByteArrayInputStream(value)).use { input ->
            val version = input.readInt()
            if (version !in LEGACY_PLAINTEXT_VERSION..CURRENT_PLAINTEXT_VERSION) corrupt()
            val origin = input.readBoundedUtf8()
            val fingerprint = input.readBoundedUtf8()
            val pairingSessionId = input.readBoundedUtf8()
            val profileId = input.readBoundedUtf8()
            val tokenId = input.readBoundedUtf8()
            val expiresAtMs = input.readLong()
            val serverId = if (version >= 2) input.readBoundedUtf8() else LEGACY_UNBOUND_SERVER_ID
            val lastKnownEndpoint = if (version >= 2) input.readBoundedUtf8() else origin
            val mdnsServiceName = if (version >= 2) input.readOptionalBoundedUtf8() else null
            val endpointGeneration = if (version >= 2) input.readLong() else 0
            val scopeCount = input.readInt()
            if (scopeCount !in 1..MAX_SCOPES) corrupt()
            val scopes = List(scopeCount) { input.readBoundedUtf8() }
            val secretLength = input.readInt()
            if (secretLength !in 1..MAX_SECRET_BYTES) corrupt()
            val secret = ByteArray(secretLength)
            try {
                input.readFully(secret)
                if (input.read() != -1) corrupt()
                CoreCredentialSession(
                    origin = origin,
                    tlsCertSha256 = fingerprint,
                    pairingSessionId = pairingSessionId,
                    profileId = profileId,
                    tokenId = tokenId,
                    scopes = scopes,
                    inactivityExpiresAtMs = expiresAtMs,
                    serverId = serverId,
                    lastKnownEndpoint = lastKnownEndpoint,
                    mdnsServiceName = mdnsServiceName,
                    endpointGeneration = endpointGeneration,
                    accessTokenUtf8 = secret,
                ).also(::validate)
            } finally {
                secret.fill(0)
            }
        }
    }

    private fun encodeEnvelope(sealed: SealedCredential): ByteArray {
        if (sealed.nonce.size !in MIN_NONCE_BYTES..MAX_NONCE_BYTES || sealed.ciphertext.isEmpty()) {
            throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
        }
        return ByteArrayOutputStream().use { bytes ->
            DataOutputStream(bytes).use { output ->
                output.write(MAGIC)
                output.writeInt(ENVELOPE_VERSION)
                output.writeInt(sealed.nonce.size)
                output.write(sealed.nonce)
                output.writeInt(sealed.ciphertext.size)
                output.write(sealed.ciphertext)
            }
            bytes.toByteArray()
        }
    }

    private fun decodeEnvelope(value: ByteArray): SealedCredential = decodeSafely {
        DataInputStream(ByteArrayInputStream(value)).use { input ->
            val magic = ByteArray(MAGIC.size)
            input.readFully(magic)
            if (!magic.contentEquals(MAGIC) || input.readInt() != ENVELOPE_VERSION) corrupt()
            val nonceLength = input.readInt()
            if (nonceLength !in MIN_NONCE_BYTES..MAX_NONCE_BYTES) corrupt()
            val nonce = ByteArray(nonceLength).also(input::readFully)
            val ciphertextLength = input.readInt()
            if (ciphertextLength !in 1..MAX_CIPHERTEXT_BYTES) {
                nonce.fill(0)
                corrupt()
            }
            val ciphertext = ByteArray(ciphertextLength)
            try {
                input.readFully(ciphertext)
                if (input.read() != -1) corrupt()
                SealedCredential(nonce, ciphertext)
            } catch (error: Throwable) {
                nonce.fill(0)
                ciphertext.fill(0)
                throw error
            }
        }
    }

    private fun DataOutputStream.writeBoundedUtf8(value: String) {
        val encoded = value.toByteArray(StandardCharsets.UTF_8)
        try {
            if (encoded.isEmpty() || encoded.size > MAX_STRING_BYTES) {
                throw CoreCredentialException(CoreCredentialFailure.INVALID_INPUT)
            }
            writeInt(encoded.size)
            write(encoded)
        } finally {
            encoded.fill(0)
        }
    }

    private fun DataInputStream.readBoundedUtf8(): String {
        val size = readInt()
        if (size !in 1..MAX_STRING_BYTES) corrupt()
        val encoded = ByteArray(size)
        return try {
            readFully(encoded)
            String(encoded, StandardCharsets.UTF_8)
        } finally {
            encoded.fill(0)
        }
    }

    private fun DataOutputStream.writeOptionalBoundedUtf8(value: String?) {
        writeBoolean(value != null)
        value?.let { writeBoundedUtf8(it) }
    }

    private fun DataInputStream.readOptionalBoundedUtf8(): String? =
        if (readBoolean()) readBoundedUtf8() else null

    private inline fun <T> decodeSafely(block: () -> T): T = try {
        block()
    } catch (error: CoreCredentialException) {
        throw error
    } catch (error: EOFException) {
        throw CoreCredentialException(CoreCredentialFailure.CORRUPTED, error)
    } catch (error: Throwable) {
        throw CoreCredentialException(CoreCredentialFailure.CORRUPTED, error)
    }

    private fun corrupt(): Nothing = throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)

    companion object {
        private val MAGIC = byteArrayOf(0x41, 0x45, 0x54, 0x48, 0x4f, 0x4e, 0x43, 0x53)
        private val AUTHENTICATED_DATA = "app.epigraph.mobile/aethon-syncd/core-session/v1"
            .toByteArray(StandardCharsets.US_ASCII)
        private val FINGERPRINT = Regex("^[0-9a-fA-F]{64}$")
        private const val ENVELOPE_VERSION = 1
        private const val LEGACY_PLAINTEXT_VERSION = 1
        private const val CURRENT_PLAINTEXT_VERSION = 2
        private const val MIN_NONCE_BYTES = 12
        private const val MAX_NONCE_BYTES = 32
        private const val MAX_CIPHERTEXT_BYTES = 120 * 1024
        private const val MAX_SECRET_BYTES = 16 * 1024
        private const val MAX_STRING_BYTES = 16 * 1024
        private const val MAX_SCOPES = 64

        /** Uses noBackupFilesDir so credentials never enter Android Auto Backup. */
        fun create(context: Context): EncryptedCoreCredentialStore = EncryptedCoreCredentialStore(
            cipher = AndroidKeystoreCoreCredentialCipher(),
            blobs = PrivateAtomicCoreCredentialFile(
                directory = java.io.File(context.noBackupFilesDir, "aethon-sync"),
            ),
        )

        fun fromApprovedPairing(session: PairedCoreSession): CoreCredentialSession {
            val tokenBytes = session.token.accessToken.toByteArray(StandardCharsets.UTF_8)
            return try {
                CoreCredentialSession(
                    origin = session.origin,
                    tlsCertSha256 = session.tlsCertSha256,
                    pairingSessionId = session.sessionId,
                    profileId = session.profileId,
                    tokenId = session.token.tokenId,
                    scopes = session.token.scopes.toList(),
                    inactivityExpiresAtMs = session.token.inactivityExpiresAtMs,
                    serverId = session.serverId,
                    lastKnownEndpoint = session.origin,
                    mdnsServiceName = session.mdnsServiceName,
                    endpointGeneration = 0,
                    accessTokenUtf8 = tokenBytes,
                )
            } finally {
                tokenBytes.fill(0)
            }
        }
    }
}
