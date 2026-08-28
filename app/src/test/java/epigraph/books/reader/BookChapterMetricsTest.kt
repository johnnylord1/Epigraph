package epigraph.books.reader

import epigraph.contract.ContentType
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
}
