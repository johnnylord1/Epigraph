package epigraph.books.pdf

import android.content.Context
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import epigraph.books.model.LocalBookDocument
import epigraph.books.reader.BookReaderSession
import epigraph.books.reader.PdfReaderOpenRequest
import epigraph.books.reader.ReaderCapabilities
import epigraph.books.reader.ReaderHighlight
import epigraph.books.reader.ReaderRange
import epigraph.books.reader.ReaderSearchResult
import epigraph.books.reader.ReaderTocEntry
import epigraph.contract.ReaderLocator
import epigraph.contract.withDocumentMetrics
import com.ahmer.pdfium.PdfDocument
import com.ahmer.pdfium.PdfPasswordException
import com.ahmer.pdfium.PdfTextPage
import com.ahmer.pdfium.PdfiumCore
import kotlinx.coroutines.CancellationException

/** Opens verified private PDF blobs through AhmerPdfium. */
class PdfiumPdfReaderAdapter(
    private val context: Context,
    private val maximumPasswordAttempts: Int = 5,
) : epigraph.books.reader.PdfReaderAdapter {
    override suspend fun open(request: PdfReaderOpenRequest): BookReaderSession<ReaderLocator.Pdf> {
        var attempt = 0
        var password: CharArray? = null
        while (true) {
            try {
                val session = openWithPassword(request.document, password, request.initialLocator)
                password?.fill('\u0000')
                return session
            } catch (cancelled: CancellationException) {
                password?.fill('\u0000')
                throw cancelled
            } catch (failure: PdfPasswordException) {
                password?.fill('\u0000')
                password = null
                if (request.passwordProvider == null) throw PdfPasswordRequiredException()
                if (attempt >= maximumPasswordAttempts) throw PdfInvalidPasswordException()
                password = request.passwordProvider.requestPassword(++attempt)
                    ?: throw PdfPasswordRequiredException()
            } catch (failure: Exception) {
                password?.fill('\u0000')
                throw failure
            }
        }
    }

    private fun openWithPassword(
        document: LocalBookDocument,
        password: CharArray?,
        initialLocator: ReaderLocator.Pdf?,
    ): PdfReaderSession {
        require(document.file.isFile && document.file.canRead()) { "The PDF file is unavailable" }
        val core = PdfiumCore(context)
        val descriptor = try {
            ParcelFileDescriptor.open(document.file, ParcelFileDescriptor.MODE_READ_ONLY)
        } catch (failure: Exception) {
            core.close()
            throw failure
        }
        return try {
            val opened = core.newDocument(descriptor, password?.concatToString().orEmpty())
            PdfiumReaderSession(document, core, opened, initialLocator)
        } catch (failure: Throwable) {
            descriptor.close()
            core.close()
            throw failure
        } finally {
            password?.fill('\u0000')
        }
    }
}

private class PdfiumReaderSession(
    private val document: LocalBookDocument,
    private val core: PdfiumCore,
    private val pdf: PdfDocument,
    initialLocator: ReaderLocator.Pdf?,
) : PdfReaderSession, PdfPageBitmapRenderer {
    private var closed = false
    private var locator = ReaderLocator.Pdf(
        entityId = document.entityId,
        pageIndex = (initialLocator?.pageIndex ?: 0).coerceIn(0, (pdf.totalPages - 1).coerceAtLeast(0)),
        pageOffset = initialLocator?.pageOffset ?: 0.0,
        characterOffset = initialLocator?.characterOffset,
    ).withDocumentMetrics(pdf.totalPages.coerceAtLeast(1))
    private var highlights: List<ReaderHighlight<ReaderLocator.Pdf>> = emptyList()

    override val pageCount: Int get() = pdf.totalPages

    override suspend fun renderPageBitmap(pageIndex: Int, maxDimension: Int): Bitmap? {
        ensureOpen()
        require(pageIndex in 0 until pageCount) { "The PDF page is outside the document" }
        var bitmap: Bitmap? = null
        return runCatching {
            // AhmerPdfium's width/height calls dereference the native page cache. Materialize the
            // page first so spread rendering cannot ask Pdfium for dimensions through a null page
            // pointer (which otherwise terminates the process with SIGSEGV).
            pdf.openPage(pageIndex)
            val width = core.getPageWidthPixel(pageIndex).coerceAtLeast(1)
            val height = core.getPageHeightPixel(pageIndex).coerceAtLeast(1)
            val scale = minOf(1.0, maxDimension.toDouble() / maxOf(width, height).toDouble())
            val targetWidth = (width * scale).toInt().coerceAtLeast(1)
            val targetHeight = (height * scale).toInt().coerceAtLeast(1)
            bitmap = Bitmap.createBitmap(targetWidth, targetHeight, Bitmap.Config.ARGB_8888)
            core.renderPageBitmap(
                pageIndex,
                bitmap!!,
                0,
                0,
                targetWidth,
                targetHeight,
                true,
            )
            bitmap!!
        }.getOrElse {
            bitmap?.recycle()
            null
        }
    }

    override val capabilities = ReaderCapabilities(
        tableOfContents = true,
        textSearch = true,
        textSelection = true,
        highlights = true,
        textToSpeech = true,
        passwordProtectedDocuments = true,
    )

    override suspend fun currentLocator(): ReaderLocator.Pdf {
        ensureOpen()
        return locator
    }

    override suspend fun navigateTo(locator: ReaderLocator.Pdf) {
        ensureOpen()
        validate(locator)
        this.locator = locator.withDocumentMetrics(pageCount)
    }

    override suspend fun tableOfContents(): List<ReaderTocEntry<ReaderLocator.Pdf>> {
        ensureOpen()
        fun convert(bookmark: PdfDocument.Bookmark): ReaderTocEntry<ReaderLocator.Pdf> =
            ReaderTocEntry(
                title = bookmark.title?.ifBlank { "Page ${bookmark.pageIndex + 1}" }
                    ?: "Page ${bookmark.pageIndex + 1}",
                locator = ReaderLocator.Pdf(document.entityId, bookmark.pageIndex.toInt())
                    .withDocumentMetrics(pageCount),
                children = bookmark.children.orEmpty().map(::convert),
            )
        return pdf.bookmarks.orEmpty().map(::convert)
    }

    override suspend fun search(query: String): List<ReaderSearchResult<ReaderLocator.Pdf>> {
        ensureOpen()
        val normalized = query.trim()
        if (normalized.isEmpty()) return emptyList()
        return buildList {
            for (page in 0 until pageCount) {
                val text = readPageText(page) ?: continue
                if (text.contains(normalized, ignoreCase = true)) {
                    add(
                        ReaderSearchResult(
                            locator = ReaderLocator.Pdf(document.entityId, page)
                                .withDocumentMetrics(pageCount),
                            excerpt = text.excerptAround(normalized),
                        ),
                    )
                }
            }
        }
    }

    override suspend fun extractText(range: ReaderRange<ReaderLocator.Pdf>): String {
        ensureOpen()
        validate(range.start)
        validate(range.end)
        return buildString {
            for (page in range.start.pageIndex..range.end.pageIndex) {
                readPageText(page)?.let { text ->
                    if (isNotEmpty()) append('\n')
                    append(text)
                }
            }
        }
    }

    override suspend fun renderHighlights(highlights: List<ReaderHighlight<ReaderLocator.Pdf>>) {
        ensureOpen()
        this.highlights = highlights.map { highlight ->
            validate(highlight.range.start)
            validate(highlight.range.end)
            highlight
        }
    }

    override fun close() {
        if (closed) return
        closed = true
        // PdfiumCore owns the document wrapper and closes cached native pages before
        // closing the document itself. Calling PdfDocument.close() first leaves those
        // page handles alive against a freed document and can terminate the process
        // with SIGSEGV during Activity.onDestroy(). The core also closes the descriptor
        // retained by PdfDocument, so it must be the sole native teardown path.
        runCatching { core.close() }
    }

    private fun readPageText(page: Int): String? {
        // AhmerPdfium's openTextPage(page) passes the cached native page pointer
        // to FPDFText_LoadPage. Calling it before openPage(page) leaves that
        // pointer at zero and aborts the native process for PDFs without a
        // previously rendered page. Materialize the page first and fail closed
        // if Pdfium cannot provide a native page handle.
        val pagePointer = pdf.pageCache[page]?.pagePtr
            ?: runCatching { pdf.openPage(page) }.getOrNull()
        if (pagePointer == null || pagePointer == 0L) return null
        val textPage: PdfTextPage = try {
            pdf.openTextPage(page)
        } catch (_: Throwable) {
            return null
        }
        return try {
            if (textPage.charCount <= 0) null else textPage.getText(0, textPage.charCount)
        } finally {
            textPage.close()
        }
    }

    private fun validate(value: ReaderLocator.Pdf) {
        require(value.entityId == document.entityId) { "The PDF locator belongs to another document" }
        require(value.pageIndex in 0 until pageCount) { "The PDF page is outside the document" }
    }

    private fun ensureOpen() {
        check(!closed) { "The PDF reader is closed" }
    }

    private fun String.excerptAround(query: String): String {
        val index = indexOf(query, ignoreCase = true).coerceAtLeast(0)
        val start = (index - 120).coerceAtLeast(0)
        val end = (index + query.length + 120).coerceAtMost(length)
        return substring(start, end).replace(Regex("\\s+"), " ").trim()
    }
}
