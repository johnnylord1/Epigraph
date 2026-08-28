package epigraph.books.reader

import epigraph.books.model.LocalBookDocument
import epigraph.books.model.BookAssetId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class BookReaderRouterTest {
    private val epubSession = FakeSession(
        ReaderLocator.Epub(EpigraphEntityId("epub:sha256:${"a".repeat(64)}"), "epubcfi(/6/2)", 0.1),
    )
    private val pdfSession = FakeSession(
        ReaderLocator.Pdf(EpigraphEntityId("pdf:sha256:${"b".repeat(64)}"), pageIndex = 2, pageOffset = 0.4),
    )
    private val epubAdapter = RecordingEpubAdapter(epubSession)
    private val pdfAdapter = RecordingPdfAdapter(pdfSession)
    private val router = BookReaderRouter(epubAdapter, pdfAdapter)

    @Test
    fun `routes a verified epub only to the epub adapter`() = runTest {
        val document = document(ContentType.EPUB, "a")

        val opened = router.open(document, epubSession.locator)

        assertTrue(opened is OpenedBookReader.Epub)
        assertEquals(document, epubAdapter.request?.document)
        assertEquals(null, pdfAdapter.request)
        opened.close()
        assertTrue(epubSession.closed)
    }

    @Test
    fun `routes a pdf and keeps its password provider ephemeral`() = runTest {
        val document = document(ContentType.PDF, "b")
        val provider = PdfPasswordProvider { "secret".toCharArray() }

        val opened = router.open(document, pdfSession.locator, provider)

        assertTrue(opened is OpenedBookReader.Pdf)
        assertTrue(pdfAdapter.request?.passwordProvider === provider)
        assertEquals(null, epubAdapter.request)
        opened.close()
        assertTrue(pdfSession.closed)
    }

    @Test
    fun `rejects a locator belonging to the other reader before opening an engine`() = runTest {
        val failure = runCatching {
            router.open(document(ContentType.EPUB, "a"), pdfSession.locator)
        }.exceptionOrNull()

        assertTrue(failure is IllegalArgumentException)
        assertEquals("An EPUB document requires an EPUB locator", requireNotNull(failure).message)
        assertEquals(null, epubAdapter.request)
        assertEquals(null, pdfAdapter.request)
        assertFalse(epubSession.closed)
        assertFalse(pdfSession.closed)
    }

    private fun document(contentType: ContentType, hashByte: String): LocalBookDocument {
        val hash = hashByte.repeat(64)
        return LocalBookDocument(
            contentType = contentType,
            assetId = BookAssetId.fromSha256(hash),
            file = File("books", "$hash.${contentType.name.lowercase()}"),
            displayName = "Test book",
        )
    }

    private class RecordingEpubAdapter(
        private val session: BookReaderSession<ReaderLocator.Epub>,
    ) : EpubReaderAdapter {
        var request: EpubReaderOpenRequest? = null

        override suspend fun open(request: EpubReaderOpenRequest): BookReaderSession<ReaderLocator.Epub> {
            this.request = request
            return session
        }
    }

    private class RecordingPdfAdapter(
        private val session: BookReaderSession<ReaderLocator.Pdf>,
    ) : PdfReaderAdapter {
        var request: PdfReaderOpenRequest? = null

        override suspend fun open(request: PdfReaderOpenRequest): BookReaderSession<ReaderLocator.Pdf> {
            this.request = request
            return session
        }
    }

    private class FakeSession<L : ReaderLocator>(val locator: L) : BookReaderSession<L> {
        var closed = false
        override val capabilities = ReaderCapabilities(false, false, false, false, false)
        override suspend fun currentLocator(): L = locator
        override suspend fun navigateTo(locator: L) = Unit
        override suspend fun tableOfContents(): List<ReaderTocEntry<L>> = emptyList()
        override suspend fun search(query: String): List<ReaderSearchResult<L>> = emptyList()
        override suspend fun extractText(range: ReaderRange<L>): String = ""
        override suspend fun renderHighlights(highlights: List<ReaderHighlight<L>>) = Unit
        override fun close() {
            closed = true
        }
    }
}
