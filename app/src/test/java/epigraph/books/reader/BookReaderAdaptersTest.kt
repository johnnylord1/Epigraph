package epigraph.books.reader

import epigraph.books.model.BookAssetId
import epigraph.books.model.LocalBookDocument
import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import java.io.File
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BookReaderAdaptersTest {
    private val firstAsset = BookAssetId.fromSha256("a".repeat(64))
    private val secondAsset = BookAssetId.fromSha256("b".repeat(64))

    @Test
    fun `epub open request rejects a pdf document`() {
        val document = LocalBookDocument(ContentType.PDF, firstAsset, File("book.pdf"), "Book")

        assertThrows(IllegalArgumentException::class.java) {
            EpubReaderOpenRequest(document, ReaderLocator.Epub(document.entityId, null, 0.0))
        }
    }

    @Test
    fun `reader open request rejects a locator from another asset`() {
        val document = LocalBookDocument(ContentType.PDF, firstAsset, File("book.pdf"), "Book")
        val secondEntity = EpigraphIdentityRules.importedBookId(ContentType.PDF, secondAsset.value)

        assertThrows(IllegalArgumentException::class.java) {
            PdfReaderOpenRequest(document, ReaderLocator.Pdf(secondEntity, 0, 0.0))
        }
    }

    @Test
    fun `reader range cannot cross document identities`() {
        val firstEntity = EpigraphIdentityRules.importedBookId(ContentType.PDF, firstAsset.value)
        val secondEntity = EpigraphIdentityRules.importedBookId(ContentType.PDF, secondAsset.value)
        assertThrows(IllegalArgumentException::class.java) {
            ReaderRange(
                ReaderLocator.Pdf(firstEntity, 0, 0.0),
                ReaderLocator.Pdf(secondEntity, 1, 0.0),
            )
        }
    }

    @Test
    fun `epub selection locator accepts a chapter offset cfi`() {
        val entity = EpigraphIdentityRules.importedBookId(ContentType.EPUB, firstAsset.value)
        val locator = ReaderLocator.Epub(entity, "aethon-spine:3:420", 0.5)

        assertEquals("aethon-spine:3:420", locator.cfi)
        assertEquals(0.5, locator.progression)
    }
}
