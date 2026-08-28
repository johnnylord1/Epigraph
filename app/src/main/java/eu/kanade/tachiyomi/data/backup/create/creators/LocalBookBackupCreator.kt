package eu.kanade.tachiyomi.data.backup.create.creators

import epigraph.books.local.LocalBookRepository
import epigraph.contract.ReaderLocator
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBook
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBookBookmark
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBookHighlight
import kotlinx.serialization.json.Json
import kotlinx.serialization.encodeToString
import yokai.domain.category.interactor.GetCategories
import yokai.util.koin.get

class LocalBookBackupCreator(
    private val repository: LocalBookRepository = get(),
    private val getCategories: GetCategories = get(),
    private val json: Json = get(),
) {
    suspend operator fun invoke(includeCategories: Boolean): List<BackupLocalBook> {
        val categories = if (includeCategories) {
            getCategories.await().mapNotNull { category ->
                category.id?.toLong()?.let { it to category.name }
            }.toMap()
        } else {
            emptyMap()
        }

        return repository.snapshotForBackup().map { snapshot ->
            BackupLocalBook(
                bookId = snapshot.book.bookId,
                contentType = snapshot.book.contentType.name,
                sha256 = snapshot.book.sha256,
                displayName = snapshot.book.displayName,
                author = snapshot.book.author,
                description = snapshot.book.description,
                mimeType = snapshot.book.mimeType,
                byteSize = snapshot.book.byteSize,
                importedAt = snapshot.book.importedAt,
                updatedAt = snapshot.book.updatedAt,
                progressLocatorJson = snapshot.progress?.let { encodeLocator(it) },
                bookmarks = snapshot.bookmarks.map { bookmark ->
                    BackupLocalBookBookmark(
                        bookmarkId = bookmark.bookmarkId,
                        locatorJson = encodeLocator(bookmark.locator),
                        label = bookmark.label,
                        note = bookmark.note,
                        createdAt = bookmark.createdAt,
                        updatedAt = bookmark.updatedAt,
                    )
                },
                highlights = snapshot.highlights.map { highlight ->
                    BackupLocalBookHighlight(
                        highlightId = highlight.highlightId,
                        startLocatorJson = encodeLocator(highlight.start),
                        endLocatorJson = encodeLocator(highlight.end),
                        selectedText = highlight.selectedText,
                        colorArgb = highlight.colorArgb,
                        note = highlight.note,
                        createdAt = highlight.createdAt,
                        updatedAt = highlight.updatedAt,
                    )
                },
                categoryNames = snapshot.categoryIds.mapNotNull(categories::get).distinct(),
                chapterCount = snapshot.book.chapterCount,
                pageCount = snapshot.book.pageCount,
            )
        }
    }

    private fun encodeLocator(locator: ReaderLocator): String =
        json.encodeToString(ReaderLocator.serializer(), locator)
}
