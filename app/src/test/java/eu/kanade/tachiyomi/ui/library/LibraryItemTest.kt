package eu.kanade.tachiyomi.ui.library

import epigraph.books.local.LocalBook
import epigraph.contract.ContentType
import eu.kanade.tachiyomi.data.database.models.Category
import eu.kanade.tachiyomi.data.database.models.LibraryManga
import eu.kanade.tachiyomi.data.database.models.MangaImpl
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class LibraryItemTest {

    @Test
    fun `binding signature is stable for equivalent rows`() {
        assertEquals(item().bindingContentSignature(), item().bindingContentSignature())
    }

    @Test
    fun `binding signature includes fields hidden by manga identity`() {
        val original = item()
        val changed = item(unread = 4, title = "Changed")

        assertEquals(original, changed)
        assertNotEquals(original.bindingContentSignature(), changed.bindingContentSignature())
    }

    @Test
    fun `binding signature includes category and badge state`() {
        val original = item()
        val changed = item(downloadCount = 2, categoryHidden = true)

        assertNotEquals(original.bindingContentSignature(), changed.bindingContentSignature())
    }

    @Test
    fun `local book item keeps its domain identity and filters by book metadata`() {
        val original = bookItem(title = "Example PDF", type = ContentType.PDF)
        val changed = bookItem(title = "Other EPUB", type = ContentType.EPUB)

        assertNotEquals(original.bindingContentSignature(), changed.bindingContentSignature())
        assertEquals(true, original.filter("pdf"))
        assertEquals(true, original.filter("example"))
        assertEquals(false, original.filter("missing"))
    }

    private fun item(
        unread: Int = 1,
        title: String = "Example",
        downloadCount: Int = 0,
        categoryHidden: Boolean = false,
    ): LibraryMangaItem {
        val category = Category.create("Library").apply {
            id = 1
            isHidden = categoryHidden
        }
        val header = LibraryHeaderItem({ category }, category.id!!)
        val manga = MangaImpl(id = 10, source = 20, url = "/example").apply {
            this.title = title
            author = "Author"
            thumbnail_url = "https://example.invalid/cover.jpg"
        }
        return LibraryMangaItem(
            manga = LibraryManga(manga = manga, unread = unread, category = category.id!!),
            header = header,
            context = null,
        ).apply {
            this.downloadCount = downloadCount
        }
    }

    private fun bookItem(title: String, type: ContentType): LibraryBookItem {
        val category = Category.create("Books").apply {
            id = -2
        }
        val header = LibraryHeaderItem({ category }, category.id!!)
        return LibraryBookItem(
            book = LocalBook(
                bookId = "${type.name.lowercase()}-${"a".repeat(64)}",
                contentType = type,
                sha256 = "a".repeat(64),
                displayName = title,
                author = "Author",
                description = null,
                coverPath = null,
                coverAssetSha256 = null,
                coverAssetByteSize = null,
                coverAssetMimeType = null,
                privatePath = "C:\\missing\\$title",
                mimeType = if (type == ContentType.PDF) "application/pdf" else "application/epub+zip",
                byteSize = 1,
                importedAt = 1,
                updatedAt = 1,
            ),
            header = header,
            context = null,
        )
    }
}
