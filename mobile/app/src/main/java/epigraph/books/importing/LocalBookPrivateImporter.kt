package epigraph.books.importing

import epigraph.books.model.BookAssetId
import epigraph.contract.ContentType
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

/**
 * Ephemeral source for a local import. Implementations must open a fresh stream for each call.
 * Source handles (including SAF Uris) are deliberately absent from persisted results.
 */
interface LocalBookStreamSource {
    val displayName: String

    @Throws(IOException::class, SecurityException::class)
    fun openStream(): InputStream
}

data class PrivateBookImportRequest(
    val source: LocalBookStreamSource,
    val expectedContentType: ContentType? = null,
    val displayName: String = source.displayName,
)

enum class PrivateBookImportDisposition {
    IMPORTED,
    ALREADY_PRESENT,
}

/** Contains only app-private state. It never retains a SAF Uri, password, or source handle. */
data class PrivateBookImportResult(
    val manifest: BookImportManifest,
    val privateFile: File,
    val disposition: PrivateBookImportDisposition,
    /** Derived cover stored beside the private publication, when the format exposes one. */
    val coverFile: File? = null,
    /** Metadata read from the verified publication; never contains a SAF Uri or secret. */
    val metadata: BookImportMetadata = BookImportMetadata(),
)

/**
 * Copies untrusted streams into an app-private, content-addressed store.
 *
 * A blob becomes visible only after the bounded copy, fsync, content validation, and SHA-256
 * verification have all completed. Existing final blobs are never overwritten.
 */
class LocalBookPrivateImporter(
    privateStorageDirectory: File,
    private val limits: LocalBookImportLimits = LocalBookImportLimits(),
    private val inspector: LocalBookImportInspector = LocalBookImportInspector(limits),
) {
    private val storageRoot = privateStorageDirectory.absoluteFile
    private val stagingDirectory get() = File(storageRoot, STAGING_DIRECTORY)
    private val coverMaterializer = BookCoverMaterializer(storageRoot)

    /**
     * Copies and validates a source without publishing it. The returned manifest contains the
     * same immutable identity that [import] would publish, while the temporary copy is removed
     * before this method returns. This is used by the UI preview so an invalid or unexpected file
     * never becomes a library entry merely by being selected in the picker.
     */
    fun inspect(request: PrivateBookImportRequest): BookImportManifest {
        validateRequest(request)
        ensureDirectory(storageRoot)
        ensureDirectory(stagingDirectory)

        val stagedFile = createStagedFile()
        try {
            val copiedDigest = copyAndSync(request.source, stagedFile)
            val detectedType = BookContentKindDetector.detect(stagedFile)
            val contentType = request.expectedContentType ?: detectedType
            if (request.expectedContentType != null && request.expectedContentType != detectedType) {
                throw BookImportValidationException(
                    BookImportFailure.CONTENT_TYPE_MISMATCH,
                    "The selected file content does not match the requested book type",
                )
            }

            val manifest = inspector.inspect(
                LocalBookImportRequest(
                    source = stagedFile,
                    contentType = contentType,
                    displayName = request.displayName,
                ),
            )
            if (manifest.assetId != copiedDigest.assetId || manifest.byteSize != copiedDigest.byteCount) {
                throw BookImportValidationException(
                    BookImportFailure.COPY_FAILED,
                    "The private copy changed while it was being validated",
                )
            }
            return manifest
        } finally {
            deleteQuietly(stagedFile)
        }
    }

    fun import(request: PrivateBookImportRequest): PrivateBookImportResult {
        validateRequest(request)
        ensureDirectory(storageRoot)
        ensureDirectory(stagingDirectory)

        val stagedFile = createStagedFile()
        try {
            val copiedDigest = copyAndSync(request.source, stagedFile)
            val detectedType = BookContentKindDetector.detect(stagedFile)
            val contentType = request.expectedContentType ?: detectedType
            if (request.expectedContentType != null && request.expectedContentType != detectedType) {
                throw BookImportValidationException(
                    BookImportFailure.CONTENT_TYPE_MISMATCH,
                    "The selected file content does not match the requested book type",
                )
            }

            val manifest = inspector.inspect(
                LocalBookImportRequest(
                    source = stagedFile,
                    contentType = contentType,
                    displayName = request.displayName,
                ),
            )
            if (manifest.assetId != copiedDigest.assetId || manifest.byteSize != copiedDigest.byteCount) {
                throw BookImportValidationException(
                    BookImportFailure.COPY_FAILED,
                    "The private copy changed while it was being validated",
                )
            }

            return publish(stagedFile, manifest, request.displayName)
        } finally {
            // A failed import never publishes a partial file. If the platform refuses deletion,
            // the opaque part remains hidden and can be removed by cleanupAbandonedParts().
            deleteQuietly(stagedFile)
        }
    }

    /** Removes only stale unpublished parts; finalized content-addressed blobs are untouched. */
    fun cleanupAbandonedParts(olderThanEpochMillis: Long): Int {
        if (!stagingDirectory.isDirectory) return 0
        var deleted = 0
        stagingDirectory.listFiles().orEmpty().forEach { candidate ->
            val removed = runCatching {
                candidate.isFile &&
                    candidate.name.endsWith(PART_SUFFIX) &&
                    candidate.lastModified() < olderThanEpochMillis &&
                    candidate.delete()
            }.getOrDefault(false)
            if (removed) {
                deleted++
            }
        }
        return deleted
    }

    private fun copyAndSync(source: LocalBookStreamSource, target: File): StreamDigest {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(BUFFER_SIZE)
        var byteCount = 0L

        try {
            source.openStream().use { input ->
                FileOutputStream(target).use { output ->
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (read == 0) {
                            val singleByte = input.read()
                            if (singleByte < 0) break
                            if (byteCount >= limits.maxBookBytes) tooLarge()
                            output.write(singleByte)
                            digest.update(singleByte.toByte())
                            byteCount++
                            continue
                        }
                        if (byteCount > limits.maxBookBytes - read) tooLarge()
                        output.write(buffer, 0, read)
                        digest.update(buffer, 0, read)
                        byteCount += read
                    }
                    output.flush()
                    output.fd.sync()
                }
            }
        } catch (failure: BookImportValidationException) {
            throw failure
        } catch (failure: SecurityException) {
            throw BookImportValidationException(
                BookImportFailure.SOURCE_UNAVAILABLE,
                "The selected book can no longer be read",
                failure,
            )
        } catch (failure: IOException) {
            throw BookImportValidationException(
                BookImportFailure.COPY_FAILED,
                "The selected book could not be copied into private storage",
                failure,
            )
        }

        val hex = digest.digest().joinToString(separator = "") { "%02x".format(it) }
        return StreamDigest(BookAssetId.fromSha256(hex), byteCount)
    }

    private fun publish(
        stagedFile: File,
        manifest: BookImportManifest,
        displayName: String,
    ): PrivateBookImportResult = synchronized(PUBLISH_LOCK) {
        val contentDirectory = File(storageRoot, manifest.contentType.storageDirectory)
        ensureDirectory(contentDirectory)
        val finalFile = File(contentDirectory, "${manifest.assetId.value}.${manifest.contentType.extension}")

        if (finalFile.exists()) {
            return@synchronized reuseExisting(finalFile, manifest, displayName)
        }
        val renamed = try {
            stagedFile.renameTo(finalFile)
        } catch (failure: SecurityException) {
            throw BookImportValidationException(
                BookImportFailure.FINALIZATION_FAILED,
                "The verified book could not be finalized in private storage",
                failure,
            )
        }
        if (!renamed) {
            // A concurrent publisher may have won between the existence check and rename.
            if (finalFile.exists()) return@synchronized reuseExisting(finalFile, manifest, displayName)
            throw BookImportValidationException(
                BookImportFailure.FINALIZATION_FAILED,
                "The verified book could not be finalized in private storage",
            )
        }

        PrivateBookImportResult(
            manifest = manifest,
            privateFile = finalFile,
            disposition = PrivateBookImportDisposition.IMPORTED,
            coverFile = coverMaterializer.materialize(finalFile, manifest.contentType, manifest.assetId.value),
            metadata = BookImportMetadataExtractor.extract(finalFile, manifest.contentType, displayName),
        )
    }

    private fun reuseExisting(
        existing: File,
        incoming: BookImportManifest,
        displayName: String,
    ): PrivateBookImportResult {
        val existingManifest = try {
            inspector.inspect(LocalBookImportRequest(existing, incoming.contentType, displayName))
        } catch (failure: Exception) {
            throw BookImportValidationException(
                BookImportFailure.ASSET_COLLISION,
                "Private storage already contains an invalid blob for this asset identity",
                failure,
            )
        }
        if (existingManifest.assetId != incoming.assetId || existingManifest.byteSize != incoming.byteSize) {
            throw BookImportValidationException(
                BookImportFailure.ASSET_COLLISION,
                "Private storage contains different bytes for this asset identity",
            )
        }
        return PrivateBookImportResult(
            manifest = existingManifest,
            privateFile = existing,
            disposition = PrivateBookImportDisposition.ALREADY_PRESENT,
            coverFile = coverMaterializer.materialize(existing, incoming.contentType, incoming.assetId.value),
            metadata = BookImportMetadataExtractor.extract(existing, incoming.contentType, displayName),
        )
    }

    private fun createStagedFile(): File {
        repeat(MAX_STAGING_NAME_ATTEMPTS) {
            val candidate = File(stagingDirectory, "import-${UUID.randomUUID()}$PART_SUFFIX")
            try {
                if (candidate.createNewFile()) return candidate
            } catch (failure: Exception) {
                throw BookImportValidationException(
                    BookImportFailure.PRIVATE_STORAGE_UNAVAILABLE,
                    "A private staging file could not be created",
                    failure,
                )
            }
        }
        throw BookImportValidationException(
            BookImportFailure.PRIVATE_STORAGE_UNAVAILABLE,
            "A unique private staging file could not be created",
        )
    }

    private fun ensureDirectory(directory: File) {
        val available = try {
            directory.isDirectory || (directory.mkdirs() || directory.isDirectory)
        } catch (_: SecurityException) {
            false
        }
        if (!available) {
            throw BookImportValidationException(
                BookImportFailure.PRIVATE_STORAGE_UNAVAILABLE,
                "The private book storage directory is unavailable",
            )
        }
    }

    private fun deleteQuietly(file: File) {
        try {
            if (file.exists()) file.delete()
        } catch (_: SecurityException) {
            // The opaque part is never published and is eligible for a later cleanup pass.
        }
    }

    private fun validateRequest(request: PrivateBookImportRequest) {
        if (request.displayName.isBlank()) {
            throw BookImportValidationException(BookImportFailure.SOURCE_UNAVAILABLE, "Book display name cannot be blank")
        }
        val expected = request.expectedContentType
        if (expected != null && expected != ContentType.EPUB && expected != ContentType.PDF) {
            throw BookImportValidationException(
                BookImportFailure.UNSUPPORTED_FORMAT,
                "Only EPUB and PDF files can be imported into the private book store",
            )
        }
    }

    private fun tooLarge(): Nothing = throw BookImportValidationException(
        BookImportFailure.FILE_TOO_LARGE,
        "The selected book exceeds the import size limit",
    )

    private val ContentType.storageDirectory: String
        get() = when (this) {
            ContentType.EPUB -> "epub"
            ContentType.PDF -> "pdf"
            else -> error("Only EPUB and PDF are private book assets")
        }

    private val ContentType.extension: String
        get() = when (this) {
            ContentType.EPUB -> "epub"
            ContentType.PDF -> "pdf"
            else -> error("Only EPUB and PDF are private book assets")
        }

    private companion object {
        const val BUFFER_SIZE = 64 * 1024
        const val STAGING_DIRECTORY = ".staging"
        const val PART_SUFFIX = ".part"
        const val MAX_STAGING_NAME_ATTEMPTS = 8
        val PUBLISH_LOCK = Any()
    }
}

internal object BookContentKindDetector {
    private const val PDF_HEADER = "%PDF-"
    private const val HEADER_WINDOW = 1024

    fun detect(file: File): ContentType {
        val prefixSize = minOf(file.length(), HEADER_WINDOW.toLong()).toInt()
        val prefix = ByteArray(prefixSize)
        try {
            RandomAccessFile(file, "r").use { it.readFully(prefix) }
        } catch (failure: IOException) {
            throw BookImportValidationException(
                BookImportFailure.COPY_FAILED,
                "The private copy could not be inspected",
                failure,
            )
        }

        if (prefix.startsWith(ZIP_LOCAL_HEADER)) return ContentType.EPUB
        if (prefix.toString(Charsets.ISO_8859_1).contains(PDF_HEADER)) return ContentType.PDF
        throw BookImportValidationException(
            BookImportFailure.UNSUPPORTED_FORMAT,
            "The selected file is neither an EPUB nor a PDF",
        )
    }

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean =
        size >= prefix.size && prefix.indices.all { this[it] == prefix[it] }

    private val ZIP_LOCAL_HEADER = byteArrayOf(0x50, 0x4b, 0x03, 0x04)
}
