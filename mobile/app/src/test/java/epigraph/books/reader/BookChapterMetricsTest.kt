package epigraph.books.reader

import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookPdfSection
import epigraph.contract.ContentType
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ReaderLocator
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class BookChapterMetricsTest {

    @Test
    fun `persisted PDF toc count wins over one-document inspector fallback`() {
        assertEquals(
            87,
            BookChapterMetrics.effectiveChapterCount(ContentType.PDF, persisted = 87, inspected = 1),
        )
    }

    @Test
    fun `PDF chapter and page anchors are stable and bounded`() {
        assertEquals(0, BookChapterMetrics.pageIndexForChapter(0, 5_614, 87))
        assertEquals(86, BookChapterMetrics.chapterIndexForPage(5_613, 5_614, 87))
        assertEquals("Chapter 3 / 87 • Page 192 / 5614", BookChapterMetrics.pdfLabel(191, 5_614, 87))
    }

    @Test
    fun `confirmed PDF outline anchors win over synthetic distribution`() {
        val anchors = listOf(0, 1, 7, 17, 92, 147, 179, 210)

        assertEquals(6, BookChapterMetrics.chapterIndexForPage(192, 5_614, 8, anchors))
        assertEquals(179, BookChapterMetrics.pageIndexForChapter(6, 5_614, 8, anchors))
        assertEquals(
            "Chapter 7 / 8 • Page 193 / 5614",
            BookChapterMetrics.pdfLabel(192, 5_614, 8, anchors),
        )
    }

    @Test
    fun `single chapter PDFs keep the simple chapter model`() {
        assertEquals("Chapter 1 / 1 • Page 1 / 1", BookChapterMetrics.pdfLabel(0, 1, 1))
    }

    @Test
    fun `chapters without a known title are left for the screen to name`() {
        val inspected = BookStructure(chapterCount = 1, pageCount = 8)

        assertEquals(emptyList<String>(), BookChapterMetrics.resolve(book(ContentType.PDF, 1), inspected).chapterTitles)
        assertEquals(emptyList<String>(), BookChapterMetrics.resolve(book(ContentType.EPUB, 3), null).chapterTitles)
    }

    @Test
    fun `known titles stay when they match the chapters`() {
        val inspected = BookStructure(chapterCount = 2, chapterTitles = listOf("One", "Two"))

        assertEquals(listOf("One", "Two"), BookChapterMetrics.resolve(book(ContentType.EPUB, 2), inspected).chapterTitles)
    }

    @Test
    fun `two-page spreads label both pages and a lone last page stays singular`() {
        assertEquals("Chapter 1 / 1 • Pages 1-2 / 3", BookChapterMetrics.pdfLabel(0, 3, 1, pagesShown = 2))
        assertEquals("Chapter 1 / 1 • Page 3 / 3", BookChapterMetrics.pdfLabel(2, 3, 1, pagesShown = 2))
    }
    @Test
    fun `EPUB chapter uses the stored Readium href even for uneven chapters`() {
        val paths = listOf("OEBPS/ch1.xhtml", "OEBPS/ch 2.xhtml", "OEBPS/ch3.xhtml")
        val cfi = "{\"href\":\"OEBPS/ch%202.xhtml#p4\",\"type\":\"application/xhtml+xml\"," +
            "\"locations\":{\"progression\":0.1,\"totalProgression\":0.9}}"

        assertEquals("OEBPS/ch%202.xhtml#p4", BookChapterMetrics.epubLocatorHref(cfi))
        assertEquals(1, BookChapterMetrics.epubChapterIndex(0.9, 3, "OEBPS/ch%202.xhtml#p4", paths))
    }

    @Test
    fun `EPUB chapter from progression matches Readium and catalog anchors`() {
        // Readium totalProgression at the start of each of three equal chapters.
        assertEquals(0, BookChapterMetrics.epubChapterIndex(0.0, 3))
        assertEquals(1, BookChapterMetrics.epubChapterIndex(1.0 / 3.0, 3))
        assertEquals(2, BookChapterMetrics.epubChapterIndex(0.6666666666666666, 3))
        // Catalog anchors k / (n - 1) and the end of the book.
        assertEquals(1, BookChapterMetrics.epubChapterIndex(0.5, 3))
        assertEquals(2, BookChapterMetrics.epubChapterIndex(1.0, 3))
        (2..12).forEach { count ->
            (0 until count).forEach { chapter ->
                assertEquals(chapter, BookChapterMetrics.epubChapterIndex(chapter / (count - 1.0), count))
            }
        }
    }

    @Test
    fun `EPUB chapter falls back to progression for legacy or unknown hrefs`() {
        val locator = ReaderLocator.Epub(
            EpigraphEntityId("epub:sha256:" + "a".repeat(64)),
            cfi = "aethon-spine:2:0",
            progression = 0.7,
        )
        assertEquals(null, BookChapterMetrics.epubLocatorHref(locator.cfi))
        assertEquals(2, BookChapterMetrics.epubChapterIndex(locator, 3, listOf("a", "b", "c")))
        assertEquals(0, BookChapterMetrics.epubChapterIndex(0.2, 3, "missing.xhtml", listOf("a", "b", "c")))
    }

    @Test
    fun `unread badge counts the current chapter and none once the book is finished`() {
        val epub = book(ContentType.EPUB, chapterCount = 5)
        val epubId = EpigraphEntityId("epub:sha256:" + "a".repeat(64))
        assertEquals(5, BookChapterMetrics.unreadChapterCount(epub, null))
        assertEquals(5, BookChapterMetrics.unreadChapterCount(epub, ReaderLocator.Epub(epubId, progression = 0.0)))
        assertEquals(3, BookChapterMetrics.unreadChapterCount(epub, ReaderLocator.Epub(epubId, progression = 0.45)))
        assertEquals(1, BookChapterMetrics.unreadChapterCount(epub, ReaderLocator.Epub(epubId, progression = 0.9)))
        assertEquals(0, BookChapterMetrics.unreadChapterCount(epub, ReaderLocator.Epub(epubId, progression = 1.0)))

        val pdf = book(
            ContentType.PDF,
            chapterCount = 3,
            pageCount = 10,
            sections = listOf(LocalBookPdfSection("A", 0), LocalBookPdfSection("B", 4), LocalBookPdfSection("C", 8)),
        )
        val pdfId = EpigraphEntityId("pdf:sha256:" + "a".repeat(64))
        assertEquals(3, BookChapterMetrics.unreadChapterCount(pdf, ReaderLocator.Pdf(pdfId, pageIndex = 0)))
        assertEquals(2, BookChapterMetrics.unreadChapterCount(pdf, ReaderLocator.Pdf(pdfId, pageIndex = 5)))
        assertEquals(
            0,
            BookChapterMetrics.unreadChapterCount(pdf, ReaderLocator.Pdf(pdfId, pageIndex = 9, documentProgression = 1.0)),
        )
        // A book the reader has not inspected yet still has one chapter to read.
        assertEquals(1, BookChapterMetrics.unreadChapterCount(book(ContentType.EPUB, chapterCount = null), null))
    }

    @Test
    fun `a section finishes with the ones it shares a first page with`() {
        val starts = listOf(0, 3, 3, 3, 6)

        assertEquals(listOf(1, 2, 3), BookChapterMetrics.chaptersFinishedWith(3, 9, 5, starts))
        assertEquals(listOf(4), BookChapterMetrics.chaptersFinishedWith(4, 9, 5, starts))
        assertEquals(listOf(0), BookChapterMetrics.chaptersFinishedWith(0, 9, 5, starts))
    }

    @Test
    fun `without valid sections only the chapter itself finishes`() {
        assertEquals(listOf(2), BookChapterMetrics.chaptersFinishedWith(2, 9, 3))
        assertEquals(listOf(2), BookChapterMetrics.chaptersFinishedWith(2, 9, 3, listOf(0, 0, 20)))
    }

    private fun book(
        type: ContentType,
        chapterCount: Int?,
        pageCount: Int? = null,
        sections: List<LocalBookPdfSection> = emptyList(),
    ) = LocalBook(
        bookId = "book-${"a".repeat(64)}",
        contentType = type,
        sha256 = "a".repeat(64),
        displayName = "Book",
        author = null,
        description = null,
        coverPath = null,
        coverAssetSha256 = null,
        coverAssetByteSize = null,
        coverAssetMimeType = null,
        privatePath = "book",
        mimeType = if (type == ContentType.PDF) "application/pdf" else "application/epub+zip",
        byteSize = 1,
        chapterCount = chapterCount,
        pageCount = pageCount,
        importedAt = 1,
        updatedAt = 1,
        pdfSections = sections,
    )
}
