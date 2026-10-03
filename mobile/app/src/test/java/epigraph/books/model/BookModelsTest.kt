package epigraph.books.model

import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BookModelsTest {
    private val assetId = BookAssetId.fromSha256("a".repeat(64))

    @Test
    fun `locators preserve normalized reader progress`() {
        val entityId = LocalBookDocument(ContentType.EPUB, assetId, java.io.File("book.epub"), "Book").entityId
        assertEquals(0.4, ReaderLocator.Epub(entityId, "epubcfi(/6/2)", 0.4).progression)
        assertEquals(0.75, ReaderLocator.Pdf(entityId, 12, 0.75).pageOffset)
    }

    @Test
    fun `locators reject invalid progress`() {
        val entityId = LocalBookDocument(ContentType.PDF, assetId, java.io.File("book.pdf"), "Book").entityId
        assertThrows(IllegalArgumentException::class.java) { ReaderLocator.Epub(entityId, null, -0.1) }
        assertThrows(IllegalArgumentException::class.java) { ReaderLocator.Pdf(entityId, -1, 0.0) }
        assertThrows(IllegalArgumentException::class.java) { ReaderLocator.Pdf(entityId, 0, 1.1) }
        assertThrows(IllegalArgumentException::class.java) {
            ReaderLocator.Pdf(entityId, 0, 0.0, characterOffset = -1)
        }
    }
}
