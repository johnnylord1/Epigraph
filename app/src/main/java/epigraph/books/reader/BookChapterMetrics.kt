package epigraph.books.reader

import epigraph.books.local.LocalBook
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URLDecoder
import kotlin.math.floor
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
            chapterPaths = inspected?.chapterPaths?.takeIf { it.size == chapterCount }.orEmpty(),
        )
    }

    /**
     * Zero-based chapter of a stored EPUB position.
     *
     * The persisted Readium locator names its spine resource, which is exact even when chapters
     * differ in length. Without it, `floor(progression * count)` is used: it agrees with Readium's
     * totalProgression (chapter k starts near k / count) and with the catalog's k / (count - 1)
     * anchors, whereas `progression * (count - 1)` put the start of the last chapter one early.
     */
    fun epubChapterIndex(
        locator: ReaderLocator.Epub?,
        chapterCount: Int,
        chapterPaths: List<String> = emptyList(),
    ): Int = epubChapterIndex(
        progression = locator?.progression ?: 0.0,
        chapterCount = chapterCount,
        locatorHref = epubLocatorHref(locator?.cfi),
        chapterPaths = chapterPaths,
    )

    fun epubChapterIndex(
        progression: Double,
        chapterCount: Int,
        locatorHref: String? = null,
        chapterPaths: List<String> = emptyList(),
    ): Int {
        val lastChapter = (chapterCount - 1).coerceAtLeast(0)
        val href = locatorHref?.substringBefore('#')?.trimStart('/')
        if (href != null && chapterPaths.size == chapterCount) {
            val decoded = runCatching { URLDecoder.decode(href, Charsets.UTF_8.name()) }.getOrNull()
            val byPath = chapterPaths.indexOfFirst { path ->
                val normalized = path.trimStart('/')
                normalized == href || normalized == decoded
            }
            if (byPath >= 0) return byPath
        }
        return floor(progression.coerceIn(0.0, 1.0) * chapterCount + PROGRESSION_EPSILON)
            .toInt()
            .coerceIn(0, lastChapter)
    }

    /** Spine href stored in a persisted Readium locator, or null for legacy/progress-only positions. */
    fun epubLocatorHref(cfi: String?): String? = cfi?.let { encoded ->
        runCatching {
            Json.parseToJsonElement(encoded).jsonObject["href"]?.jsonPrimitive?.contentOrNull
        }.getOrNull()
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

    /** Words for [pdfLabel]. English by default so the metrics stay locale-free; the UI passes its strings. */
    class PdfLabelText(
        val chapter: (current: Int, total: Int) -> String = { current, total -> "Chapter $current / $total" },
        val page: (current: Int, total: Int) -> String = { current, total -> "Page $current / $total" },
        val pages: (first: Int, last: Int, total: Int) -> String = { first, last, total -> "Pages $first-$last / $total" },
    )

    fun pdfLabel(
        pageIndex: Int,
        totalPages: Int,
        chapterCount: Int,
        chapterStartPages: List<Int> = emptyList(),
        pagesShown: Int = 1,
        text: PdfLabelText = PdfLabelText(),
    ): String {
        val pages = totalPages.coerceAtLeast(1)
        val chapters = chapterCount.coerceAtLeast(1)
        val chapter = chapterIndexForPage(pageIndex, pages, chapters, chapterStartPages) + 1
        val page = pageIndex.coerceIn(0, pages - 1) + 1
        val last = (page + pagesShown - 1).coerceAtMost(pages)
        val range = if (last > page) text.pages(page, last, pages) else text.page(page, pages)
        return "${text.chapter(chapter, chapters)} • $range"
    }

    // Readium reports chapter starts such as 1/3 that land just below the boundary once multiplied.
    private const val PROGRESSION_EPSILON = 1e-9

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
