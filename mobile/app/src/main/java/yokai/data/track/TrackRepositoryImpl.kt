package yokai.data.track

import epigraph.sync.EpigraphMutationOrigin
import epigraph.sync.EpigraphTrackingMutationRouter
import epigraph.sync.TrackingRow
import eu.kanade.tachiyomi.data.database.models.Track
import yokai.data.DatabaseHandler
import yokai.domain.track.TrackRepository

class TrackRepositoryImpl(
    private val handler: DatabaseHandler,
    /** Publishes tracker bindings to Epigraph Core in the same transaction as the local write. */
    private val syncRouter: EpigraphTrackingMutationRouter? = null,
) : TrackRepository {
    override suspend fun getAllByMangaId(mangaId: Long): List<Track> =
        handler.awaitList { manga_syncQueries.getAllByMangaId(mangaId, Track::mapper) }

    // Single query for every track row, grouped client-side — replaces the per-manga N+1
    // the library build pass otherwise issues for filtering/grouping by tracking state.
    override suspend fun getAllGroupedByMangaId(): Map<Long, List<Track>> =
        handler.awaitList { manga_syncQueries.getAll(Track::mapper) }.groupBy { it.manga_id }

    override suspend fun deleteForManga(mangaId: Long, syncId: Long) {
        val router = syncRouter
        if (router != null) {
            router.delete(mangaId, syncId, EpigraphMutationOrigin.LOCAL_USER, System.currentTimeMillis())
            return
        }
        handler.await { manga_syncQueries.deleteForManga(mangaId, syncId) }
    }

    override suspend fun insert(track: Track) {
        val router = syncRouter
        if (router != null) {
            router.upsert(listOf(track.toTrackingRow()), EpigraphMutationOrigin.LOCAL_USER, System.currentTimeMillis())
            return
        }
        handler.await {
            manga_syncQueries.insert(
                mangaId = track.manga_id,
                syncId = track.sync_id,
                remoteId = track.media_id,
                libraryId = track.library_id,
                title = track.title,
                lastChapterRead = track.last_chapter_read.toDouble(),
                totalChapters = track.total_chapters,
                status = track.status.toLong(),
                score = track.score.toDouble(),
                remoteUrl = track.tracking_url,
                startDate = track.started_reading_date,
                finishDate = track.finished_reading_date,
            )
        }
    }

    override suspend fun insertBulk(tracks: List<Track>) {
        val router = syncRouter
        if (router != null) {
            router.upsert(tracks.map { it.toTrackingRow() }, EpigraphMutationOrigin.LOCAL_IMPORT, System.currentTimeMillis())
            return
        }
        handler.await(inTransaction = true) {
            tracks.forEach { track ->
                manga_syncQueries.insert(
                    mangaId = track.manga_id,
                    syncId = track.sync_id,
                    remoteId = track.media_id,
                    libraryId = track.library_id,
                    title = track.title,
                    lastChapterRead = track.last_chapter_read.toDouble(),
                    totalChapters = track.total_chapters,
                    status = track.status.toLong(),
                    score = track.score.toDouble(),
                    remoteUrl = track.tracking_url,
                    startDate = track.started_reading_date,
                    finishDate = track.finished_reading_date,
                )
            }
        }
    }
}

private fun Track.toTrackingRow() = TrackingRow(
    mangaId = manga_id,
    syncId = sync_id,
    remoteId = media_id,
    libraryId = library_id,
    title = title,
    lastChapterRead = last_chapter_read.toDouble(),
    totalChapters = total_chapters,
    status = status.toLong(),
    score = score.toDouble(),
    remoteUrl = tracking_url,
    startDate = started_reading_date,
    finishDate = finished_reading_date,
)
