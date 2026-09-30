package epigraph.sync.core

import co.touchlab.kermit.Logger
import epigraph.sync.ChapterStateChange
import epigraph.sync.EpigraphReaderProgressRouter
import kotlinx.coroutines.CancellationException
import yokai.domain.chapter.interactor.UpdateChapter
import yokai.domain.chapter.models.ChapterUpdate

/**
 * Entry point for read/bookmark edits the user makes outside the reader. The chapter row and its
 * Core chapter-state commands are written in one transaction; source refresh, restore and tracker
 * sync keep using [UpdateChapter] directly because they are not user intent.
 */
class SyncedChapterStateWriter(
    private val router: EpigraphReaderProgressRouter,
    private val updateChapter: UpdateChapter,
) {
    suspend fun await(update: ChapterUpdate) = awaitAll(listOf(update))

    suspend fun awaitAll(updates: List<ChapterUpdate>) {
        if (updates.isEmpty()) return
        try {
            router.setChapterStates(
                updates.map {
                    ChapterStateChange(
                        localChapterId = it.id,
                        read = it.read,
                        bookmarked = it.bookmark,
                        lastPageRead = it.lastPageRead,
                        pagesLeft = it.pagesLeft,
                    )
                },
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Exception) {
            // Never lose the user's edit: it stays local, exactly like a chapter without a binding.
            Logger.w(error) { "Unable to persist chapter state atomically with its sync commands" }
            updateChapter.awaitAll(updates)
        }
    }
}
