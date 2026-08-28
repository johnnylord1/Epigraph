package epigraph.books.reader

import epigraph.books.model.LocalBookDocument
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator

data class ReaderCapabilities(
    val tableOfContents: Boolean,
    val textSearch: Boolean,
    val textSelection: Boolean,
    val highlights: Boolean,
    val textToSpeech: Boolean,
    val passwordProtectedDocuments: Boolean = false,
)

sealed interface BookReaderOpenRequest<L : ReaderLocator> {
    val document: LocalBookDocument
    val initialLocator: L?
}

data class EpubReaderOpenRequest(
    override val document: LocalBookDocument,
    override val initialLocator: ReaderLocator.Epub?,
) : BookReaderOpenRequest<ReaderLocator.Epub> {
    init {
        require(document.contentType == ContentType.EPUB) { "The EPUB reader only accepts EPUB documents" }
        require(initialLocator == null || initialLocator.entityId == document.entityId) {
            "The EPUB locator must belong to the opened document"
        }
    }
}

data class PdfReaderOpenRequest(
    override val document: LocalBookDocument,
    override val initialLocator: ReaderLocator.Pdf?,
    val passwordProvider: PdfPasswordProvider? = null,
) : BookReaderOpenRequest<ReaderLocator.Pdf> {
    init {
        require(document.contentType == ContentType.PDF) { "The PDF reader only accepts PDF documents" }
        require(initialLocator == null || initialLocator.entityId == document.entityId) {
            "The PDF locator must belong to the opened document"
        }
    }
}

/** Supplies an ephemeral password attempt. Implementations must never persist or log the value. */
fun interface PdfPasswordProvider {
    suspend fun requestPassword(attempt: Int): CharArray?
}

class ReaderRange<L : ReaderLocator>(start: L, end: L) {
    val start: L = start
    val end: L = end

    init {
        require(start.entityId == end.entityId) { "A reader range cannot span two documents" }
    }
}

class ReaderHighlight<L : ReaderLocator>(id: String, range: ReaderRange<L>, colorArgb: Long) {
    val id: String = id
    val range: ReaderRange<L> = range
    val colorArgb: Long = colorArgb

    init {
        require(id.isNotBlank()) { "A highlight ID cannot be blank" }
        require(colorArgb in 0..0xffffffffL) { "Highlight color must be an unsigned ARGB value" }
    }
}

class ReaderSelection<L : ReaderLocator>(range: ReaderRange<L>, text: String) {
    val range: ReaderRange<L> = range
    val text: String = text
}

class ReaderSearchResult<L : ReaderLocator>(locator: L, excerpt: String) {
    val locator: L = locator
    val excerpt: String = excerpt
}

class ReaderTocEntry<L : ReaderLocator>(
    title: String,
    locator: L,
    children: List<ReaderTocEntry<L>> = emptyList(),
) {
    val title: String = title
    val locator: L = locator
    val children: List<ReaderTocEntry<L>> = children
}

interface BookReaderSession<L : ReaderLocator> : AutoCloseable {
    val capabilities: ReaderCapabilities

    suspend fun currentLocator(): L

    suspend fun navigateTo(locator: L)

    suspend fun tableOfContents(): List<ReaderTocEntry<L>>

    suspend fun search(query: String): List<ReaderSearchResult<L>>

    suspend fun extractText(range: ReaderRange<L>): String

    suspend fun renderHighlights(highlights: List<ReaderHighlight<L>>)

    override fun close()
}

interface EpubReaderAdapter {
    suspend fun open(request: EpubReaderOpenRequest): BookReaderSession<ReaderLocator.Epub>
}

interface PdfReaderAdapter {
    suspend fun open(request: PdfReaderOpenRequest): BookReaderSession<ReaderLocator.Pdf>
}
