package epigraph.sync.core.assets

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest

/**
 * Resumable, bounded materialization for immutable Core assets.
 *
 * A download is visible only after its size and SHA-256 are verified and its sibling `.part` is
 * atomically renamed. Cancellation and network interruption retain the part for a later Range GET.
 * Core PUT currently has no Content-Range contract, so interrupted uploads restart from byte zero.
 */
class CoreAssetFileMaterializer(
    private val http: CoreAssetHttpClient,
    private val maxAssetBytes: Long,
) {
    init {
        require(maxAssetBytes > 0)
    }

    suspend fun download(
        assetId: CoreAssetId,
        expectedSize: Long,
        scopeId: String,
        session: CoreAssetSession,
        destination: File,
        cancellation: CoreAssetCancellation = CoreAssetCancellation.NONE,
        observer: CoreAssetTransferObserver = CoreAssetTransferObserver.NONE,
        validator: CoreAssetFileValidator = CoreAssetFileValidator.NONE,
    ): CoreAssetTransferResult {
        require(expectedSize >= 0)
        val target = destination.absoluteFile
        if (expectedSize > maxAssetBytes) {
            fail(CoreAssetFailure.RESPONSE_TOO_LARGE, "Asset exceeds the local size limit")
        }
        ensureNotCancelled(cancellation)
        observer.onState(CoreAssetTransferState.Inspecting)

        existingVerified(target, assetId, expectedSize, validator)?.let {
            return complete(assetId, expectedSize, target, CoreAssetDisposition.ALREADY_PRESENT, observer)
        }
        ensureParent(target)
        val part = File(target.parentFile, "${target.name}.part")
        if (part.exists() && (!part.isFile || part.length() > expectedSize)) deletePart(part)

        val remoteSize = inspectRemote(assetId, scopeId, session)
        if (remoteSize != expectedSize) {
            fail(CoreAssetFailure.SIZE_MISMATCH, "Core asset size differs from its manifest")
        }

        if (expectedSize == 0L) {
            createEmptyPart(part)
            observer.onState(CoreAssetTransferState.Verifying)
            if (!verified(part, assetId, 0)) fail(CoreAssetFailure.HASH_MISMATCH, "Empty asset has an invalid identity")
            validateContent(part, validator)
            observer.onState(CoreAssetTransferState.Publishing)
            publish(part, target, assetId, 0)
            return complete(assetId, 0, target, CoreAssetDisposition.DOWNLOADED, observer)
        }

        var offset = if (part.isFile) part.length() else 0L
        if (offset == expectedSize) {
            observer.onState(CoreAssetTransferState.Verifying)
            if (verified(part, assetId, expectedSize)) {
                validateContent(part, validator)
                publish(part, target, assetId, expectedSize)
                return complete(assetId, expectedSize, target, CoreAssetDisposition.DOWNLOADED, observer)
            }
            deletePart(part)
            offset = 0
        }
        if (offset > 0) observer.onState(CoreAssetTransferState.Resuming(offset))

        val request = CoreAssetHttpRequest(
            method = CoreAssetMethod.GET,
            assetId = assetId,
            scopeId = scopeId,
            session = session,
            rangeStart = offset.takeIf { it > 0 },
        )
        val response = execute(request)
        response.use {
            validateDownloadResponse(response, assetId, offset, expectedSize)
            val body = response.body ?: fail(CoreAssetFailure.REMOTE_PROTOCOL, "Core returned an asset without a body")
            appendBody(part, body, offset, expectedSize, cancellation, observer)
        }

        observer.onState(CoreAssetTransferState.Verifying)
        if (!verified(part, assetId, expectedSize)) {
            deletePart(part)
            fail(CoreAssetFailure.HASH_MISMATCH, "Downloaded bytes do not match the immutable asset identity")
        }
        validateContent(part, validator)
        ensureNotCancelled(cancellation)
        observer.onState(CoreAssetTransferState.Publishing)
        publish(part, target, assetId, expectedSize)
        return complete(assetId, expectedSize, target, CoreAssetDisposition.DOWNLOADED, observer)
    }

    suspend fun upload(
        assetId: CoreAssetId,
        scopeId: String,
        session: CoreAssetSession,
        source: File,
        cancellation: CoreAssetCancellation = CoreAssetCancellation.NONE,
        observer: CoreAssetTransferObserver = CoreAssetTransferObserver.NONE,
    ): CoreAssetTransferResult {
        ensureNotCancelled(cancellation)
        if (!source.isFile) fail(CoreAssetFailure.LOCAL_ASSET_MISSING, "Local asset is unavailable")
        val size = source.length()
        if (size > maxAssetBytes) fail(CoreAssetFailure.RESPONSE_TOO_LARGE, "Asset exceeds the local size limit")
        observer.onState(CoreAssetTransferState.Verifying)
        if (!verified(source, assetId, size)) {
            fail(CoreAssetFailure.HASH_MISMATCH, "Local bytes do not match the immutable asset identity")
        }

        observer.onState(CoreAssetTransferState.Inspecting)
        val head = execute(
            CoreAssetHttpRequest(CoreAssetMethod.HEAD, assetId, scopeId, session),
            allowNotFound = true,
        )
        head.use {
            if (head.statusCode == HTTP_OK) {
                validateIdentityHeaders(head, assetId)
                if (requiredLength(head) != size) {
                    fail(CoreAssetFailure.IMMUTABLE_COLLISION, "Core contains a different size for this asset identity")
                }
                return complete(assetId, size, source, CoreAssetDisposition.ALREADY_ON_CORE, observer)
            }
        }

        ensureNotCancelled(cancellation)
        observer.onState(CoreAssetTransferState.Transferring(0, size))
        val request = CoreAssetHttpRequest(CoreAssetMethod.PUT, assetId, scopeId, session, contentLength = size)
        val response = execute(
            request,
            CoreAssetUploadBody {
                CancellableBoundedInputStream(FileInputStream(source), size, cancellation, observer)
            },
        )
        response.use {
            if (response.statusCode != HTTP_CREATED && response.statusCode != HTTP_NO_CONTENT) {
                failForStatus(response.statusCode)
            }
            validateIdentityHeaders(response, assetId)
        }
        ensureNotCancelled(cancellation)
        return complete(assetId, size, source, CoreAssetDisposition.UPLOADED, observer)
    }

    private suspend fun inspectRemote(assetId: CoreAssetId, scopeId: String, session: CoreAssetSession): Long {
        val response = execute(CoreAssetHttpRequest(CoreAssetMethod.HEAD, assetId, scopeId, session))
        response.use {
            if (response.statusCode != HTTP_OK) failForStatus(response.statusCode)
            validateIdentityHeaders(response, assetId)
            val size = requiredLength(response)
            if (size > maxAssetBytes) {
                fail(CoreAssetFailure.RESPONSE_TOO_LARGE, "Core asset exceeds the local size limit")
            }
            return size
        }
    }

    private suspend fun execute(
        request: CoreAssetHttpRequest,
        uploadBody: CoreAssetUploadBody? = null,
        allowNotFound: Boolean = false,
    ): CoreAssetHttpResponse = try {
        val response = http.execute(request, uploadBody)
        if (response.statusCode == HTTP_NOT_FOUND && allowNotFound) return response
        if (response.statusCode == HTTP_UNAUTHORIZED || response.statusCode == HTTP_FORBIDDEN) {
            val status = response.statusCode
            response.close()
            failForStatus(status)
        }
        response
    } catch (failure: CoreAssetTransferException) {
        throw failure
    } catch (failure: Exception) {
        throw CoreAssetTransferException(CoreAssetFailure.NETWORK, "Epigraph Core asset request failed", failure)
    }

    private fun validateDownloadResponse(
        response: CoreAssetHttpResponse,
        assetId: CoreAssetId,
        offset: Long,
        total: Long,
    ) {
        if (offset == 0L) {
            if (response.statusCode != HTTP_OK) failForStatus(response.statusCode)
            if (requiredLength(response) != total) {
                fail(CoreAssetFailure.SIZE_MISMATCH, "Core returned an unexpected asset length")
            }
        } else {
            if (response.statusCode != HTTP_PARTIAL) {
                fail(CoreAssetFailure.REMOTE_PROTOCOL, "Core did not honor the requested byte range")
            }
            val expectedRange = "bytes $offset-${total - 1}/$total"
            if (response.header("Content-Range") != expectedRange) {
                fail(CoreAssetFailure.REMOTE_PROTOCOL, "Core returned an unexpected Content-Range")
            }
            if (requiredLength(response) != total - offset) {
                fail(CoreAssetFailure.SIZE_MISMATCH, "Core returned an unexpected range length")
            }
        }
        validateIdentityHeaders(response, assetId)
    }

    private fun validateIdentityHeaders(response: CoreAssetHttpResponse, assetId: CoreAssetId) {
        val canonicalSha256 = response.header(EpigraphCoreWireProtocol.ASSET_SHA256_HEADER)
        val legacySha256 = response.header(EpigraphCoreWireProtocol.LEGACY_ASSET_SHA256_HEADER)
        val sha256 = canonicalSha256 ?: legacySha256
        if (response.header("ETag") != assetId.etag ||
            !sha256.equals(assetId.value, ignoreCase = true) ||
            (canonicalSha256 != null && legacySha256 != null &&
                !canonicalSha256.equals(legacySha256, ignoreCase = true)) ||
            !response.header("Accept-Ranges").equals("bytes", ignoreCase = true)
        ) fail(CoreAssetFailure.REMOTE_PROTOCOL, "Core returned inconsistent asset identity headers")
    }

    private fun requiredLength(response: CoreAssetHttpResponse): Long =
        response.header("Content-Length")?.toLongOrNull()?.takeIf { it >= 0 }
            ?: fail(CoreAssetFailure.REMOTE_PROTOCOL, "Core response is missing a valid Content-Length")

    private fun appendBody(
        part: File,
        body: CoreAssetResponseBody,
        offset: Long,
        total: Long,
        cancellation: CoreAssetCancellation,
        observer: CoreAssetTransferObserver,
    ) {
        try {
            RandomAccessFile(part, "rw").use { output ->
                output.setLength(offset)
                output.seek(offset)
                val buffer = ByteArray(BUFFER_SIZE)
                var received = offset
                while (received < total) {
                    ensureNotCancelled(cancellation)
                    val allowed = minOf(buffer.size.toLong(), total - received).toInt()
                    val read = readBody(body, buffer, allowed)
                    if (read < 0) fail(CoreAssetFailure.NETWORK, "Core asset stream ended before the declared size")
                    if (read == 0) fail(CoreAssetFailure.NETWORK, "Core asset stream made no progress")
                    output.write(buffer, 0, read)
                    received += read
                    observer.onState(CoreAssetTransferState.Transferring(received, total))
                }
                if (readBody(body, buffer, 1) >= 0) {
                    deletePart(part)
                    fail(CoreAssetFailure.RESPONSE_TOO_LARGE, "Core sent bytes beyond the declared asset size")
                }
                output.fd.sync()
            }
        } catch (failure: CoreAssetTransferException) {
            throw failure
        } catch (failure: IOException) {
            throw CoreAssetTransferException(
                CoreAssetFailure.LOCAL_STORAGE,
                "Asset part could not be persisted",
                failure,
            )
        }
    }

    private fun readBody(body: CoreAssetResponseBody, buffer: ByteArray, length: Int): Int = try {
        body.read(buffer, 0, length)
    } catch (failure: CoreAssetTransferException) {
        throw failure
    } catch (failure: IOException) {
        throw CoreAssetTransferException(CoreAssetFailure.NETWORK, "Core asset stream was interrupted", failure)
    } catch (failure: RuntimeException) {
        throw CoreAssetTransferException(CoreAssetFailure.NETWORK, "Core asset stream failed", failure)
    }

    private fun createEmptyPart(part: File) {
        try {
            FileOutputStream(part, false).use { output ->
                output.flush()
                output.fd.sync()
            }
        } catch (failure: IOException) {
            throw CoreAssetTransferException(
                CoreAssetFailure.LOCAL_STORAGE,
                "Empty asset part could not be persisted",
                failure,
            )
        }
    }

    private fun publish(part: File, destination: File, assetId: CoreAssetId, size: Long) = synchronized(PUBLISH_LOCK) {
        if (destination.exists()) {
            if (verified(destination, assetId, size)) {
                deletePart(part)
                return@synchronized
            }
            fail(CoreAssetFailure.IMMUTABLE_COLLISION, "Destination contains different bytes for this asset identity")
        }
        val renamed = try { part.renameTo(destination) } catch (_: SecurityException) { false }
        if (!renamed) {
            if (destination.exists() && verified(destination, assetId, size)) {
                deletePart(part)
                return@synchronized
            }
            fail(CoreAssetFailure.LOCAL_STORAGE, "Verified asset could not be atomically published")
        }
    }

    private fun existingVerified(
        file: File,
        assetId: CoreAssetId,
        size: Long,
        validator: CoreAssetFileValidator,
    ): File? {
        if (!file.exists()) return null
        if (verified(file, assetId, size)) {
            validateContent(file, validator, deleteOnFailure = false)
            return file
        }
        fail(CoreAssetFailure.IMMUTABLE_COLLISION, "Destination contains different bytes for this asset identity")
    }

    private fun validateContent(
        file: File,
        validator: CoreAssetFileValidator,
        deleteOnFailure: Boolean = true,
    ) {
        val valid = try {
            validator.isValid(file)
        } catch (_: RuntimeException) {
            false
        }
        if (!valid) {
            if (deleteOnFailure) deletePart(file)
            fail(CoreAssetFailure.INVALID_CONTENT, "Asset content does not match its declared format")
        }
    }

    private fun verified(file: File, assetId: CoreAssetId, size: Long): Boolean =
        file.isFile && file.length() == size && sha256(file) == assetId.value

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            FileInputStream(file).use { input ->
                val buffer = ByteArray(BUFFER_SIZE)
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read > 0) digest.update(buffer, 0, read)
                }
            }
        } catch (failure: IOException) {
            throw CoreAssetTransferException(CoreAssetFailure.LOCAL_STORAGE, "Asset could not be verified", failure)
        } catch (failure: SecurityException) {
            throw CoreAssetTransferException(CoreAssetFailure.LOCAL_STORAGE, "Asset could not be accessed", failure)
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private fun ensureParent(destination: File) {
        val parent = destination.absoluteFile.parentFile
            ?: fail(CoreAssetFailure.LOCAL_STORAGE, "Asset destination has no parent")
        val available = try {
            parent.isDirectory || parent.mkdirs() || parent.isDirectory
        } catch (_: SecurityException) {
            false
        }
        if (!available) {
            fail(CoreAssetFailure.LOCAL_STORAGE, "Asset destination is unavailable")
        }
    }

    private fun deletePart(part: File) {
        try {
            if (part.exists() && !part.delete()) {
                fail(CoreAssetFailure.LOCAL_STORAGE, "Invalid asset part could not be removed")
            }
        } catch (failure: SecurityException) {
            throw CoreAssetTransferException(
                CoreAssetFailure.LOCAL_STORAGE,
                "Invalid asset part could not be removed",
                failure,
            )
        }
    }

    private fun ensureNotCancelled(cancellation: CoreAssetCancellation) {
        if (cancellation.isCancelled()) fail(CoreAssetFailure.CANCELLED, "Asset transfer was cancelled")
    }

    private fun complete(
        assetId: CoreAssetId,
        size: Long,
        file: File,
        disposition: CoreAssetDisposition,
        observer: CoreAssetTransferObserver,
    ): CoreAssetTransferResult {
        observer.onState(CoreAssetTransferState.Complete(disposition, file))
        return CoreAssetTransferResult(assetId, size, file, disposition)
    }

    private fun failForStatus(status: Int): Nothing = when (status) {
        HTTP_NOT_FOUND -> fail(CoreAssetFailure.REMOTE_NOT_FOUND, "Asset is unavailable for this Core scope")
        HTTP_UNAUTHORIZED -> fail(CoreAssetFailure.UNAUTHORIZED, "Core token is missing or invalid")
        HTTP_FORBIDDEN -> fail(CoreAssetFailure.FORBIDDEN, "Core token does not grant this asset scope")
        HTTP_UPGRADE_REQUIRED -> fail(CoreAssetFailure.INCOMPATIBLE_CORE, "Core rejected the client protocol version")
        else -> fail(CoreAssetFailure.REMOTE_PROTOCOL, "Unexpected Core asset response: HTTP $status")
    }

    private fun fail(failure: CoreAssetFailure, message: String): Nothing =
        throw CoreAssetTransferException(failure, message)

    private class CancellableBoundedInputStream(
        input: InputStream,
        private val total: Long,
        private val cancellation: CoreAssetCancellation,
        private val observer: CoreAssetTransferObserver,
    ) : InputStream() {
        private val delegate = input
        private var sent = 0L

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xff
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (cancellation.isCancelled()) {
                throw CoreAssetTransferException(CoreAssetFailure.CANCELLED, "Asset upload was cancelled")
            }
            if (sent >= total) return -1
            val read = delegate.read(buffer, offset, minOf(length.toLong(), total - sent).toInt())
            if (read > 0) {
                sent += read
                observer.onState(CoreAssetTransferState.Transferring(sent, total))
            }
            return read
        }

        override fun close() = delegate.close()
    }

    private companion object {
        const val BUFFER_SIZE = 64 * 1024
        const val HTTP_OK = 200
        const val HTTP_CREATED = 201
        const val HTTP_NO_CONTENT = 204
        const val HTTP_PARTIAL = 206
        const val HTTP_UNAUTHORIZED = 401
        const val HTTP_FORBIDDEN = 403
        const val HTTP_NOT_FOUND = 404
        const val HTTP_UPGRADE_REQUIRED = 426
        val PUBLISH_LOCK = Any()
    }
}
