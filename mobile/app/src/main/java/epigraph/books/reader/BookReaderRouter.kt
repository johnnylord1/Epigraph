package epigraph.books.reader

import epigraph.books.model.LocalBookDocument
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator

sealed interface OpenedBookReader : AutoCloseable {
    val document: LocalBookDocument

    data class Epub(
        override val document: LocalBookDocument,
        val session: BookReaderSession<ReaderLocator.Epub>,
    ) : OpenedBookReader {
        override fun close() = session.close()
    }

    data class Pdf(
        override val document: LocalBookDocument,
        val session: BookReaderSession<ReaderLocator.Pdf>,
    ) : OpenedBookReader {
        override fun close() = session.close()
    }
}

/**
 * Central type-safe entry point for local publications.
 *
 * The UI must route through this class instead of guessing an engine from a filename. Content type
 * has already been established by the verified import manifest, and locator types are checked again
 * before an adapter sees the request.
 */
class BookReaderRouter(
    private val epubAdapter: EpubReaderAdapter,
    private val pdfAdapter: PdfReaderAdapter,
) {
    suspend fun open(
        document: LocalBookDocument,
        initialLocator: ReaderLocator? = null,
        pdfPasswordProvider: PdfPasswordProvider? = null,
    ): OpenedBookReader = when (document.contentType) {
        ContentType.EPUB -> {
            require(initialLocator == null || initialLocator is ReaderLocator.Epub) {
                "An EPUB document requires an EPUB locator"
            }
            require(pdfPasswordProvider == null) { "An EPUB document cannot receive a PDF password provider" }
            val request = EpubReaderOpenRequest(document, initialLocator)
            OpenedBookReader.Epub(document, epubAdapter.open(request))
        }

        ContentType.PDF -> {
            require(initialLocator == null || initialLocator is ReaderLocator.Pdf) {
                "A PDF document requires a PDF locator"
            }
            val request = PdfReaderOpenRequest(
                document = document,
                initialLocator = initialLocator,
                passwordProvider = pdfPasswordProvider,
            )
            OpenedBookReader.Pdf(document, pdfAdapter.open(request))
        }

        ContentType.MANGA,
        ContentType.NOVEL,
        -> error("Manga and novel content must use their dedicated readers")
    }
}
