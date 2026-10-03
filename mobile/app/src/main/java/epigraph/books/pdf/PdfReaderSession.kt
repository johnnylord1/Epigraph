package epigraph.books.pdf

import epigraph.books.reader.BookReaderSession
import epigraph.contract.ReaderLocator

/** Canonical PDF session contract used by the BookReaderRouter/PdfReaderAdapter path. */
interface PdfReaderSession : BookReaderSession<ReaderLocator.Pdf> {
    val pageCount: Int
}

/** Fixed-message engine signals; password values are never carried in exceptions. */
class PdfPasswordRequiredException : Exception("PDF password required")

class PdfInvalidPasswordException : Exception("Invalid PDF password")
