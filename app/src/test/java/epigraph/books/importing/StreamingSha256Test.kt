package epigraph.books.importing

import java.io.ByteArrayInputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class StreamingSha256Test {
    @Test
    fun `hashes a stream incrementally with the expected byte count`() {
        val result = StreamingSha256.digest(
            input = ByteArrayInputStream("abc".toByteArray()),
            bufferSize = 1,
        )

        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", result.assetId.value)
        assertEquals(3, result.byteCount)
    }

    @Test
    fun `rejects a stream immediately after its configured size limit`() {
        val failure = assertThrows(BookImportValidationException::class.java) {
            StreamingSha256.digest(ByteArrayInputStream(byteArrayOf(1, 2, 3)), maxBytes = 2, bufferSize = 2)
        }

        assertEquals(BookImportFailure.FILE_TOO_LARGE, failure.failure)
    }
}
