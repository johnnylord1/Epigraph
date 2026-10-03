package epigraph.sync.core.pairing

import java.security.MessageDigest

/**
 * Four digits both devices show while a pairing waits for approval. They are derived from the
 * host certificate, so a different code means the request did not reach the expected computer.
 *
 * Byte-for-byte port of the desktop `pairingVerificationCode` (FNV-1a over the lowercase hex
 * fingerprint, `% 10000`).
 */
fun pairingVerificationCode(tlsCertSha256: String): String {
    var hash = FNV_OFFSET_BASIS
    tlsCertSha256.trim().lowercase()
        .filter { it in '0'..'9' || it in 'a'..'f' }
        .forEach { char ->
            hash = hash xor char.code
            hash *= FNV_PRIME
        }
    return (hash.toUInt() % 10_000u).toString().padStart(4, '0')
}

/** Six-digit desktop pairing PIN (`syncd/pairing_pin.rs`). */
object PairingPin {
    const val LENGTH = 6

    /** Accepts only a complete PIN; spaces and dashes people type or paste are ignored. */
    fun normalize(raw: String): String? {
        val digits = raw.filterNot { it.isWhitespace() || it == '-' }
        return digits.takeIf { it.length == LENGTH && it.all { char -> char in '0'..'9' } }
    }

    /** Same derivation as the host: SHA-256 of the trimmed pairing code, first 4 bytes BE, mod 1e6. */
    fun derive(pairingCode: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(pairingCode.trim().toByteArray(Charsets.UTF_8))
        val value = ((digest[0].toLong() and 0xff) shl 24) or
            ((digest[1].toLong() and 0xff) shl 16) or
            ((digest[2].toLong() and 0xff) shl 8) or
            (digest[3].toLong() and 0xff)
        return (value % 1_000_000).toString().padStart(LENGTH, '0')
    }
}

private const val FNV_OFFSET_BASIS = -2128831035 // 0x811c9dc5 as a signed Int
private const val FNV_PRIME = 0x01000193
