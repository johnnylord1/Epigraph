package epigraph.novel.reader.tts

import android.app.Notification
import android.content.Context
import android.support.v4.media.session.MediaSessionCompat
import eu.kanade.tachiyomi.data.notification.Notifications
import eu.kanade.tachiyomi.ui.reader.ReaderActivity
import epigraph.novel.reader.service.NovelTtsPlaybackService

/**
 * Builds the foreground TTS playback notification using [MediaStyle], bound to the
 * controller's [MediaSessionCompat]. The MediaStyle tie-in is what makes the lockscreen
 * controls and Bluetooth media-button events route to the same session — so a single
 * tap on a Bluetooth headset's play/pause hits the controller's command channel directly.
 *
 * Action buttons (Pause/Resume + Stop) still fire intents at the service so the user
 * can drive playback even when the lockscreen / MediaController isn't visible.
 */
object NovelTtsNotification {

    fun build(
        context: Context,
        sessionToken: MediaSessionCompat.Token?,
        isPaused: Boolean,
        progressPercent: Int,
        novelTitle: String,
        chapterTitle: String,
        mangaId: Long,
        chapterId: Long,
    ): Notification {
        val openReaderIntent = ReaderActivity.newIntent(
            context = context,
            mangaId = mangaId.takeIf { it > 0L },
            chapterId = chapterId.takeIf { it > 0L },
        )
        return EpigraphTtsNotification.build(
            context = context,
            sessionToken = sessionToken,
            isPaused = isPaused,
            progressPercent = progressPercent,
            title = novelTitle,
            subtitle = chapterTitle,
            openReaderIntent = openReaderIntent,
            serviceClass = NovelTtsPlaybackService::class.java,
            toggleAction = NovelTtsPlaybackService.ACTION_TOGGLE_PAUSE,
            stopAction = NovelTtsPlaybackService.ACTION_STOP_PLAYBACK,
            notificationId = Notifications.ID_TTS_PLAYBACK,
        )
    }
}
