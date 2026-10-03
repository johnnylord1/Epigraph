package epigraph.books.local

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

data class LocalBookCoverAsset(
    val file: File,
    val sha256: String,
    val byteSize: Long,
    val mimeType: String,
)

/** Validates local cover bytes before their identity is published to the Core outbox. */
object BookCoverAssetInspector {
    const val MAX_COVER_ASSET_BYTES = 8L * 1024L * 1024L

    fun inspect(path: String?): LocalBookCoverAsset? {
        val file = path?.takeIf(String::isNotBlank)?.let(::File)?.absoluteFile ?: return null
        require(file.isFile) { "Book cover is unavailable" }
        val size = file.length()
        require(size in 1..MAX_COVER_ASSET_BYTES) { "Book cover is outside the supported size limit" }
        val mimeType = BookCoverFormat.detect(file) ?: error("Book cover must be JPEG, PNG or WebP")
        return LocalBookCoverAsset(file, sha256(file), size, mimeType)
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        FileInputStream(file).use { input ->
            val buffer = ByteArray(32 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read > 0) digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
    }
}

object BookCoverFormat {
    const val JPEG = "image/jpeg"
    const val PNG = "image/png"
    const val WEBP = "image/webp"

    fun matches(file: File, expectedMimeType: String): Boolean = detect(file) == expectedMimeType

    fun detect(file: File): String? {
        if (!file.isFile || file.length() <= 0) return null
        val header = ByteArray(12)
        val read = FileInputStream(file).use { it.read(header) }
        if (read >= 3 &&
            header[0] == 0xff.toByte() && header[1] == 0xd8.toByte() && header[2] == 0xff.toByte()
        ) return JPEG
        if (read >= 8 && header.copyOfRange(0, 8).contentEquals(PNG_SIGNATURE)) return PNG
        if (read >= 12 &&
            header.copyOfRange(0, 4).contentEquals(RIFF) &&
            header.copyOfRange(8, 12).contentEquals(WEBP_SIGNATURE)
        ) return WEBP
        return null
    }

    private val PNG_SIGNATURE = byteArrayOf(
        0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    )
    private val RIFF = byteArrayOf(0x52, 0x49, 0x46, 0x46)
    private val WEBP_SIGNATURE = byteArrayOf(0x57, 0x45, 0x42, 0x50)
}
