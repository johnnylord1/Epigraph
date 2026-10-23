package epigraph.sync.core.work

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.core.app.NotificationCompat
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.notification.Notifications
import eu.kanade.tachiyomi.ui.main.MainActivity
import eu.kanade.tachiyomi.util.system.notificationBuilder
import eu.kanade.tachiyomi.util.system.notificationManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yokai.i18n.MR
import yokai.util.lang.getString

/** Why a finished run needs the user; the notice text follows from it. */
enum class CoreSyncNotice { PAIR_AGAIN, NEEDS_ATTENTION }

sealed interface CoreSyncNoticeUpdate {
    /** A transient failure: whatever the last notice said still holds. */
    data object Keep : CoreSyncNoticeUpdate
    data object Clear : CoreSyncNoticeUpdate
    data class Show(val notice: CoreSyncNotice) : CoreSyncNoticeUpdate
}

/**
 * Only states the user can act on raise a notice. Forgetting the desktop ends as NOT_PAIRED, which
 * clears it, so a deliberate unpair never leaves a "sync stopped" behind.
 */
fun coreSyncNoticeUpdate(run: CoreSyncLastRun): CoreSyncNoticeUpdate = when (run.state) {
    CoreSyncRunState.RETRY -> CoreSyncNoticeUpdate.Keep
    CoreSyncRunState.NEEDS_PAIRING ->
        if (run.reason.equals(CorePairingRequirement.NOT_PAIRED.name, ignoreCase = true)) {
            CoreSyncNoticeUpdate.Clear
        } else {
            CoreSyncNoticeUpdate.Show(CoreSyncNotice.PAIR_AGAIN)
        }
    CoreSyncRunState.NEEDS_USER_ACTION -> CoreSyncNoticeUpdate.Show(CoreSyncNotice.NEEDS_ATTENTION)
    CoreSyncRunState.OUTBOX_DRAINED,
    CoreSyncRunState.OUTBOX_DEFERRED,
    -> if (run.replica == CoreReplicaSyncOutcome.NEEDS_USER_ACTION) {
        CoreSyncNoticeUpdate.Show(CoreSyncNotice.NEEDS_ATTENTION)
    } else {
        CoreSyncNoticeUpdate.Clear
    }
}

data class CoreSyncProgress(val max: Int, val done: Int, val remaining: Long) {
    /** Nothing left to send: the run is fetching the desktop's changes, with no count to show. */
    val indeterminate: Boolean get() = remaining <= 0
}

/** [peak] is the most changes seen left in this run, so the bar only moves forward. */
fun coreSyncProgress(peak: Long, remaining: Long): CoreSyncProgress {
    val left = remaining.coerceAtLeast(0)
    val max = maxOf(peak, left).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    return CoreSyncProgress(max = max, done = (max - left.coerceAtMost(max.toLong())).toInt(), remaining = left)
}

/**
 * Notifications for desktop sync. Short runs (one change sent after a tap) finish before the
 * progress notice would appear, so only long runs such as a first sync show one. There is never a
 * "synced" notice: a finished run can still leave commands in the outbox.
 */
class CoreSyncNotifier(context: Context) {
    private val context = context.applicationContext
    private val noticePreferences = this.context.getSharedPreferences(NOTICE_PREFERENCES, Context.MODE_PRIVATE)

    suspend fun <T> withProgress(remaining: suspend () -> Long, block: suspend () -> T): T = coroutineScope {
        val ticker = launch {
            delay(PROGRESS_DELAY_MS)
            var peak = 0L
            while (isActive) {
                val left = try {
                    remaining()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    0L
                }
                val progress = coreSyncProgress(peak, left)
                peak = progress.max.toLong()
                showProgress(progress)
                delay(PROGRESS_REFRESH_MS)
            }
        }
        try {
            block()
        } finally {
            // Joined first so a refresh in flight cannot repost after the cancel below.
            withContext(NonCancellable) { ticker.cancelAndJoin() }
            context.notificationManager.cancel(Notifications.ID_CORE_SYNC_PROGRESS)
        }
    }

    fun update(run: CoreSyncLastRun) {
        when (val update = coreSyncNoticeUpdate(run)) {
            CoreSyncNoticeUpdate.Keep -> Unit
            CoreSyncNoticeUpdate.Clear -> clearAttention()
            is CoreSyncNoticeUpdate.Show -> showAttention(update.notice)
        }
    }

    fun clearAttention() {
        if (noticePreferences.getString(KEY_NOTICE, null) == null) return
        noticePreferences.edit().remove(KEY_NOTICE).apply()
        context.notificationManager.cancel(Notifications.ID_CORE_SYNC_ATTENTION)
    }

    private fun showAttention(notice: CoreSyncNotice) {
        // Posted once per problem: the periodic check must not bring back a notice the user swiped.
        if (noticePreferences.getString(KEY_NOTICE, null) == notice.name) return
        noticePreferences.edit().putString(KEY_NOTICE, notice.name).apply()
        val text = when (notice) {
            CoreSyncNotice.PAIR_AGAIN -> context.getString(MR.strings.epigraph_core_sync_notification_pair_again)
            CoreSyncNotice.NEEDS_ATTENTION -> context.getString(MR.strings.epigraph_core_sync_notification_attention)
        }
        val notification = context.notificationBuilder(Notifications.CHANNEL_CORE_SYNC) {
            setSmallIcon(R.drawable.ic_epigraph)
            setLargeIcon(BitmapFactory.decodeResource(context.resources, R.mipmap.ic_launcher))
            setContentTitle(context.getString(MR.strings.epigraph_core_sync_notification_stopped))
            setContentText(text)
            setStyle(NotificationCompat.BigTextStyle().bigText(text))
            setContentIntent(openSettings())
            setAutoCancel(true)
        }.build()
        context.notificationManager.notify(Notifications.ID_CORE_SYNC_ATTENTION, notification)
    }

    private fun showProgress(progress: CoreSyncProgress) {
        val notification = context.notificationBuilder(Notifications.CHANNEL_CORE_SYNC) {
            setSmallIcon(R.drawable.ic_epigraph)
            setContentTitle(context.getString(MR.strings.epigraph_core_sync_notification_progress))
            if (progress.indeterminate) {
                setContentText(context.getString(MR.strings.epigraph_core_sync_notification_fetching))
                setProgress(0, 0, true)
            } else {
                setContentText(
                    context.getString(MR.strings.epigraph_core_sync_notification_remaining, progress.remaining),
                )
                setProgress(progress.max, progress.done, false)
            }
            setContentIntent(openSettings())
            setOngoing(true)
            setOnlyAlertOnce(true)
            // A process death skips the cancel in withProgress; the notice then clears itself.
            setTimeoutAfter(PROGRESS_TIMEOUT_MS)
        }.build()
        context.notificationManager.notify(Notifications.ID_CORE_SYNC_PROGRESS, notification)
    }

    private fun openSettings(): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).apply {
            action = MainActivity.SHORTCUT_EPIGRAPH_CORE
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        return PendingIntent.getActivity(
            context,
            Notifications.ID_CORE_SYNC_ATTENTION,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    private companion object {
        const val PROGRESS_DELAY_MS = 3_000L
        const val PROGRESS_REFRESH_MS = 2_000L
        const val PROGRESS_TIMEOUT_MS = 10 * 60 * 1_000L
        const val NOTICE_PREFERENCES = "epigraph_core_sync_notice"
        const val KEY_NOTICE = "shown"
    }
}
