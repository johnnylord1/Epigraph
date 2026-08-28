package epigraph.sync.core.assets

import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CoreAssetFileMaterializerTest {
    @TempDir
    lateinit var directory: File

    private val session = CoreAssetSession("ephemeral-token", "0.1.0", 1)

    @Test
    fun `downloads verifies and atomically publishes a complete asset`() = runTest {
        val bytes = "immutable epub or pdf".toByteArray()
        val id = idOf(bytes)
        val client = FakeClient(bytes, id)
        val states = mutableListOf<CoreAssetTransferState>()
        val destination = File(directory, "books/${id.value}.epub")

        val result = CoreAssetFileMaterializer(client, 1024).download(
            id,
            bytes.size.toLong(),
            "books:global",
            session,
            destination,
            observer = CoreAssetTransferObserver { states += it },
        )

        assertEquals(CoreAssetDisposition.DOWNLOADED, result.disposition)
        assertArrayEquals(bytes, destination.readBytes())
        assertFalse(File(destination.parentFile, "${destination.name}.part").exists())
        assertEquals(listOf(CoreAssetMethod.HEAD, CoreAssetMethod.GET), client.requests.map { it.method })
        assertTrue(states.any { it is CoreAssetTransferState.Verifying })
        assertTrue(states.last() is CoreAssetTransferState.Complete)
    }

    @Test
    fun `resumes an interrupted part with the exact single range`() = runTest {
        val bytes = "resume this immutable asset".toByteArray()
        val id = idOf(bytes)
        val destination = File(directory, "asset.bin").apply { parentFile?.mkdirs() }
        File(destination.parentFile, "asset.bin.part").writeBytes(bytes.copyOfRange(0, 7))
        val client = FakeClient(bytes, id)

        CoreAssetFileMaterializer(client, 1024).download(
            id,
            bytes.size.toLong(),
            "books:global",
            session,
            destination,
        )

        assertArrayEquals(bytes, destination.readBytes())
        val get = client.requests.single { it.method == CoreAssetMethod.GET }
        assertEquals(7, get.rangeStart)
        assertEquals("bytes=7-", get.headers()["Range"])
    }

    @Test
    fun `network interruption keeps a resumable part without publishing`() = runTest {
        val bytes = "network can disappear".toByteArray()
        val id = idOf(bytes)
        val destination = File(directory, "asset.bin")
        val client = FakeClient(bytes, id, failBodyAfter = 6)

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(client, 1024).download(
                    id,
                    bytes.size.toLong(),
                    "books:global",
                    session,
                    destination,
                )
            }
        }

        assertEquals(CoreAssetFailure.NETWORK, failure.failure)
        assertFalse(destination.exists())
        assertTrue(File(directory, "asset.bin.part").length() in 1 until bytes.size.toLong())
    }

    @Test
    fun `cancellation retains the part and never reports complete`() = runTest {
        val bytes = ByteArray(200_000) { (it % 251).toByte() }
        val id = idOf(bytes)
        val destination = File(directory, "cancel.bin")
        var cancelled = false
        val states = mutableListOf<CoreAssetTransferState>()
        val observer = CoreAssetTransferObserver { state ->
            states += state
            if (state is CoreAssetTransferState.Transferring && state.bytesTransferred >= 64 * 1024) cancelled = true
        }

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(FakeClient(bytes, id), 300_000).download(
                    id,
                    bytes.size.toLong(),
                    "books:global",
                    session,
                    destination,
                    CoreAssetCancellation { cancelled },
                    observer,
                )
            }
        }

        assertEquals(CoreAssetFailure.CANCELLED, failure.failure)
        assertFalse(destination.exists())
        assertTrue(File(directory, "cancel.bin.part").length() >= 64 * 1024)
        assertFalse(states.any { it is CoreAssetTransferState.Complete })
    }

    @Test
    fun `wrong downloaded bytes are deleted and never published`() = runTest {
        val expected = "expected".toByteArray()
        val id = idOf(expected)
        val wrong = "differen".toByteArray()
        val destination = File(directory, "wrong.bin")
        val client = FakeClient(wrong, id, reportedSize = expected.size.toLong())

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(client, 1024).download(
                    id,
                    expected.size.toLong(),
                    "books:global",
                    session,
                    destination,
                )
            }
        }

        assertEquals(CoreAssetFailure.HASH_MISMATCH, failure.failure)
        assertFalse(destination.exists())
        assertFalse(File(directory, "wrong.bin.part").exists())
    }

    @Test
    fun `preserves and reports an immutable destination collision`() = runTest {
        val expected = "expected".toByteArray()
        val destination = File(directory, "occupied.bin").apply { writeText("other") }
        val before = destination.readBytes()

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(FakeClient(expected, idOf(expected)), 1024).download(
                    idOf(expected),
                    expected.size.toLong(),
                    "books:global",
                    session,
                    destination,
                )
            }
        }

        assertEquals(CoreAssetFailure.IMMUTABLE_COLLISION, failure.failure)
        assertArrayEquals(before, destination.readBytes())
    }

    @Test
    fun `upload verifies local bytes and sends the full syncd put contract`() = runTest {
        val bytes = "upload me once".toByteArray()
        val source = File(directory, "source.pdf").apply { writeBytes(bytes) }
        val id = idOf(bytes)
        val client = FakeClient(bytes, id, headStatus = 404)

        val result = CoreAssetFileMaterializer(client, 1024).upload(id, "books:global", session, source)

        assertEquals(CoreAssetDisposition.UPLOADED, result.disposition)
        assertArrayEquals(bytes, client.uploadedBytes)
        val put = client.requests.single { it.method == CoreAssetMethod.PUT }
        assertEquals(bytes.size.toLong(), put.contentLength)
        assertEquals(bytes.size.toString(), put.headers()["Content-Length"])
        assertEquals("Bearer ephemeral-token", put.headers()["Authorization"])
    }

    @Test
    fun `upload skips bytes when head confirms the immutable asset`() = runTest {
        val bytes = "already there".toByteArray()
        val source = File(directory, "source.epub").apply { writeBytes(bytes) }
        val id = idOf(bytes)
        val client = FakeClient(bytes, id)

        val result = CoreAssetFileMaterializer(client, 1024).upload(id, "books:global", session, source)

        assertEquals(CoreAssetDisposition.ALREADY_ON_CORE, result.disposition)
        assertTrue(client.uploadedBytes.isEmpty())
        assertEquals(listOf(CoreAssetMethod.HEAD), client.requests.map { it.method })
    }

    @Test
    fun `upload cancellation aborts the body and preserves the local source`() = runTest {
        val bytes = ByteArray(100_000) { (it % 251).toByte() }
        val source = File(directory, "cancel-source.pdf").apply { writeBytes(bytes) }
        val id = idOf(bytes)
        var cancelled = false
        val observer = CoreAssetTransferObserver { state ->
            if (state is CoreAssetTransferState.Transferring && state.bytesTransferred > 0) cancelled = true
        }

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(FakeClient(bytes, id, headStatus = 404), 200_000).upload(
                    id,
                    "books:global",
                    session,
                    source,
                    CoreAssetCancellation { cancelled },
                    observer,
                )
            }
        }

        assertEquals(CoreAssetFailure.CANCELLED, failure.failure)
        assertArrayEquals(bytes, source.readBytes())
    }

    @Test
    fun `rejects an oversized manifest before contacting Core`() = runTest {
        val client = FakeClient(ByteArray(0), CoreAssetId.parse("0".repeat(64)))

        val failure = assertThrows(CoreAssetTransferException::class.java) {
            kotlinx.coroutines.runBlocking {
                CoreAssetFileMaterializer(client, 5).download(
                    CoreAssetId.parse("0".repeat(64)),
                    6,
                    "books:global",
                    session,
                    File(directory, "large.bin"),
                )
            }
        }

        assertEquals(CoreAssetFailure.RESPONSE_TOO_LARGE, failure.failure)
        assertTrue(client.requests.isEmpty())
    }

    private class FakeClient(
        private val bytes: ByteArray,
        private val id: CoreAssetId,
        private val headStatus: Int = 200,
        private val reportedSize: Long = bytes.size.toLong(),
        private val failBodyAfter: Int? = null,
    ) : CoreAssetHttpClient {
        val requests = mutableListOf<CoreAssetHttpRequest>()
        var uploadedBytes = ByteArray(0)

        override suspend fun execute(
            request: CoreAssetHttpRequest,
            uploadBody: CoreAssetUploadBody?,
        ): CoreAssetHttpResponse {
            requests += request
            return when (request.method) {
                CoreAssetMethod.HEAD -> if (headStatus == 404) {
                    CoreAssetHttpResponse(404)
                } else {
                    response(headStatus, reportedSize)
                }
                CoreAssetMethod.GET -> {
                    val offset = request.rangeStart?.toInt() ?: 0
                    val bodyBytes = bytes.copyOfRange(offset.coerceAtMost(bytes.size), bytes.size)
                    val body = failBodyAfter?.let { FailingBody(bodyBytes, it) }
                        ?: InputStreamAssetResponseBody(ByteArrayInputStream(bodyBytes))
                    response(
                        if (request.rangeStart == null) 200 else 206,
                        reportedSize - offset,
                        body,
                        request.rangeStart?.let { "bytes $offset-${reportedSize - 1}/$reportedSize" },
                    )
                }
                CoreAssetMethod.PUT -> {
                    uploadedBytes = uploadBody!!.openStream().use { it.readBytes() }
                    response(201, 0)
                }
            }
        }

        private fun response(
            status: Int,
            length: Long,
            body: CoreAssetResponseBody? = null,
            contentRange: String? = null,
        ): CoreAssetHttpResponse = CoreAssetHttpResponse(
            status,
            buildMap {
                put("Content-Length", length.toString())
                put("ETag", id.etag)
                put("X-Aethon-Asset-Sha256", id.value)
                put("Accept-Ranges", "bytes")
                contentRange?.let { put("Content-Range", it) }
            },
            body,
        )
    }

    private class FailingBody(bytes: ByteArray, private val failAfter: Int) : CoreAssetResponseBody {
        private val input = ByteArrayInputStream(bytes)
        private var read = 0

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (read >= failAfter) throw IOException("connection reset")
            val count = input.read(buffer, offset, minOf(length, failAfter - read))
            if (count > 0) read += count
            return count
        }

        override fun close() = input.close()
    }

    private fun idOf(bytes: ByteArray): CoreAssetId {
        val hex = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        return CoreAssetId.parse(hex)
    }
}
