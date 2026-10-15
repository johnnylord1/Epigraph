package epigraph.books.local

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import epigraph.books.importing.AndroidSafBookImportSource
import epigraph.books.importing.LocalBookPrivateImporter
import epigraph.books.importing.LocalBookStreamSource
import epigraph.books.importing.PrivateBookImportRequest
import epigraph.contract.ContentType
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories

data class ImportPreview(
    val displayName: String,
    val contentType: ContentType,
    val byteSize: Long,
    val sha256: String,
    val title: String? = null,
    val author: String? = null,
    val description: String? = null,
    val alreadyImported: Boolean = false,
)

class LocalBookImportService(
    private val contentResolver: ContentResolver,
    private val importer: LocalBookPrivateImporter,
    private val repository: LocalBookRepository,
    private val preferences: PreferencesHelper,
    private val getCategories: GetCategories,
) {
    suspend fun inspect(
        uri: Uri,
        displayName: String = "",
        expectedContentType: ContentType? = null,
    ): ImportPreview = withContext(Dispatchers.IO) {
        val resolvedName = displayName.ifBlank { queryDisplayName(uri) }
        require(resolvedName.isNotBlank()) { "A book display name cannot be blank" }
        val manifest = importer.inspect(
            PrivateBookImportRequest(
                source = AndroidSafBookImportSource(contentResolver, uri, resolvedName),
                expectedContentType = expectedContentType,
                displayName = resolvedName,
            ),
        )
        ImportPreview(
            displayName = manifest.displayName,
            contentType = manifest.contentType,
            byteSize = manifest.byteSize,
            sha256 = manifest.assetId.value,
            title = manifest.metadata.title,
            author = manifest.metadata.author,
            description = manifest.metadata.description,
            alreadyImported = repository.findBySha256(manifest.assetId.value) != null,
        )
    }

    suspend fun import(
        uri: Uri,
        displayName: String = "",
        expectedContentType: ContentType? = null,
    ): LocalBook = withContext(Dispatchers.IO) {
        val resolvedName = displayName.ifBlank { queryDisplayName(uri) }
        require(resolvedName.isNotBlank()) { "A book display name cannot be blank" }
        val result = importer.import(
            PrivateBookImportRequest(
                source = AndroidSafBookImportSource(contentResolver, uri, resolvedName),
                expectedContentType = expectedContentType,
                displayName = resolvedName,
            ),
        )
        val metadata = result.metadata
        repository.publish(
            ImportedBook(
                privateResult = result,
                title = metadata.title?.takeIf(String::isNotBlank) ?: cleanFallbackTitle(resolvedName),
                author = metadata.author,
                description = metadata.description,
            ),
        )
    }

    /**
     * Files a book the user just imported in the Books & novels default category, like adding a
     * novel does. A book already in a category keeps it. Restores keep the backup's folders.
     */
    suspend fun fileInDefaultCategory(book: LocalBook) = withContext(Dispatchers.IO) {
        val categoryId = preferences.defaultBooksCategory().get()
        if (categoryId <= 0) return@withContext
        if (getCategories.await(CategoryLibrary.BOOKS).none { it.id == categoryId }) return@withContext
        if (repository.getCategoryIds(book.bookId).isNotEmpty()) return@withContext
        repository.setCategory(book.bookId, categoryId.toLong(), true)
    }

    suspend fun relink(uri: Uri, book: LocalBook, displayName: String = book.displayName): LocalBook =
        withContext(Dispatchers.IO) {
            val resolvedName = displayName.ifBlank { queryDisplayName(uri) }.ifBlank { book.displayName }
            relink(AndroidSafBookImportSource(contentResolver, uri, resolvedName), book)
        }

    /** Restores the file of a missing [book] from [source], which must hash to the book's SHA-256. */
    suspend fun relink(source: LocalBookStreamSource, book: LocalBook): LocalBook =
        withContext(Dispatchers.IO) {
            val request = PrivateBookImportRequest(
                source = source,
                expectedContentType = book.contentType,
                displayName = source.displayName,
            )
            val inspected = importer.inspect(request)
            require(inspected.assetId.value == book.sha256) {
                "The selected file does not match the missing book's SHA-256"
            }
            val result = importer.import(request)
            try {
                repository.relink(
                    bookId = book.bookId,
                    imported = ImportedBook(
                        privateResult = result,
                        title = book.displayName,
                        author = book.author ?: result.metadata.author,
                        description = book.description ?: result.metadata.description,
                        coverPath = result.coverFile?.absolutePath ?: book.coverPath,
                    ),
                )
            } catch (error: Throwable) {
                // Do not leave an orphaned blob when a race removes the DB row after validation.
                if (result.disposition == epigraph.books.importing.PrivateBookImportDisposition.IMPORTED) {
                    runCatching { result.privateFile.delete() }
                }
                throw error
            }
        }

    private fun queryDisplayName(uri: Uri): String = runCatching {
        contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    cursor.getString(cursor.getColumnIndexOrThrow(OpenableColumns.DISPLAY_NAME))
                } else {
                    null
                }
            }
    }.getOrNull().orEmpty()

    private fun cleanFallbackTitle(displayName: String): String = displayName
        .substringBeforeLast('.', displayName)
        .replace('_', ' ')
        .trim()
}
