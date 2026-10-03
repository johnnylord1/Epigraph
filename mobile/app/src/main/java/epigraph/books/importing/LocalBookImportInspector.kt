package epigraph.books.importing

import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.ContentType
import java.io.File
import java.io.RandomAccessFile

data class LocalBookImportLimits(
    val maxBookBytes: Long = 1L * 1024 * 1024 * 1024,
    val epub: EpubArchiveLimits = EpubArchiveLimits(maxArchiveBytes = maxBookBytes),
)

class LocalBookImportInspector(
    private val limits: LocalBookImportLimits = LocalBookImportLimits(),
) {
    fun inspect(request: LocalBookImportRequest): BookImportManifest {
        validateSource(request.source)
        if (request.displayName.isBlank()) {
            throw BookImportValidationException(BookImportFailure.SOURCE_UNAVAILABLE, "Book display name cannot be blank")
        }

        val epubManifest = when (request.contentType) {
            ContentType.EPUB -> EpubArchiveValidator.validate(request.source, limits.epub)
            ContentType.PDF -> {
                validatePdfHeader(request.source)
                null
            }
            else -> throw BookImportValidationException(
                BookImportFailure.UNSUPPORTED_FORMAT,
                "Only EPUB and PDF files can be inspected as local books",
            )
        }
        val digest = StreamingSha256.digest(request.source, limits.maxBookBytes)
        return BookImportManifest(
            assetId = digest.assetId,
            entityId = EpigraphIdentityRules.importedBookId(request.contentType, digest.assetId.value),
            contentType = request.contentType,
            displayName = request.displayName,
            byteSize = digest.byteCount,
            mediaType = when (request.contentType) {
                ContentType.EPUB -> "application/epub+zip"
                ContentType.PDF -> "application/pdf"
            },
            epubArchive = epubManifest,
            metadata = BookImportMetadataExtractor.extract(
                file = request.source,
                contentType = request.contentType,
                fallbackDisplayName = request.displayName,
            ),
        )
    }

    private fun validateSource(file: File) {
        if (!file.isFile || !file.canRead()) {
            throw BookImportValidationException(
                BookImportFailure.SOURCE_UNAVAILABLE,
                "The selected book is not a readable file",
            )
        }
        if (file.length() > limits.maxBookBytes) {
            throw BookImportValidationException(BookImportFailure.FILE_TOO_LARGE, "The selected book is too large")
        }
    }

    private fun validatePdfHeader(file: File) {
        val prefixSize = minOf(file.length(), PDF_HEADER_WINDOW.toLong()).toInt()
        val prefix = ByteArray(prefixSize)
        RandomAccessFile(file, "r").use { it.readFully(prefix) }
        if (!prefix.toString(Charsets.ISO_8859_1).contains(PDF_HEADER)) {
            throw BookImportValidationException(
                BookImportFailure.INVALID_PDF_HEADER,
                "The selected file does not contain a valid PDF header",
            )
        }
    }

    private companion object {
        const val PDF_HEADER = "%PDF-"
        const val PDF_HEADER_WINDOW = 1024
    }
}
