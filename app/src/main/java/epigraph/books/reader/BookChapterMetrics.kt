package epigraph.books.reader

import epigraph.books.local.LocalBook
import epigraph.contract.ContentType
import kotlin.math.roundToInt

/** Keeps Library, details and reader chapter labels on the same persisted model. */
internal object BookChapterMetrics {

    fun resolve(book: LocalBook, inspected: BookStructure?): BookStructure {
        val chapterCount = effectiveChapterCount(
            contentType = book.contentType,
            persisted = book.chapterCount,
            inspected = inspected?.chapterCount,
        )
        val confirmedSections = book.pdfSections
            .takeIf { book.contentType == ContentType.PDF && it.size == chapterCount }
        val titles = confirmedSections?.map { it.title }
            ?: inspected?.chapterTitles.orEmpty()
            .takeIf { it.size == chapterCount }
            ?: List(chapterCount) { index -> "Chapter ${index + 1}" }
        return BookStructure(
            chapterCount = chapterCount,
            pageCount = inspected?.pageCount ?: book.pageCount,
            chapterTitles = titles,
            chapterStartPages = confirmedSections?.map { it.pageIndex }.orEmpty(),
        )
    }

    /** A synchronized PDF TOC is richer than PdfRenderer's one-document fallback. */
    fun effectiveChapterCount(
        contentType: ContentType,
        persisted: Int?,
        inspected: Int?,
    ): Int = when (contentType) {
        ContentType.PDF -> maxOf(persisted ?: 0, inspected ?: 0, 1)
        else -> (inspected ?: persisted ?: 1).coerceAtLeast(1)
    }

    fun chapterIndexForPage(
        pageIndex: Int,
        totalPages: Int,
        chapterCount: Int,
        chapterStartPages: List<Int> = emptyList(),
    ): Int {
        val lastChapter = (chapterCount - 1).coerceAtLeast(0)
        val lastPage = (totalPages - 1).coerceAtLeast(0)
        if (lastChapter == 0 || lastPage == 0) return 0
        validAnchors(chapterStartPages, chapterCount, totalPages)?.let { anchors ->
            return anchors.indexOfLast { it <= pageIndex.coerceIn(0, lastPage) }
                .coerceAtLeast(0)
        }
        return ((pageIndex.coerceIn(0, lastPage).toDouble() / lastPage) * lastChapter)
            .toInt()
            .coerceIn(0, lastChapter)
    }

    fun pageIndexForChapter(
        chapterIndex: Int,
        totalPages: Int,
        chapterCount: Int,
        chapterStartPages: List<Int> = emptyList(),
    ): Int {
        val lastChapter = (chapterCount - 1).coerceAtLeast(0)
        val lastPage = (totalPages - 1).coerceAtLeast(0)
        if (lastChapter == 0 || lastPage == 0) return 0
        validAnchors(chapterStartPages, chapterCount, totalPages)?.let { anchors ->
            return anchors[chapterIndex.coerceIn(0, lastChapter)]
        }
        return ((chapterIndex.coerceIn(0, lastChapter).toDouble() / lastChapter) * lastPage)
            .roundToInt()
            .coerceIn(0, lastPage)
    }

    fun pdfLabel(
        pageIndex: Int,
        totalPages: Int,
        chapterCount: Int,
        chapterStartPages: List<Int> = emptyList(),
    ): String {
        val pages = totalPages.coerceAtLeast(1)
        val chapters = chapterCount.coerceAtLeast(1)
        val chapter = chapterIndexForPage(pageIndex, pages, chapters, chapterStartPages) + 1
        val page = pageIndex.coerceIn(0, pages - 1) + 1
        return "Chapter $chapter / $chapters • Page $page / $pages"
    }

    private fun validAnchors(
        anchors: List<Int>,
        chapterCount: Int,
        totalPages: Int,
    ): List<Int>? = anchors.takeIf {
        it.size == chapterCount &&
            it.all { page -> page in 0 until totalPages.coerceAtLeast(1) } &&
            it.zipWithNext().all { (first, second) -> first <= second }
    }
}
