package epigraph.books.reader

import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookChapterState
import epigraph.contract.ContentType
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ReaderLocator
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BookChapterProgressTest {
    private val epubId = EpigraphEntityId("epub:sha256:" + "a".repeat(64))

    private fun epub(chapters: Int) = BookChapterProgress(book(ContentType.EPUB, chapters), structure = null)

    private fun pdf(chapters: Int, pages: Int, anchors: List<Int> = emptyList()) = BookChapterProgress(
        book(ContentType.PDF, chapters, pages),
        BookStructure(chapterCount = chapters, pageCount = pages, chapterStartPages = anchors),
    )

    private fun epubAt(progression: Double) = ReaderLocator.Epub(epubId, progression = progression)

    @Test
    fun `no position and the first page read nothing`() {
        val progress = epub(chapters = 4)
        assertEquals(null, progress.currentChapter(null))
        assertTrue(progress.isAtStart(epubAt(0.0)))
        assertEquals(null, progress.currentChapter(epubAt(0.0)))
        assertEquals(4, progress.unreadCount(progress.reconcile(LocalBookChapterState(), epubAt(0.0))))
    }

    @Test
    fun `chapter starts of a long book do not round to the start of the book`() {
        val progress = epub(chapters = 300)
        val second = progress.startOf(1)
        assertFalse(progress.isAtStart(second))
        assertEquals(1, progress.currentChapter(second))
    }

    @Test
    fun `every epub chapter start resolves to its own chapter and only the end finishes the book`() {
        val progress = epub(chapters = 7)
        for (index in 0 until 7) {
            val start = progress.startOf(index)
            assertEquals(index, progress.chapterOf(start))
            assertFalse(progress.isFinished(start))
        }
        assertTrue(progress.isFinished(progress.end()))
    }

    @Test
    fun `every pdf chapter start resolves to its own chapter without an outline`() {
        val progress = pdf(chapters = 4, pages = 9)
        for (index in 0 until 4) {
            val start = progress.startOf(index) as ReaderLocator.Pdf
            assertEquals(index, progress.chapterOf(start))
            assertFalse(progress.isFinished(start))
            assertEquals(9, start.totalPages)
        }
    }

    @Test
    fun `pdf chapter starts follow the outline`() {
        val progress = pdf(chapters = 3, pages = 20, anchors = listOf(0, 3, 19))
        assertEquals(3, (progress.startOf(1) as ReaderLocator.Pdf).pageIndex)
        val last = progress.startOf(2) as ReaderLocator.Pdf
        assertEquals(19, last.pageIndex)
        // On the last page, but opened by its chapter row: nothing says the book was finished.
        assertFalse(progress.isFinished(last))
        assertEquals(2, progress.currentChapter(last))
    }

    @Test
    fun `the end of a pdf is its last page`() {
        val end = pdf(chapters = 3, pages = 20).end() as ReaderLocator.Pdf
        assertEquals(19, end.pageIndex)
        assertEquals(1.0, end.documentProgression)
    }

    @Test
    fun `a chapter flag changes only that chapter`() {
        val progress = epub(chapters = 10)
        val state = LocalBookChapterState(readOverrides = mapOf(4 to true))
        assertEquals(listOf(4), (0 until 10).filter { progress.isRead(it, state) })

        val mixed = LocalBookChapterState(readThrough = 6, readOverrides = mapOf(2 to false, 8 to true))
        assertEquals(listOf(0, 1, 3, 4, 5, 8), (0 until 10).filter { progress.isRead(it, mixed) })
        assertEquals(4, progress.unreadCount(mixed))
    }

    @Test
    fun `a position from elsewhere counts every chapter before it as read`() {
        val progress = epub(chapters = 10)
        val state = progress.reconcile(LocalBookChapterState(), progress.startOf(5))
        assertEquals(5, state.readThrough)
        assertEquals(progress.startOf(5), state.localLocator)
        assertTrue(progress.isRead(4, state))
        assertFalse(progress.isRead(5, state))
    }

    @Test
    fun `a position that finishes the book reads every chapter`() {
        val progress = epub(chapters = 10)
        val local = LocalBookChapterState(readThrough = 3, localLocator = progress.startOf(3))
        assertEquals(0, progress.unreadCount(progress.reconcile(local, progress.end())))
    }

    @Test
    fun `the echo of a local position changes nothing`() {
        val progress = epub(chapters = 10)
        val local = LocalBookChapterState(readThrough = 2, localLocator = progress.startOf(5))
        assertEquals(local, progress.reconcile(local, epubAt(0.57)))
        assertEquals(local, progress.reconcile(local, null))
    }

    @Test
    fun `an explicit choice wins over a position from elsewhere`() {
        val progress = epub(chapters = 10)
        val chosen = LocalBookChapterState(readOverrides = mapOf(2 to false), localLocator = progress.startOf(0))
        assertFalse(progress.isRead(2, progress.reconcile(chosen, progress.startOf(5))))
    }

    @Test
    fun `going back to an earlier chapter unmarks nothing`() {
        val progress = epub(chapters = 10)
        val state = LocalBookChapterState(readThrough = 7, localLocator = progress.startOf(7))
        val moved = progress.reconcile(state, progress.startOf(2))
        assertEquals(7, moved.readThrough)
        assertTrue(progress.isRead(2, moved))
    }

    @Test
    fun `the primary action resumes the unread chapter of the position`() {
        val progress = epub(chapters = 10)
        val state = LocalBookChapterState(readOverrides = mapOf(0 to true, 1 to true))
        assertEquals(3, progress.nextChapter(state, epubAt(0.35)))
        assertEquals(3, progress.resumableChapter(state, epubAt(0.35)))
    }

    @Test
    fun `the primary action moves to the first unread chapter past a read one`() {
        val progress = epub(chapters = 10)
        val state = LocalBookChapterState(readOverrides = mapOf(0 to true, 1 to true, 3 to true))
        assertEquals(2, progress.nextChapter(state, epubAt(0.35)))
        assertNull(progress.resumableChapter(state, epubAt(0.35)))
        assertEquals(2, progress.nextChapter(state, null))
    }

    @Test
    fun `the primary action has nothing to open once every chapter is read`() {
        val progress = epub(chapters = 3)
        assertNull(progress.nextChapter(LocalBookChapterState(readThrough = 3), progress.end()))
    }

    @Test
    fun `marking read leaves the position until the whole book is read`() {
        val progress = epub(chapters = 3)
        val partly = LocalBookChapterState(readOverrides = mapOf(2 to true))
        assertNull(progress.positionAfterMarking(listOf(2), true, partly, progress.startOf(1)))

        val whole = LocalBookChapterState(readThrough = 3)
        assertTrue(progress.isFinished(progress.positionAfterMarking(listOf(2), true, whole, progress.startOf(1))))
        assertNull(progress.positionAfterMarking(listOf(2), true, whole, progress.end()))
    }

    @Test
    fun `marking unread after the end reopens the book at that chapter`() {
        val progress = epub(chapters = 10)
        val marked = LocalBookChapterState(readThrough = 10, readOverrides = mapOf(3 to false))
        assertEquals(
            progress.startOf(3),
            progress.positionAfterMarking(listOf(6, 3), false, marked, progress.end()),
        )
    }

    @Test
    fun `marking the chapter being read as unread restarts only that chapter`() {
        val progress = epub(chapters = 10)
        val marked = LocalBookChapterState(readOverrides = mapOf(3 to false))
        assertEquals(progress.startOf(3), progress.positionAfterMarking(listOf(3), false, marked, epubAt(0.35)))
        assertNull(progress.positionAfterMarking(listOf(3), false, marked, progress.startOf(3)))
        assertNull(progress.positionAfterMarking(listOf(7), false, marked, epubAt(0.35)))
        assertNull(progress.positionAfterMarking(emptyList(), false, marked, epubAt(0.35)))
    }

    @Test
    fun `a one page pdf can be finished and restarted`() {
        val progress = pdf(chapters = 1, pages = 1)
        val read = progress.positionAfterMarking(
            listOf(0),
            true,
            LocalBookChapterState(readOverrides = mapOf(0 to true)),
            null,
        ) as ReaderLocator.Pdf
        assertEquals(0, read.pageIndex)
        assertTrue(progress.isFinished(read))

        val unread = progress.positionAfterMarking(
            listOf(0),
            false,
            LocalBookChapterState(readOverrides = mapOf(0 to false)),
            read,
        )
        assertTrue(progress.isAtStart(unread))
    }

    @Test
    fun `opening a chapter already at its end is not reaching it`() {
        val tracker = ChapterEndTracker()
        assertFalse(tracker.reachedEnd(2, atEnd = true, singlePage = false))
        assertFalse(tracker.reachedEnd(2, atEnd = true, singlePage = false))
    }

    @Test
    fun `moving to the end of a chapter reaches it once`() {
        val tracker = ChapterEndTracker()
        assertFalse(tracker.reachedEnd(2, atEnd = false, singlePage = false))
        assertTrue(tracker.reachedEnd(2, atEnd = true, singlePage = false))
        assertFalse(tracker.reachedEnd(2, atEnd = true, singlePage = false))
        assertFalse(tracker.reachedEnd(2, atEnd = false, singlePage = false))
        assertTrue(tracker.reachedEnd(2, atEnd = true, singlePage = false))
    }

    @Test
    fun `a chapter of one page counts only going forward`() {
        val tracker = ChapterEndTracker()
        assertTrue(tracker.reachedEnd(1, atEnd = true, singlePage = true))
        assertTrue(tracker.reachedEnd(2, atEnd = true, singlePage = true))
        assertFalse(tracker.reachedEnd(1, atEnd = true, singlePage = true))
    }

    @Test
    fun `paging back into the last page of a chapter is not reaching it`() {
        val tracker = ChapterEndTracker()
        assertFalse(tracker.reachedEnd(3, atEnd = false, singlePage = false))
        assertFalse(tracker.reachedEnd(2, atEnd = true, singlePage = false))
    }

    @Test
    fun `the library badge agrees with marked chapters of a long book`() {
        val book = book(ContentType.EPUB, chapterCount = 300)
        val progress = BookChapterProgress(book, structure = null)
        assertEquals(299, BookChapterMetrics.unreadChapterCount(book, progress.startOf(1)))
        assertEquals(0, BookChapterMetrics.unreadChapterCount(book, progress.end()))
        assertEquals(300, BookChapterMetrics.unreadChapterCount(book, progress.startOf(0)))
    }

    @Test
    fun `the library badge counts chapter flags`() {
        val book = book(ContentType.EPUB, chapterCount = 10)
        val progress = BookChapterProgress(book, structure = null)
        val state = LocalBookChapterState(
            readOverrides = mapOf(4 to true, 8 to true),
            localLocator = progress.startOf(0),
        )
        assertEquals(8, BookChapterMetrics.unreadChapterCount(book, progress.startOf(0), state))
    }

    @Test
    fun `chapter share comes from the reader locator and not from the whole book`() {
        val stored = """{"href":"ch3.xhtml","locations":{"progression":0.25,"totalProgression":0.45}}"""
        assertEquals(0.25, BookChapterMetrics.epubChapterProgression(stored))
        assertNull(BookChapterMetrics.epubChapterProgression(null))
        assertNull(BookChapterMetrics.epubChapterProgression("aethon-spine:2"))
    }

    private val pdfId = EpigraphEntityId("pdf:sha256:" + "a".repeat(64))

    private fun pdfAt(page: Int, documentProgression: Double = 0.5) =
        ReaderLocator.Pdf(pdfId, pageIndex = page, documentProgression = documentProgression)

    private val outlined = pdf(chapters = 3, pages = 9, anchors = listOf(0, 3, 6))

    @Test
    fun `a book never marked is left to its position`() {
        val state = LocalBookChapterState()
        assertEquals(state, outlined.fromWholeDocument(state, pdfAt(4)))
    }

    @Test
    fun `a whole document marked read stays read in every section`() {
        val converted = outlined.fromWholeDocument(
            LocalBookChapterState(readOverrides = mapOf(0 to true), recorded = true),
            pdfAt(1),
        )

        assertEquals(3, converted.readThrough)
        assertTrue(converted.readOverrides.isEmpty())
        (0..2).forEach { assertTrue(outlined.isRead(it, converted)) }
    }

    @Test
    fun `a whole document marked unread stays unread even when finished`() {
        val finished = pdfAt(8, documentProgression = 1.0)
        val converted = outlined.fromWholeDocument(
            LocalBookChapterState(readThrough = 1, readOverrides = mapOf(0 to false), recorded = true),
            finished,
        )

        assertEquals(0, converted.readThrough)
        assertEquals(converted, outlined.reconcile(converted, finished))
        (0..2).forEach { assertFalse(outlined.isRead(it, converted)) }
    }

    @Test
    fun `a finished document reads every section`() {
        val byPosition = outlined.fromWholeDocument(
            LocalBookChapterState(recorded = true),
            pdfAt(8, documentProgression = 1.0),
        )
        val byState = outlined.fromWholeDocument(LocalBookChapterState(readThrough = 1, recorded = true), pdfAt(2))

        assertEquals(3, byPosition.readThrough)
        assertEquals(3, byState.readThrough)
    }

    @Test
    fun `a document in progress reads the sections before its position`() {
        val position = pdfAt(4)
        val converted = outlined.fromWholeDocument(LocalBookChapterState(recorded = true), position)

        assertEquals(1, converted.readThrough)
        assertEquals(position, converted.localLocator)
        assertEquals(converted, outlined.reconcile(converted, position))
    }

    @Test
    fun `a chapter bookmark stays on the first section`() {
        val converted = outlined.fromWholeDocument(LocalBookChapterState(bookmarks = setOf(0)), null)

        assertEquals(setOf(0), converted.bookmarks)
        assertEquals(0, converted.readThrough)
    }

    private fun book(type: ContentType, chapterCount: Int?, pageCount: Int? = null) = LocalBook(
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
    )
}
