package eu.kanade.tachiyomi.data.backup.restore.restorers

import epigraph.books.local.BookBookmark
import epigraph.books.importing.LocalBookStreamSource
import epigraph.books.local.BookHighlight
import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookImportService
import epigraph.books.local.LocalBookRepository
import epigraph.books.local.LocalBookRestoreEntry
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBook
import kotlinx.serialization.json.Json
import eu.kanade.tachiyomi.data.database.models.Category
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories
import yokai.domain.category.interactor.InsertCategories
import yokai.util.koin.get

class LocalBookBackupRestorer(
    private val repository: LocalBookRepository = get(),
    private val getCategories: GetCategories = get(),
    private val insertCategories: InsertCategories = get(),
    private val json: Json = get(),
) {
    /** Only needed when the backup carries the book's file. */
    private val importService: LocalBookImportService by lazy { get() }

    /**
     * Restores the library entry and reader state of a local book. When the backup also stores
     * its file ([storedFile]) and this device lacks it, the file is imported after its SHA-256 is
     * verified against the book's identity; otherwise the entry stays visibly relinkable.
     */
    suspend fun restore(backup: BackupLocalBook, storedFile: LocalBookStreamSource? = null): LocalBook {
        val contentType = runCatching { ContentType.valueOf(backup.contentType) }
            .getOrElse { error("Unsupported local book type: ${backup.contentType}") }
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "Only EPUB and PDF backups can be restored"
        }

        // Books only live in Books & novels folders; a missing one is created there.
        val folders = getCategories.await(CategoryLibrary.BOOKS)
        val categoryIds = folders
            .mapNotNull { category ->
                category.id?.toLong()?.let { id -> id to category.name }
            }
            .associate { (id, name) -> name to id }
            .toMutableMap()
        var nextOrder = (folders.maxOfOrNull { it.order } ?: 0) + 1
        backup.categoryNames.distinct().filter { it.isNotBlank() && it !in categoryIds }.forEach { name ->
            val created = Category.create(name).apply { order = nextOrder++ }
            insertCategories.awaitOne(created, CategoryLibrary.BOOKS)?.let { categoryIds[name] = it }
        }

        val progress = backup.progressLocatorJson?.let { decodeLocator(it) }
        val bookmarks = backup.bookmarks.map { bookmark ->
            BookBookmark(
                bookmarkId = bookmark.bookmarkId,
                bookId = backup.bookId,
                locator = decodeLocator(bookmark.locatorJson),
                label = bookmark.label,
                note = bookmark.note,
                createdAt = bookmark.createdAt,
                updatedAt = bookmark.updatedAt,
            )
        }
        val highlights = backup.highlights.map { highlight ->
            BookHighlight(
                highlightId = highlight.highlightId,
                bookId = backup.bookId,
                start = decodeLocator(highlight.startLocatorJson),
                end = decodeLocator(highlight.endLocatorJson),
                selectedText = highlight.selectedText,
                colorArgb = highlight.colorArgb,
                note = highlight.note,
                createdAt = highlight.createdAt,
                updatedAt = highlight.updatedAt,
            )
        }

        val restored = repository.restoreMissing(
            LocalBookRestoreEntry(
                bookId = backup.bookId,
                contentType = contentType,
                sha256 = backup.sha256,
                displayName = backup.displayName,
                author = backup.author,
                description = backup.description,
                mimeType = backup.mimeType,
                byteSize = backup.byteSize,
                importedAt = backup.importedAt,
                updatedAt = backup.updatedAt,
                chapterCount = backup.chapterCount,
                pageCount = backup.pageCount,
                progress = progress,
                bookmarks = bookmarks,
                highlights = highlights,
                categoryIds = backup.categoryNames.mapNotNull(categoryIds::get).distinct(),
            ),
        )
        if (storedFile == null || restored.isAvailable) return restored
        return importService.relink(storedFile, restored)
    }

    private fun decodeLocator(value: String): ReaderLocator =
        json.decodeFromString(ReaderLocator.serializer(), value)
}
