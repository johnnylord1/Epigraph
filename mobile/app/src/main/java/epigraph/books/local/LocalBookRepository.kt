package epigraph.books.local

import epigraph.contract.ReaderLocator
import kotlinx.coroutines.flow.Flow

interface LocalBookRepository {
    fun observeBooks(): Flow<List<LocalBook>>

    fun observeBooks(contentType: epigraph.contract.ContentType): Flow<List<LocalBook>>

    suspend fun find(bookId: String): LocalBook?

    /**
     * Reads the sections of a PDF from its own outline, once, as soon as its file is on this device.
     * They stay on this device, and sections the Core confirms for the book win over them.
     */
    suspend fun ensurePdfOutline(bookId: String)

    suspend fun findBySha256(sha256: String): LocalBook?

    suspend fun snapshotForBackup(): List<LocalBookBackupSnapshot>

    /** Restores metadata and reader state while deliberately leaving the private file absent. */
    suspend fun restoreMissing(entry: LocalBookRestoreEntry): LocalBook

    suspend fun publish(imported: ImportedBook): LocalBook

    suspend fun relink(bookId: String, imported: ImportedBook): LocalBook

    suspend fun remove(bookId: String, removeFile: Boolean)

    suspend fun saveProgress(bookId: String, locator: ReaderLocator)

    /** Persists reader-derived structure metadata without creating a sync mutation. */
    suspend fun saveStructure(bookId: String, chapterCount: Int?, pageCount: Int?)
    suspend fun saveTitleAndAuthor(bookId: String, title: String, author: String?)

    suspend fun getProgress(bookId: String): ReaderLocator?

    suspend fun getChapterState(bookId: String): LocalBookChapterState

    /** Records how far the position has read the book, and the position accounted for. */
    suspend fun saveReadingState(bookId: String, readThrough: Int, localLocator: ReaderLocator?)

    /** Sets chapters read or unread; null returns a chapter to what [saveReadingState] implies. */
    suspend fun setChaptersRead(bookId: String, chapters: Map<Int, Boolean?>)

    /** Marks the whole book read or unread, which drops every per-chapter choice. */
    suspend fun resetChaptersRead(bookId: String, readThrough: Int)

    suspend fun setChaptersBookmarked(bookId: String, chapters: Collection<Int>, bookmarked: Boolean)

    suspend fun addBookmark(bookmark: BookBookmark)

    suspend fun getBookmarks(bookId: String): List<BookBookmark>

    suspend fun removeBookmark(bookmarkId: String)

    suspend fun addHighlight(highlight: BookHighlight)

    suspend fun getHighlights(bookId: String): List<BookHighlight>

    suspend fun removeHighlight(highlightId: String)

    suspend fun setCategory(bookId: String, categoryId: Long, enabled: Boolean)

    suspend fun getCategoryIds(bookId: String): List<Long>

    /** Repairs derived cover files and fills metadata for rows created by older app builds. */
    suspend fun repairExistingBooks(): LocalBookRepairReport
}

data class LocalBookRepairReport(
    val inspected: Int,
    val repaired: Int,
    val coversMaterialized: Int,
    val metadataUpdated: Int,
    val unavailable: Int,
)

enum class LocalBookPublishDisposition {
    IMPORTED,
    ALREADY_PRESENT,
}

data class LocalBookPublishResult(
    val book: LocalBook,
    val disposition: LocalBookPublishDisposition,
)
