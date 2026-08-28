package epigraph.books.local

import epigraph.books.model.BookAssetId
import epigraph.books.model.LocalBookDocument
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import java.io.File
import kotlinx.serialization.Serializable

data class LocalBook(
    val bookId: String,
    val contentType: ContentType,
    val sha256: String,
    val displayName: String,
    val author: String?,
    val description: String?,
    val coverPath: String?,
    val coverAssetSha256: String?,
    val coverAssetByteSize: Long?,
    val coverAssetMimeType: String?,
    val privatePath: String,
    val mimeType: String,
    val byteSize: Long,
    val chapterCount: Int? = null,
    val pageCount: Int? = null,
    val importedAt: Long,
    val updatedAt: Long,
    /** Confirmed PDF outline entries projected by Epigraph Core; not synthetic page buckets. */
    val pdfSections: List<LocalBookPdfSection> = emptyList(),
) {
    init {
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "Only EPUB and PDF documents can be local books"
        }
        require(bookId.isNotBlank()) { "A local book must have an ID" }
        require(sha256.matches(SHA_256)) { "A local book must have a SHA-256 identity" }
        require(displayName.isNotBlank()) { "A local book must have a display name" }
        require(byteSize >= 0) { "A local book cannot have a negative size" }
        require(chapterCount == null || chapterCount > 0) { "A local book chapter count must be positive" }
        require(pageCount == null || pageCount > 0) { "A local book page count must be positive" }
        require(contentType == ContentType.PDF || pdfSections.isEmpty()) {
            "Only PDF publications can expose page-anchored outline sections"
        }
        val hasCoverAsset = coverAssetSha256 != null || coverAssetByteSize != null || coverAssetMimeType != null
        require(!hasCoverAsset || (
            coverAssetSha256?.matches(SHA_256) == true &&
                coverAssetByteSize != null && coverAssetByteSize in 1..MAX_COVER_ASSET_BYTES &&
                coverAssetMimeType != null && coverAssetMimeType in COVER_MIME_TYPES
        )) { "A local book cover asset must have complete, valid metadata" }
    }

    fun document(): LocalBookDocument = LocalBookDocument(
        contentType = contentType,
        assetId = BookAssetId.fromSha256(sha256),
        file = File(privatePath),
        displayName = displayName,
    )

    val isAvailable: Boolean
        get() = File(privatePath).isFile

    private companion object {
        val SHA_256 = Regex("[0-9a-f]{64}")
        const val MAX_COVER_ASSET_BYTES = 8L * 1024L * 1024L
        val COVER_MIME_TYPES = setOf("image/jpeg", "image/png", "image/webp")
    }
}

data class LocalBookPdfSection(
    val title: String,
    /** Zero-based page index used by ReaderLocator.Pdf. */
    val pageIndex: Int,
    val depth: Int = 0,
) {
    init {
        require(title.isNotBlank()) { "A PDF outline section needs a title" }
        require(pageIndex >= 0) { "A PDF outline page cannot be negative" }
        require(depth >= 0) { "A PDF outline depth cannot be negative" }
    }
}

@Serializable
data class BookBookmark(
    val bookmarkId: String,
    val bookId: String,
    val locator: ReaderLocator,
    val label: String? = null,
    val note: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

@Serializable
data class BookHighlight(
    val highlightId: String,
    val bookId: String,
    val start: ReaderLocator,
    val end: ReaderLocator,
    val selectedText: String,
    val colorArgb: Long,
    val note: String? = null,
    val createdAt: Long,
    val updatedAt: Long,
)

data class ImportedBook(
    val privateResult: epigraph.books.importing.PrivateBookImportResult,
    val title: String = privateResult.manifest.displayName,
    val author: String? = null,
    val description: String? = null,
    val coverPath: String? = privateResult.coverFile?.absolutePath,
)

/** A complete local-book state used by the app backup, without private file bytes. */
data class LocalBookBackupSnapshot(
    val book: LocalBook,
    val progress: ReaderLocator?,
    val bookmarks: List<BookBookmark>,
    val highlights: List<BookHighlight>,
    val categoryIds: List<Long>,
)

/** Metadata restored from a backup before the user relinks or imports the private file. */
data class LocalBookRestoreEntry(
    val bookId: String,
    val contentType: ContentType,
    val sha256: String,
    val displayName: String,
    val author: String?,
    val description: String?,
    val mimeType: String,
    val byteSize: Long,
    val importedAt: Long,
    val updatedAt: Long,
    val chapterCount: Int? = null,
    val pageCount: Int? = null,
    val progress: ReaderLocator?,
    val bookmarks: List<BookBookmark>,
    val highlights: List<BookHighlight>,
    val categoryIds: List<Long>,
) {
    init {
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "Only EPUB and PDF metadata can be restored"
        }
        require(bookId == epigraph.contract.EpigraphIdentityRules.importedBookId(contentType, sha256).value) {
            "A restored local book must use its content-addressed identity"
        }
        require(sha256.matches(Regex("[0-9a-f]{64}"))) {
            "A restored local book must have a lowercase SHA-256"
        }
        require(displayName.isNotBlank()) { "A restored local book needs a display name" }
        require(byteSize >= 0) { "A restored local book cannot have a negative size" }
        progress?.let {
            require(it.entityId.value == bookId) { "Restored progress belongs to another book" }
            require(it.contentType == contentType) { "Restored progress has a different content type" }
        }
        require(bookmarks.all { it.bookId == bookId }) { "Restored bookmarks belong to another book" }
        require(highlights.all { it.bookId == bookId }) { "Restored highlights belong to another book" }
        require(bookmarks.all { it.locator.entityId.value == bookId && it.locator.contentType == contentType }) {
            "Restored bookmark locators do not belong to this book"
        }
        require(highlights.all {
            it.start.entityId.value == bookId &&
                it.end.entityId.value == bookId &&
                it.start.contentType == contentType &&
                it.end.contentType == contentType
        }) {
            "Restored highlight locators do not belong to this book"
        }
    }
}
