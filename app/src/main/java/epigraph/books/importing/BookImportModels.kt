package epigraph.books.importing

import epigraph.books.model.BookAssetId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.ContentType
import java.io.File

data class LocalBookImportRequest(
    val source: File,
    val contentType: ContentType,
    val displayName: String = source.name,
)

data class BookImportManifest(
    val assetId: BookAssetId,
    val entityId: EpigraphEntityId,
    val contentType: ContentType,
    val displayName: String,
    val byteSize: Long,
    val mediaType: String,
    val epubArchive: EpubArchiveManifest? = null,
    val metadata: BookImportMetadata = BookImportMetadata(),
    /** Number of navigable EPUB spine documents, when available at import time. */
    val chapterCount: Int? = epubArchive?.spinePaths?.size?.takeIf { it > 0 },
) {
    init {
        require(displayName.isNotBlank()) { "A book must have a display name" }
        require(byteSize >= 0) { "Book size cannot be negative" }
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "A local book import must be EPUB or PDF"
        }
        require(entityId == EpigraphIdentityRules.importedBookId(contentType, assetId.value)) {
            "Book entity identity must match its content type and immutable asset hash"
        }
        require((contentType == ContentType.EPUB) == (epubArchive != null)) {
            "Only EPUB imports have an EPUB archive manifest"
        }
    }
}

data class EpubArchiveManifest(
    val entries: List<EpubArchiveEntry>,
    val totalUncompressedBytes: Long,
    val packagePath: String,
    val spinePaths: List<String>,
    val containerPath: String = "META-INF/container.xml",
) {
    init {
        require(packagePath.isNotBlank()) { "An EPUB must identify its package document" }
        require(spinePaths.isNotEmpty()) { "An EPUB must contain at least one spine document" }
    }
}

data class EpubArchiveEntry(
    val path: String,
    val compressedBytes: Long,
    val uncompressedBytes: Long,
)

enum class BookImportFailure {
    SOURCE_UNAVAILABLE,
    COPY_FAILED,
    PRIVATE_STORAGE_UNAVAILABLE,
    FINALIZATION_FAILED,
    CONTENT_TYPE_MISMATCH,
    ASSET_COLLISION,
    FILE_TOO_LARGE,
    UNSUPPORTED_FORMAT,
    MALFORMED_ARCHIVE,
    UNSAFE_ARCHIVE_PATH,
    DUPLICATE_ARCHIVE_PATH,
    TOO_MANY_ARCHIVE_ENTRIES,
    ARCHIVE_ENTRY_TOO_LARGE,
    ARCHIVE_TOO_LARGE,
    SUSPICIOUS_COMPRESSION_RATIO,
    INVALID_EPUB_STRUCTURE,
    INVALID_PDF_HEADER,
}

class BookImportValidationException(
    val failure: BookImportFailure,
    message: String,
    cause: Throwable? = null,
) : IllegalArgumentException(message, cause)
