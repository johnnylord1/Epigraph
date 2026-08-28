package epigraph.books.importing

import epigraph.books.model.BookAssetId
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

data class StreamDigest(
    val assetId: BookAssetId,
    val byteCount: Long,
)

object StreamingSha256 {
    private const val DEFAULT_BUFFER_SIZE = 64 * 1024

    fun digest(
        file: File,
        maxBytes: Long = Long.MAX_VALUE,
    ): StreamDigest {
        require(maxBytes >= 0) { "Maximum byte count cannot be negative" }
        if (!file.isFile || !file.canRead()) {
            throw BookImportValidationException(
                BookImportFailure.SOURCE_UNAVAILABLE,
                "The selected book is not a readable file",
            )
        }
        if (file.length() > maxBytes) {
            throw BookImportValidationException(
                BookImportFailure.FILE_TOO_LARGE,
                "The selected book exceeds the import size limit",
            )
        }
        return file.inputStream().buffered(DEFAULT_BUFFER_SIZE).use {
            digest(it, maxBytes)
        }
    }

    fun digest(
        input: InputStream,
        maxBytes: Long = Long.MAX_VALUE,
        bufferSize: Int = DEFAULT_BUFFER_SIZE,
    ): StreamDigest {
        require(maxBytes >= 0) { "Maximum byte count cannot be negative" }
        require(bufferSize > 0) { "Buffer size must be positive" }

        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(bufferSize)
        var total = 0L

        while (true) {
            val read = input.read(buffer)
            if (read < 0) break
            if (read == 0) {
                val singleByte = input.read()
                if (singleByte < 0) break
                if (total >= maxBytes) {
                    throw BookImportValidationException(
                        BookImportFailure.FILE_TOO_LARGE,
                        "The selected book exceeds the import size limit",
                    )
                }
                digest.update(singleByte.toByte())
                total++
                continue
            }
            if (total > maxBytes - read) {
                throw BookImportValidationException(
                    BookImportFailure.FILE_TOO_LARGE,
                    "The selected book exceeds the import size limit",
                )
            }
            digest.update(buffer, 0, read)
            total += read
        }

        val hex = digest.digest().joinToString(separator = "") { "%02x".format(it) }
        return StreamDigest(BookAssetId.fromSha256(hex), total)
    }
}
