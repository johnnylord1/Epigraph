package epigraph.books.local

import epigraph.contract.ContentType
import java.io.File
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LocalBookAvailabilityTest {

    @Test
    fun `a synced book whose file is on Core downloads when opened instead of being missing`() {
        val book = book(privatePath = "C:\missing\book.epub", remoteAvailable = true)

        assertFalse(book.isAvailable)
        assertTrue(book.downloadsWhenOpened)
    }

    @Test
    fun `a local import without its file and without a Core copy is missing`() {
        assertFalse(book(privatePath = "C:\missing\book.epub", remoteAvailable = false).downloadsWhenOpened)
    }

    @Test
    fun `a downloaded book never reports a pending download`() {
        val file = File.createTempFile("local-book", ".epub").apply { deleteOnExit() }

        val book = book(privatePath = file.path, remoteAvailable = true)

        assertTrue(book.isAvailable)
        assertFalse(book.downloadsWhenOpened)
    }

    private fun book(privatePath: String, remoteAvailable: Boolean) = LocalBook(
        bookId = "epub-${"a".repeat(64)}",
        contentType = ContentType.EPUB,
        sha256 = "a".repeat(64),
        displayName = "Book",
        author = null,
        description = null,
        coverPath = null,
        coverAssetSha256 = null,
        coverAssetByteSize = null,
        coverAssetMimeType = null,
        privatePath = privatePath,
        mimeType = "application/epub+zip",
        byteSize = 1,
        importedAt = 1,
        updatedAt = 1,
        remoteAvailable = remoteAvailable,
    )
}
