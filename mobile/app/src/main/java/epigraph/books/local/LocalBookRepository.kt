package epigraph.books.local

import epigraph.contract.ReaderLocator
import kotlinx.coroutines.flow.Flow

interface LocalBookRepository {
    fun observeBooks(): Flow<List<LocalBook>>

    fun observeBooks(contentType: epigraph.contract.ContentType): Flow<List<LocalBook>>

    suspend fun find(bookId: String): LocalBook?

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

    suspend fun getProgress(bookId: String): ReaderLocator?

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
