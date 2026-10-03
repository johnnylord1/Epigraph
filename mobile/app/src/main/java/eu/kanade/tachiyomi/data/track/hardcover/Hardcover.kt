package eu.kanade.tachiyomi.data.track.hardcover

import android.content.Context
import android.graphics.Color
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.database.models.Track
import eu.kanade.tachiyomi.data.track.TrackService
import eu.kanade.tachiyomi.data.track.model.TrackContentType
import eu.kanade.tachiyomi.data.track.model.TrackSearch
import eu.kanade.tachiyomi.data.track.updateNewTrackInfo
import java.text.DecimalFormat
import kotlin.math.roundToInt
import kotlinx.collections.immutable.ImmutableList
import kotlinx.collections.immutable.toImmutableList
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * Hardcover tracker backed by the official GraphQL API.
 *
 * Hardcover is a page-oriented novel tracker. Epigraph's novel tracker surface is chapter
 * oriented, so status and rating are synchronized directly and chapter progress is translated
 * to a page position only when both sides expose a reliable total. Local EPUB/PDF entries use
 * the Books library and are intentionally not forced through this tracker contract.
 */
class Hardcover(private val context: Context, id: Long) : TrackService(id) {

    companion object {
        const val WANT_TO_READ = 1
        const val READING = 2
        const val COMPLETED = 3
        const val ON_HOLD = 4
        const val DID_NOT_FINISH = 5
        const val IGNORED = 6

        private const val DEFAULT_SCORE = 0f

        internal fun progressAsPages(lastChapter: Float, totalChapters: Long, pages: Long?): Int? {
            if (lastChapter <= 0f || totalChapters <= 0L || pages == null || pages <= 0L) return null
            return (pages * (lastChapter / totalChapters.toFloat()))
                .roundToInt()
                .coerceIn(1, pages.coerceAtMost(Int.MAX_VALUE.toLong()).toInt())
        }

        internal fun chapterFromPages(progressPages: Int?, totalChapters: Long, pages: Long?): Float? {
            if (progressPages == null || progressPages <= 0 || totalChapters <= 0L || pages == null || pages <= 0L) {
                return null
            }
            return (totalChapters * (progressPages.toFloat() / pages.toFloat()))
                .coerceIn(0f, totalChapters.toFloat())
        }
    }

    private val api by lazy { HardcoverApi(this, client) }

    override val supportedContentTypes: Set<TrackContentType> =
        setOf(TrackContentType.NOVEL)

    override fun nameRes() = MR.strings.hardcover

    override fun getLogo() = R.drawable.ic_tracker_hardcover

    override fun getTrackerColor() = Color.rgb(118, 86, 186)

    override fun getLogoColor() = Color.rgb(118, 86, 186)

    override fun getStatusList(): List<Int> = listOf(
        READING,
        WANT_TO_READ,
        COMPLETED,
        ON_HOLD,
        DID_NOT_FINISH,
        IGNORED,
    )

    override fun isCompletedStatus(index: Int) = getStatusList()[index] == COMPLETED

    override fun completedStatus() = COMPLETED
    override fun readingStatus() = READING
    override fun planningStatus() = WANT_TO_READ

    override fun getStatus(status: Int): String = with(context) {
        when (status) {
            READING -> getString(MR.strings.currently_reading)
            WANT_TO_READ -> getString(MR.strings.want_to_read)
            COMPLETED -> getString(MR.strings.completed)
            ON_HOLD -> getString(MR.strings.on_hold)
            DID_NOT_FINISH -> getString(MR.strings.dropped)
            IGNORED -> getString(MR.strings.ignore)
            else -> ""
        }
    }

    override fun getGlobalStatus(status: Int): String = with(context) {
        when (status) {
            READING -> getString(MR.strings.reading)
            WANT_TO_READ -> getString(MR.strings.plan_to_read)
            COMPLETED -> getString(MR.strings.completed)
            ON_HOLD -> getString(MR.strings.on_hold)
            DID_NOT_FINISH -> getString(MR.strings.dropped)
            IGNORED -> getString(MR.strings.ignore)
            else -> ""
        }
    }

    private val scoreList = (0..10).map { it / 2f }.map { score ->
        if (score == 0f) "0" else DecimalFormat("0.#").format(score)
    }.toImmutableList()

    override fun getScoreList(): ImmutableList<String> = scoreList

    override fun indexToScore(index: Int): Float = (index.coerceIn(0, 10) / 2f)

    override fun displayScore(track: Track): String =
        if (track.score <= 0f) "-" else DecimalFormat("0.#").format(track.score)

    override suspend fun add(track: Track): Track {
        track.score = DEFAULT_SCORE
        track.status = WANT_TO_READ
        updateNewTrackInfo(track)

        val bookId = bookId(track)
            ?: throw IllegalArgumentException("Hardcover tracking URL does not contain a book id")
        val remote = api.findUserBook(bookId) ?: api.addUserBook(bookId, track.status, track.score)
        applyRemote(track, remote)
        maybeUpdateProgress(track, remote)
        return track
    }

    override suspend fun update(track: Track, setToRead: Boolean): Track {
        updateTrackStatus(track, setToRead, setToComplete = true, mustReadToComplete = false)
        val remote = api.getUserBook(track.media_id)
            ?: bookId(track)?.let { api.findUserBook(it) }
            ?: throw IllegalStateException("Hardcover user book is no longer available")
        if (track.media_id != remote.id) track.media_id = remote.id
        api.updateUserBook(remote.id, track.status, track.score)
        maybeUpdateProgress(track, remote)
        return track
    }

    override suspend fun bind(track: Track): Track {
        val bookId = bookId(track)
            ?: throw IllegalArgumentException("Hardcover tracking URL does not contain a book id")
        val remote = api.findUserBook(bookId)
        return if (remote != null) {
            track.media_id = remote.id
            applyRemote(track, remote)
            track
        } else {
            add(track)
        }
    }

    override suspend fun search(query: String): List<TrackSearch> = api.search(query)

    suspend fun recommendationUserBooks(): List<HardcoverLibraryBook> = api.userBooks()

    suspend fun recommendationSearchBooks(
        query: String,
        limit: Int,
        fields: String? = null,
        weights: String? = null,
        sort: String? = null,
    ): List<HardcoverBookResult> = api.searchBooks(query, limit, fields, weights, sort)

    override suspend fun refresh(track: Track): Track {
        val remote = api.getUserBook(track.media_id)
            ?: bookId(track)?.let { api.findUserBook(it) }
            ?: return track
        track.media_id = remote.id
        applyRemote(track, remote)
        // A page-to-chapter conversion is only applied when the local track has a known chapter
        // total. Otherwise preserving the local locator is safer than inventing a chapter.
        chapterFromPages(remote.progressPages, track.total_chapters, remote.pages)?.let {
            track.last_chapter_read = it
        }
        return track
    }

    override fun canRemoveFromService() = true

    override suspend fun removeFromService(track: Track): Boolean =
        api.deleteUserBook(track.media_id)

    override suspend fun login(username: String, password: String): Boolean {
        if (password.isBlank()) return false
        val user = api.currentUser(password)
        saveCredentials(username.ifBlank { user.username.ifBlank { "Hardcover" } }, password)
        return true
    }

    private fun bookId(track: Track): Long? =
        HardcoverApi.bookIdFromUrl(track.tracking_url) ?: track.media_id.takeIf { it > 0L }

    private fun applyRemote(track: Track, remote: HardcoverUserBook) {
        track.status = remote.statusId
        track.score = remote.rating
    }

    private suspend fun maybeUpdateProgress(track: Track, remote: HardcoverUserBook) {
        progressAsPages(track.last_chapter_read, track.total_chapters, remote.pages)?.let {
            api.updateProgress(remote.id, it)
        }
    }
}
