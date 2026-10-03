package eu.kanade.tachiyomi.data.backup.models

import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.data.backup.BackupSecretPolicy
import eu.kanade.tachiyomi.data.database.models.TrackImpl
import eu.kanade.tachiyomi.data.track.TrackManager
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.protobuf.ProtoBuf
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/**
 * Tracker bindings are user data and must survive a backup round trip for both comics and novels,
 * while the credentials that authorize them (tokens, passwords) must never be representable in it.
 */
@OptIn(ExperimentalSerializationApi::class)
class BackupTrackingRoundTripTest {

    @Test
    fun `manga and novel trackers survive a protobuf round trip`() {
        val comicTrack = track(TrackManager.ANILIST, mediaId = 21L, libraryId = 0L, title = "One Piece")
        val kitsuTrack = track(TrackManager.KITSU, mediaId = 12L, libraryId = 987654L, title = "Berserk")
        val novelTrack = track(TrackManager.NOVEL_UPDATES, mediaId = 4242L, libraryId = 7L, title = "Shadow Slave")
        val hardcoverTrack = track(TrackManager.HARDCOVER, mediaId = 99L, libraryId = 555L, title = "Mother of Learning")
        val backup = Backup(
            backupManga = listOf(
                BackupManga(
                    source = 1L,
                    url = "/manga/one-piece",
                    title = "One Piece",
                    tracking = listOf(comicTrack, kitsuTrack).map(BackupTracking::copyFrom),
                ),
                BackupManga(
                    source = 2L,
                    url = "/novel/shadow-slave",
                    title = "Shadow Slave",
                    tracking = listOf(novelTrack, hardcoverTrack).map(BackupTracking::copyFrom),
                ),
            ),
        )

        val bytes = ProtoBuf.encodeToByteArray(Backup.serializer(), backup)
        val restored = ProtoBuf.decodeFromByteArray(Backup.serializer(), bytes)

        assertEquals(backup.backupManga.map { it.tracking }, restored.backupManga.map { it.tracking })
        val restoredTracks = restored.backupManga.flatMap { it.tracking }.map(BackupTracking::getTrackingImpl)
        listOf(comicTrack, kitsuTrack, novelTrack, hardcoverTrack).zip(restoredTracks).forEach { (expected, actual) ->
            assertEquals(expected.sync_id, actual.sync_id)
            assertEquals(expected.media_id, actual.media_id)
            assertEquals(expected.library_id, actual.library_id)
            assertEquals(expected.title, actual.title)
            assertEquals(expected.tracking_url, actual.tracking_url)
            assertEquals(expected.last_chapter_read, actual.last_chapter_read)
            assertEquals(expected.total_chapters, actual.total_chapters)
            assertEquals(expected.score, actual.score)
            assertEquals(expected.status, actual.status)
            assertEquals(expected.started_reading_date, actual.started_reading_date)
            assertEquals(expected.finished_reading_date, actual.finished_reading_date)
        }
    }

    @Test
    fun `tracking backup has no field that can carry credentials`() {
        val descriptor = BackupTracking.serializer().descriptor
        val names = (0 until descriptor.elementsCount).map(descriptor::getElementName)
        names.forEach { assertFalse(BackupSecretPolicy.isSecret(it), it) }
        assertFalse(names.any { it.contains("token", ignoreCase = true) || it.contains("password", ignoreCase = true) })

        val encoded = ProtoBuf.encodeToByteArray(
            BackupTracking.serializer(),
            BackupTracking.copyFrom(track(TrackManager.MYANIMELIST, mediaId = 1L, libraryId = 0L, title = "Monster")),
        )
        val text = encoded.toString(Charsets.ISO_8859_1)
        listOf("Bearer", "access_token", "refresh_token").forEach { assertFalse(text.contains(it), it) }
    }

    @Test
    fun `tracker credential preference keys are excluded from preference backup`() {
        listOf(
            TrackManager.MYANIMELIST,
            TrackManager.ANILIST,
            TrackManager.KITSU,
            TrackManager.NOVEL_UPDATES,
            TrackManager.NOVEL_LIST,
            TrackManager.HARDCOVER,
        ).forEach { id ->
            assertTrue(BackupSecretPolicy.isSecret(Preference.privateKey("track_token_$id")))
            assertTrue(BackupSecretPolicy.isSecret(Preference.privateKey("pref_mangasync_password_$id")))
            assertTrue(BackupSecretPolicy.isSecret(Preference.privateKey("pref_mangasync_username_$id")))
        }
    }

    private fun track(syncId: Long, mediaId: Long, libraryId: Long, title: String) = TrackImpl().apply {
        sync_id = syncId
        media_id = mediaId
        library_id = libraryId
        this.title = title
        tracking_url = "https://tracker.example/$syncId/$mediaId"
        last_chapter_read = 12.5f
        total_chapters = 100L
        score = 8f
        status = 1
        started_reading_date = 1_700_000_000_000L
        finished_reading_date = 0L
    }
}
