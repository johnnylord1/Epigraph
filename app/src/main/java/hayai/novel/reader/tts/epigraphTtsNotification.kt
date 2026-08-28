package hayai.novel.reader.tts

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.support.v4.media.session.MediaSessionCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.notification.Notifications
import eu.kanade.tachiyomi.util.system.notificationBuilder

/**
 * Shared media notification contract for every reader that can speak text.
 *
 * Keeping the builder independent from a particular reader service prevents novels, EPUB and
 * PDF from drifting into different lock-screen controls or notification semantics.
 */
object EpigraphTtsNotification {

    fun build(
        context: Context,
        sessionToken: MediaSessionCompat.Token?,
        isPaused: Boolean,
        progressPercent: Int,
        title: String,
        subtitle: String,
        openReaderIntent: Intent,
        serviceClass: Class<out Service>,
        toggleAction: String,
        stopAction: String,
        notificationId: Int,
    ): Notification {
        val toggleIntent = PendingIntent.getService(
            context,
            notificationId * 10 + 1,
            Intent(context, serviceClass).setAction(toggleAction),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val stopIntent = PendingIntent.getService(
            context,
            notificationId * 10 + 2,
            Intent(context, serviceClass).setAction(stopAction),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val openPendingIntent = PendingIntent.getActivity(
            context,
            notificationId * 10 + 3,
            openReaderIntent.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val mediaStyle = MediaStyle().setShowActionsInCompactView(0, 1)
        if (sessionToken != null) mediaStyle.setMediaSession(sessionToken)
        val status = if (isPaused) "Paused" else "Reading in background"
        val contentText = if (subtitle.isNotBlank()) "$subtitle · $status" else status

        return context.notificationBuilder(Notifications.CHANNEL_TTS_PLAYBACK) {
            setSmallIcon(R.drawable.ic_epigraph)
            setContentTitle(title.ifBlank { "TTS playback" })
            setContentText(contentText)
            setContentIntent(openPendingIntent)
            setCategory(NotificationCompat.CATEGORY_TRANSPORT)
            setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            setOngoing(true)
            setOnlyAlertOnce(true)
            setShowWhen(false)
            setProgress(100, progressPercent.coerceIn(0, 100), false)
            addAction(
                if (isPaused) android.R.drawable.ic_media_play else android.R.drawable.ic_media_pause,
                if (isPaused) "Resume" else "Pause",
                toggleIntent,
            )
            addAction(
                android.R.drawable.ic_menu_close_clear_cancel,
                "Stop",
                stopIntent,
            )
            setStyle(mediaStyle)
        }.build()
    }
}
