package eu.kanade.tachiyomi.data.backup.restore.restorers

import android.content.Context
import eu.kanade.tachiyomi.data.backup.models.BackupHistory
import eu.kanade.tachiyomi.data.database.models.Chapter
import eu.kanade.tachiyomi.data.database.models.ChapterImpl
import eu.kanade.tachiyomi.data.database.models.History
import eu.kanade.tachiyomi.data.database.models.HistoryImpl
import eu.kanade.tachiyomi.data.database.models.MangaImpl
import eu.kanade.tachiyomi.data.library.CustomMangaManager
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import io.mockk.coEvery
import io.mockk.coVerify
import io.mockk.mockk
import io.mockk.slot
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import yokai.data.DatabaseHandler
import yokai.domain.category.interactor.GetCategories
import yokai.domain.category.interactor.SetMangaCategories
import yokai.domain.chapter.interactor.GetChapter
import yokai.domain.chapter.interactor.InsertChapter
import yokai.domain.chapter.interactor.UpdateChapter
import yokai.domain.history.interactor.GetHistory
import yokai.domain.history.interactor.UpsertHistory
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.domain.manga.interactor.UpdateManga
import yokai.domain.series.SeriesKnowledgeRepository
import yokai.domain.track.interactor.GetTrack
import yokai.domain.track.interactor.InsertTrack

class MangaBackupRestorerHistoryTest {

    @Test
    fun `restoring the same history twice writes reading time only once`() = runTest {
        val manga = manga(id = 10L)
        val chapter = chapter(id = 20L, mangaId = manga.id!!, url = "/chapter/1")
        val getChapter = mockk<GetChapter>()
        val getHistory = mockk<GetHistory>()
        val upsertHistory = mockk<UpsertHistory>(relaxed = true)
        val writes = mutableListOf<List<History>>()

        coEvery { getChapter.awaitAll(manga.id!!, false) } returns listOf(chapter)
        coEvery { getHistory.awaitAllByMangaId(manga.id!!) } returnsMany listOf(
            listOf(history(chapter.id!!, lastRead = 1_000L, timeRead = 120L)),
            listOf(history(chapter.id!!, lastRead = 2_000L, timeRead = 180L)),
        )
        coEvery { upsertHistory.awaitBulk(capture(writes)) } returns Unit

        val restorer = restorer(getChapter, getHistory, upsertHistory)
        val backup = listOf(BackupHistory(chapter.url, lastRead = 2_000L, readDuration = 180L))

        restorer.restoreHistoryForManga(manga, backup)
        restorer.restoreHistoryForManga(manga, backup)

        assertEquals(60L, writes[0].single().time_read)
        assertEquals(2_000L, writes[0].single().last_read)
        assertEquals(0L, writes[1].single().time_read)
        assertEquals(2_000L, writes[1].single().last_read)
    }

    @Test
    fun `duplicate backup entries merge by maximum and stay scoped to manga`() = runTest {
        val manga = manga(id = 10L)
        val targetChapter = chapter(id = 20L, mangaId = manga.id!!, url = "/shared/chapter")
        val getChapter = mockk<GetChapter>()
        val getHistory = mockk<GetHistory>()
        val upsertHistory = mockk<UpsertHistory>(relaxed = true)
        val write = slot<List<History>>()

        coEvery { getChapter.awaitAll(manga.id!!, false) } returns listOf(targetChapter)
        coEvery { getHistory.awaitAllByMangaId(manga.id!!) } returns listOf(
            history(targetChapter.id!!, lastRead = 1_000L, timeRead = 100L),
        )
        coEvery { upsertHistory.awaitBulk(capture(write)) } returns Unit

        restorer(getChapter, getHistory, upsertHistory).restoreHistoryForManga(
            manga,
            listOf(
                BackupHistory(targetChapter.url, lastRead = 1_500L, readDuration = 130L),
                BackupHistory(targetChapter.url, lastRead = 2_000L, readDuration = 180L),
                BackupHistory("/missing", lastRead = 9_000L, readDuration = 900L),
            ),
        )

        assertEquals(1, write.captured.size)
        assertEquals(targetChapter.id, write.captured.single().chapter_id)
        assertEquals(2_000L, write.captured.single().last_read)
        assertEquals(80L, write.captured.single().time_read)
        coVerify(exactly = 1) { getChapter.awaitAll(manga.id!!, false) }
    }

    private fun restorer(
        getChapter: GetChapter,
        getHistory: GetHistory,
        upsertHistory: UpsertHistory,
    ) = MangaBackupRestorer(
        context = mockk<Context>(relaxed = true),
        customMangaManager = mockk<CustomMangaManager>(relaxed = true),
        getCategories = mockk<GetCategories>(relaxed = true),
        setMangaCategories = mockk<SetMangaCategories>(relaxed = true),
        getChapter = getChapter,
        insertChapter = mockk<InsertChapter>(relaxed = true),
        updateChapter = mockk<UpdateChapter>(relaxed = true),
        getManga = mockk<GetManga>(relaxed = true),
        insertManga = mockk<InsertManga>(relaxed = true),
        updateManga = mockk<UpdateManga>(relaxed = true),
        preferences = mockk<PreferencesHelper>(relaxed = true),
        getHistory = getHistory,
        upsertHistory = upsertHistory,
        getTrack = mockk<GetTrack>(relaxed = true),
        insertTrack = mockk<InsertTrack>(relaxed = true),
        seriesKnowledgeRepository = mockk<SeriesKnowledgeRepository>(relaxed = true),
        handler = mockk<DatabaseHandler>(relaxed = true),
    )

    private fun manga(id: Long) = MangaImpl(id = id, source = 1L, url = "/series")

    private fun chapter(id: Long, mangaId: Long, url: String): Chapter = ChapterImpl().apply {
        this.id = id
        manga_id = mangaId
        this.url = url
        name = "Chapter"
    }

    private fun history(chapterId: Long, lastRead: Long, timeRead: Long): History = HistoryImpl().apply {
        chapter_id = chapterId
        last_read = lastRead
        time_read = timeRead
    }
}
