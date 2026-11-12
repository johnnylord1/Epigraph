package epigraph.books.reader

import epigraph.books.local.LocalBook
import epigraph.books.local.LocalBookChapterState
import epigraph.books.local.LocalBookRepository
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Chapter structure of a publication, and the rules between its one synced reading position and the
 * read flags of its chapters ([LocalBookChapterState]).
 *
 * Marking a chapter changes only that chapter, and reading an earlier chapter unmarks nothing. A
 * position this device did not save, from another device or a build before per-chapter flags, says
 * how far the book was read elsewhere: see [reconcile].
 */
internal class BookChapterProgress(private val book: LocalBook, private val structure: BookStructure?) {

    val chapterCount: Int = (structure?.chapterCount ?: book.chapterCount ?: 1).coerceAtLeast(1)

    private val anchors: List<Int> = structure?.chapterStartPages.orEmpty()
    private val knownPages: Int? = structure?.pageCount ?: book.pageCount

    fun isFinished(progress: ReaderLocator?): Boolean = when (progress) {
        is ReaderLocator.Epub -> progress.progression >= 1.0
        is ReaderLocator.Pdf -> (progress.documentProgression ?: 0.0) >= 1.0
        else -> false
    }

    /**
     * A position still on the first page is where a fresh book opens, so like an unstarted comic it
     * offers "Start reading" and marks nothing as read.
     */
    fun isAtStart(progress: ReaderLocator?): Boolean = when {
        isFinished(progress) -> false
        progress is ReaderLocator.Epub -> (progress.progression * 100).roundToInt() == 0 && chapterOf(progress) == 0
        progress is ReaderLocator.Pdf -> progress.pageIndex == 0
        else -> false
    }

    /**
     * The chapter a position falls in, resolved exactly as the reader does, so the FAB label, the
     * dimmed rows and the resume note agree with where the reader will open.
     */
    fun chapterOf(locator: ReaderLocator): Int? = when (locator) {
        is ReaderLocator.Epub -> BookChapterMetrics.epubChapterIndex(
            locator,
            chapterCount,
            structure?.chapterPaths.orEmpty(),
        )

        is ReaderLocator.Pdf -> BookChapterMetrics.chapterIndexForPage(
            locator.pageIndex,
            (knownPages ?: locator.totalPages ?: 1).coerceAtLeast(1),
            chapterCount,
            anchors,
        )

        else -> null
    }

    /** The chapter being read, or null before reading starts. */
    fun currentChapter(progress: ReaderLocator?): Int? =
        progress?.takeUnless(::isAtStart)?.let(::chapterOf)

    fun isRead(index: Int, state: LocalBookChapterState): Boolean =
        state.readOverrides[index] ?: (index < state.readThrough)

    fun unreadCount(state: LocalBookChapterState): Int = (0 until chapterCount).count { !isRead(it, state) }

    fun anyRead(state: LocalBookChapterState): Boolean = (0 until chapterCount).any { isRead(it, state) }

    /**
     * What the primary action opens, as in novels: the chapter the position is in while it is
     * unread, otherwise the first unread chapter, and nothing once every chapter is read.
     */
    fun nextChapter(state: LocalBookChapterState, progress: ReaderLocator?): Int? =
        resumableChapter(state, progress) ?: (0 until chapterCount).firstOrNull { !isRead(it, state) }

    /** The unread chapter that the saved position is partway through, or null. */
    fun resumableChapter(state: LocalBookChapterState, progress: ReaderLocator?): Int? =
        currentChapter(progress)?.takeIf { !isFinished(progress) && !isRead(it, state) }

    /**
     * Accounts for a position this device did not save. It lands in another chapter than the last
     * local one, or finishes the book, so every chapter before it was read elsewhere. Comparing
     * chapters and not the stored text keeps a sync echo of a local position from counting, and
     * explicit choices in [LocalBookChapterState.readOverrides] still win.
     */
    fun reconcile(state: LocalBookChapterState, progress: ReaderLocator?): LocalBookChapterState {
        if (progress == null) return state
        val local = state.localLocator
        if (local != null && isFinished(local) == isFinished(progress) && chapterOf(local) == chapterOf(progress)) {
            return state
        }
        val reached = if (isFinished(progress)) chapterCount else chapterOf(progress) ?: 0
        return state.copy(readThrough = max(state.readThrough, reached), localLocator = progress)
    }

    /**
     * The state of a book read as one chapter, carried over to these chapters once its outline
     * splits it. A book never marked is left for [reconcile] to derive from its position.
     */
    fun fromWholeDocument(state: LocalBookChapterState, progress: ReaderLocator?): LocalBookChapterState {
        if (!state.recorded && state.readOverrides.isEmpty() && state.bookmarks.isEmpty()) return state
        val marked = state.readOverrides[0]
        val readThrough = when {
            marked == true || (marked == null && (state.readThrough > 0 || isFinished(progress))) -> chapterCount
            marked == false -> 0
            else -> currentChapter(progress) ?: 0
        }
        return state.copy(readThrough = readThrough, localLocator = progress, readOverrides = emptyMap())
    }

    fun startOf(index: Int): ReaderLocator {
        val entityId = book.document().entityId
        return when (book.contentType) {
            // k / count stays inside chapter k, and leaves 1.0 to mean the book is finished.
            ContentType.EPUB -> ReaderLocator.Epub(entityId, progression = index.toDouble() / chapterCount)

            ContentType.PDF -> {
                val totalPages = (knownPages ?: 1).coerceAtLeast(1)
                val lastPage = totalPages - 1
                // Without an outline the page estimate can land in the chapter before this one.
                var page = BookChapterMetrics.pageIndexForChapter(index, totalPages, chapterCount, anchors)
                while (page < lastPage && BookChapterMetrics.chapterIndexForPage(page, totalPages, chapterCount, anchors) < index) {
                    page++
                }
                ReaderLocator.Pdf(
                    entityId = entityId,
                    pageIndex = page,
                    totalPages = totalPages,
                    documentProgression = if (lastPage == 0) {
                        0.0
                    } else {
                        min(page.toDouble() / lastPage, Math.nextDown(1.0))
                    },
                )
            }

            else -> error("Unsupported local chapter content")
        }
    }

    /** The position that leaves every chapter of the book read. */
    fun end(): ReaderLocator {
        val entityId = book.document().entityId
        return when (book.contentType) {
            ContentType.EPUB -> ReaderLocator.Epub(entityId, progression = 1.0)

            ContentType.PDF -> {
                val totalPages = (knownPages ?: 1).coerceAtLeast(1)
                ReaderLocator.Pdf(
                    entityId = entityId,
                    pageIndex = totalPages - 1,
                    totalPages = totalPages,
                    documentProgression = 1.0,
                )
            }

            else -> error("Unsupported local chapter content")
        }
    }

    /**
     * Where the position goes after [chapters] were marked, or null to leave it. Marking a chapter
     * unread restarts it, as in novels; a book left all read, or no longer so, moves the position
     * because that is the only part other devices see.
     */
    fun positionAfterMarking(
        chapters: Collection<Int>,
        read: Boolean,
        marked: LocalBookChapterState,
        progress: ReaderLocator?,
    ): ReaderLocator? {
        val first = chapters.minOrNull() ?: return null
        return when {
            read -> end().takeIf { !isFinished(progress) && unreadCount(marked) == 0 }
            isFinished(progress) -> startOf(first)
            else -> currentChapter(progress)?.takeIf { it in chapters }?.let(::startOf)?.takeIf { it != progress }
        }
    }
}

/**
 * Tells when reading reaches the end of a chapter. Opening a book already at a chapter's end, or
 * paging back into one, is not reaching it; a chapter that fits in one page counts as soon as it is
 * seen going forward.
 */
internal class ChapterEndTracker {
    private var lastChapter: Int? = null
    private var lastAtEnd = false

    fun reachedEnd(chapter: Int, atEnd: Boolean, singlePage: Boolean): Boolean {
        val previous = lastChapter
        val reached = when {
            !atEnd -> false
            chapter == previous -> !lastAtEnd
            else -> singlePage && (previous == null || chapter > previous)
        }
        lastChapter = chapter
        lastAtEnd = atEnd
        return reached
    }
}

/** Accounts for the stored [progress] and returns the state that the screen should show. */
internal suspend fun LocalBookRepository.reconcileChapterState(
    chapters: BookChapterProgress,
    bookId: String,
    progress: ReaderLocator?,
): LocalBookChapterState {
    val stored = getChapterState(bookId)
    val state = chapters.reconcile(stored, progress)
    if (state != stored || !stored.recorded) saveReadingState(bookId, state.readThrough, state.localLocator)
    return state.copy(recorded = true)
}
