package epigraph.sync.core.work

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.workDataOf
import dev.icerock.moko.resources.StringResource
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

/** What a run is doing, in the order a pass runs them. */
enum class CoreSyncPhase {
    /** Recording local favorites the outbox does not carry yet. */
    LIBRARY,

    /** Sending the outbox and reading the desktop's catalog and library. */
    EXCHANGE,

    /** Sending the reading progress the desktop lacks. */
    READING_PROGRESS,
}

/**
 * Progress of a running sync, published as WorkInfo progress so a screen can follow the run
 * without owning it. [userVisible] says the run shows its own notification.
 */
data class CoreSyncRunProgress(
    val phase: CoreSyncPhase,
    val percent: Int,
    val remaining: Long,
    val userVisible: Boolean,
    /** Seconds the changes left should take at the pace of the last minute; null until known. */
    val etaSeconds: Long? = null,
)

/**
 * Overall percent of a pass: each phase owns an equal share and the outbox count fills it where one
 * is known. Never below [floor] (a later pass or new changes must not move the bar back) and never
 * 100 while the run is still going.
 */
fun coreSyncRunPercent(phase: CoreSyncPhase, outbox: CoreSyncProgress, floor: Int): Int {
    val phases = CoreSyncPhase.entries.size
    val start = phase.ordinal * 100 / phases
    val span = (phase.ordinal + 1) * 100 / phases - start
    val within = if (outbox.indeterminate || outbox.max <= 0) 0 else (span.toLong() * outbox.done / outbox.max).toInt()
    return maxOf(floor, start + within).coerceIn(0, MAX_RUNNING_PERCENT)
}

private const val MAX_RUNNING_PERCENT = 99

/**
 * How long the changes left should take, from how fast they went over the last [windowMs]. Null
 * until the run has gone on for [minSpanMs] with changes leaving: a guess from a few seconds
 * swings too much to show. A new phase, or new changes queued mid-run, starts the estimate over.
 */
class CoreSyncEta(
    private val windowMs: Long = 60_000,
    private val minSpanMs: Long = 15_000,
) {
    private val samples = ArrayDeque<Pair<Long, Long>>()
    private var phase: CoreSyncPhase? = null

    fun sample(nowMs: Long, phase: CoreSyncPhase, remaining: Long): Long? {
        val last = samples.lastOrNull()
        if (phase != this.phase || remaining <= 0 || (last != null && remaining > last.second)) {
            samples.clear()
            this.phase = phase
        }
        if (remaining <= 0) return null
        samples.addLast(nowMs to remaining)
        while (samples.size > 2 && nowMs - samples[1].first >= windowMs) samples.removeFirst()
        val (firstMs, firstLeft) = samples.first()
        val spanMs = nowMs - firstMs
        val sent = firstLeft - remaining
        if (spanMs < minSpanMs || sent <= 0) return null
        return (remaining * spanMs / sent + 999) / 1_000
    }
}

/** The ETA line for [seconds]: under a minute, minutes rounded up, or hours past 90 minutes. */
fun coreSyncEtaText(seconds: Long): Pair<StringResource, Long> = when {
    seconds < 60 -> MR.strings.epigraph_core_sync_notification_eta_soon to 0
    seconds < 90 * 60 -> MR.strings.epigraph_core_sync_notification_eta_minutes to (seconds + 59) / 60
    else -> MR.strings.epigraph_core_sync_notification_eta_hours to (seconds + 1_799) / 3_600
}
private const val PROGRESS_KEY_PHASE = "progress_phase"
private const val PROGRESS_KEY_PERCENT = "progress_percent"
private const val PROGRESS_KEY_REMAINING = "progress_remaining"
private const val PROGRESS_KEY_USER_VISIBLE = "progress_user_visible"

fun CoreSyncRunProgress.toWorkData(): Data = workDataOf(
    PROGRESS_KEY_PHASE to phase.name.lowercase(),
    PROGRESS_KEY_PERCENT to percent,
    PROGRESS_KEY_REMAINING to remaining,
    PROGRESS_KEY_USER_VISIBLE to userVisible,
)

/** Null for progress written by something else. */
fun Data.toCoreSyncRunProgress(): CoreSyncRunProgress? {
    val phase = getString(PROGRESS_KEY_PHASE)
        ?.let { stored -> CoreSyncPhase.entries.firstOrNull { it.name.equals(stored, ignoreCase = true) } }
        ?: return null
    return CoreSyncRunProgress(
        phase = phase,
        percent = getInt(PROGRESS_KEY_PERCENT, 0).coerceIn(0, 100),
        remaining = getLong(PROGRESS_KEY_REMAINING, 0).coerceAtLeast(0),
        userVisible = getBoolean(PROGRESS_KEY_USER_VISIBLE, false),
    )
}

/** How a sync the user started ended, for its last notification. */
sealed interface CoreSyncResult {
    /** Drained, with nothing left in the outbox. */
    data object Synced : CoreSyncResult

    /** Nothing queued, but no drained run confirmed it. */
    data object Finished : CoreSyncResult
    data class Pending(val remaining: Long) : CoreSyncResult
    data class Blocked(val blocked: Long) : CoreSyncResult
    data object WillRetry : CoreSyncResult

    /** The desktop is still applying what it received, or its library is busy; nothing failed here. */
    data object DesktopBusy : CoreSyncResult
}

/**
 * [status] must be resolved with no run active, so "synced" keeps the rule the status card follows:
 * never while the outbox holds commands. States that need the user (pairing, a desktop problem)
 * return null: the attention notice covers them.
 */
fun coreSyncResult(status: CoreSyncStatus): CoreSyncResult? = when (status) {
    is CoreSyncStatus.Synced -> CoreSyncResult.Synced
    CoreSyncStatus.Idle -> CoreSyncResult.Finished
    is CoreSyncStatus.Pending -> CoreSyncResult.Pending(status.counts.unsettled)
    is CoreSyncStatus.Blocked -> CoreSyncResult.Blocked(status.counts.blocked)
    is CoreSyncStatus.Retrying ->
        if (status.reason in DESKTOP_BUSY_REASONS) CoreSyncResult.DesktopBusy else CoreSyncResult.WillRetry
    else -> null
}

/** Retries that wait on the desktop's own work, not on a failure the phone ran into. */
private val DESKTOP_BUSY_REASONS = setOf("outbox_pending", "suwayomi")

/**
 * The line that says what a run is doing. Every text takes the remaining count as its only
 * argument, so callers format them the same way; a count, where there is one, wins over the phase.
 */
fun coreSyncPhaseText(progress: CoreSyncRunProgress): StringResource = when {
    progress.remaining > 0 -> MR.strings.epigraph_core_sync_notification_remaining
    progress.phase == CoreSyncPhase.LIBRARY -> MR.strings.epigraph_core_sync_notification_preparing
    progress.phase == CoreSyncPhase.EXCHANGE -> MR.strings.epigraph_core_sync_notification_fetching
    else -> MR.strings.epigraph_core_sync_notification_reading_progress
}

/**
 * Notifications for desktop sync. Only a sync the user started shows its progress and its result;
 * the periodic check and other background wakes stay silent unless the user must act.
 */
class CoreSyncNotifier(context: Context) {
    private val context = context.applicationContext
    private val noticePreferences = this.context.getSharedPreferences(NOTICE_PREFERENCES, Context.MODE_PRIVATE)

    /**
     * Runs [block] while publishing its progress on every refresh. Once [userVisible] holds, the run
     * shows a progress notification and [promote] tries to make it foreground work; a refused
     * promotion still shows the notification.
     */
    suspend fun <T> withProgress(
        userVisible: () -> Boolean,
        phase: () -> CoreSyncPhase,
        remaining: suspend () -> Long,
        publish: suspend (CoreSyncRunProgress) -> Unit,
        promote: suspend (ForegroundInfo) -> Boolean,
        block: suspend () -> T,
    ): T = coroutineScope {
        val ticker = launch {
            var peak = 0L
            var percent = 0
            var lastPhase: CoreSyncPhase? = null
            var promoted = false
            var published: CoreSyncRunProgress? = null
            var unchangedTicks = 0
            val eta = CoreSyncEta()
            while (isActive) {
                val current = phase()
                if (current != lastPhase) {
                    // Each phase fills its own share of the bar from its own change count.
                    peak = 0
                    lastPhase = current
                }
                val left = try {
                    remaining()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                    0L
                }
                val outbox = coreSyncProgress(peak, left)
                peak = outbox.max.toLong()
                percent = coreSyncRunPercent(current, outbox, percent)
                val etaSeconds = eta.sample(System.nanoTime() / 1_000_000, current, outbox.remaining)
                val progress = CoreSyncRunProgress(current, percent, outbox.remaining, userVisible(), etaSeconds)
                val changed = progress != published
                // Unchanged progress is not stored again.
                if (changed) {
                    published = progress
                    try {
                        publish(progress)
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Exception) {
                        // A screen misses one refresh; the run goes on.
                        published = null
                    }
                }
                // Reposted now and then even when unchanged, so its timeout never fires mid-run.
                if (progress.userVisible && (changed || ++unchangedTicks >= PROGRESS_REPOST_TICKS)) {
                    unchangedTicks = 0
                    val notification = progressNotification(progress)
                    if (!promoted) {
                        promoted = true
                        if (!promote(foregroundInfo(notification))) {
                            context.notificationManager.notify(Notifications.ID_CORE_SYNC_PROGRESS, notification)
                        }
                    } else {
                        context.notificationManager.notify(Notifications.ID_CORE_SYNC_PROGRESS, notification)
                    }
                }
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

    /** What WorkManager shows while it starts expedited work as a foreground service (API < 31). */
    fun startingForegroundInfo(): ForegroundInfo = foregroundInfo(
        progressNotification(CoreSyncRunProgress(CoreSyncPhase.LIBRARY, 0, 0, userVisible = true)),
    )

    /** [force] reposts a notice the user swiped, for a sync the user just asked for. */
    fun update(run: CoreSyncLastRun, force: Boolean = false) {
        when (val update = coreSyncNoticeUpdate(run)) {
            CoreSyncNoticeUpdate.Keep -> Unit
            CoreSyncNoticeUpdate.Clear -> clearAttention()
            is CoreSyncNoticeUpdate.Show -> showAttention(update.notice, force)
        }
    }

    /** The last notification of a sync the user started; replaces the result of an earlier one. */
    fun showResult(result: CoreSyncResult) {
        val (title, text) = when (result) {
            CoreSyncResult.Synced ->
                context.getString(MR.strings.epigraph_core_sync_notification_done) to
                    context.getString(MR.strings.epigraph_core_sync_notification_done_text)
            CoreSyncResult.Finished ->
                context.getString(MR.strings.epigraph_core_sync_notification_finished) to
                    context.getString(MR.strings.epigraph_core_sync_notification_finished_text)
            is CoreSyncResult.Pending ->
                context.getString(MR.strings.epigraph_core_sync_notification_finished) to
                    context.getString(MR.strings.epigraph_core_sync_notification_pending_text, result.remaining)
            is CoreSyncResult.Blocked ->
                context.getString(MR.strings.epigraph_core_sync_notification_incomplete) to
                    context.getString(MR.strings.epigraph_core_sync_notification_blocked_text, result.blocked)
            CoreSyncResult.WillRetry ->
                context.getString(MR.strings.epigraph_core_sync_notification_incomplete) to
                    context.getString(MR.strings.epigraph_core_sync_notification_retry_text)
            CoreSyncResult.DesktopBusy ->
                context.getString(MR.strings.epigraph_core_sync_notification_desktop_busy) to
                    context.getString(MR.strings.epigraph_core_sync_notification_desktop_busy_text)
        }
        val notification = context.notificationBuilder(Notifications.CHANNEL_CORE_SYNC) {
            setSmallIcon(R.drawable.ic_epigraph)
            setContentTitle(title)
            setContentText(text)
            setStyle(NotificationCompat.BigTextStyle().bigText(text))
            setContentIntent(openSettings())
            setAutoCancel(true)
            setOnlyAlertOnce(true)
        }.build()
        context.notificationManager.notify(Notifications.ID_CORE_SYNC_RESULT, notification)
    }

    /** A new sync the user starts replaces the result of the last one. */
    fun clearResult() {
        context.notificationManager.cancel(Notifications.ID_CORE_SYNC_RESULT)
    }

    fun clearAttention() {
        if (noticePreferences.getString(KEY_NOTICE, null) == null) return
        noticePreferences.edit().remove(KEY_NOTICE).apply()
        context.notificationManager.cancel(Notifications.ID_CORE_SYNC_ATTENTION)
    }

    private fun showAttention(notice: CoreSyncNotice, force: Boolean) {
        // Posted once per problem: the periodic check must not bring back a notice the user swiped.
        if (!force && noticePreferences.getString(KEY_NOTICE, null) == notice.name) return
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

    private fun foregroundInfo(notification: Notification): ForegroundInfo =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ForegroundInfo(
                Notifications.ID_CORE_SYNC_PROGRESS,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
            )
        } else {
            ForegroundInfo(Notifications.ID_CORE_SYNC_PROGRESS, notification)
        }

    private fun progressNotification(progress: CoreSyncRunProgress): Notification =
        context.notificationBuilder(Notifications.CHANNEL_CORE_SYNC) {
            setSmallIcon(R.drawable.ic_epigraph)
            setContentTitle(context.getString(MR.strings.epigraph_core_sync_notification_progress))
            val phaseText = context.getString(coreSyncPhaseText(progress), progress.remaining)
            val etaText = progress.etaSeconds?.let { seconds ->
                val (text, count) = coreSyncEtaText(seconds)
                context.getString(text, count)
            }
            setContentText(if (etaText == null) phaseText else "$phaseText · $etaText")
            setProgress(100, progress.percent, false)
            setContentIntent(openSettings())
            setOngoing(true)
            setOnlyAlertOnce(true)
            setSilent(true)
            setCategory(NotificationCompat.CATEGORY_PROGRESS)
            // A process death skips the cancel in withProgress; the notice then clears itself.
            setTimeoutAfter(PROGRESS_TIMEOUT_MS)
        }.build()

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
        const val PROGRESS_REFRESH_MS = 1_500L
        const val PROGRESS_REPOST_TICKS = 40
        const val PROGRESS_TIMEOUT_MS = 10 * 60 * 1_000L
        const val NOTICE_PREFERENCES = "epigraph_core_sync_notice"
        const val KEY_NOTICE = "shown"
    }
}
