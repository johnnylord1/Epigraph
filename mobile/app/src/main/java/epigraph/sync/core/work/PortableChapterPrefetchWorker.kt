package epigraph.sync.core.work

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.portable.PortableChapterPrefetcher
import eu.kanade.tachiyomi.data.library.LibraryUpdateJob
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import yokai.util.koin.get

/**
 * Fetches chapter lists for synced comics whose desktop progress waits on them, then wakes the
 * Core sync so the new chapters bind and take their read state. Never runs during a library update,
 * which already fetches the same lists.
 */
class PortableChapterPrefetchWorker(
    context: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(context, workerParameters) {
    override suspend fun doWork(): Result {
        val paused = get<CoreSyncPause>().paused
        if (paused.value) return Result.success()
        if (LibraryUpdateJob.isRunning(applicationContext)) {
            enqueueFollowUp(applicationContext, AFTER_LIBRARY_UPDATE_DELAY_MILLIS)
            return Result.success()
        }
        if (!EXECUTION_MUTEX.tryLock()) return Result.success()
        try {
            // Reconnecting sync asks for a fetch again; nothing is queued while disconnected.
            val report = untilPaused(paused) { get<PortableChapterPrefetcher>().run() } ?: return Result.success()
            if (report.added > 0) {
                EpigraphCoreSyncWorker.enqueueImmediate(
                    applicationContext,
                    CoreBackgroundSyncReason.PERIODIC_RECONCILIATION,
                )
            }
            if (report.remaining) enqueueFollowUp(applicationContext, FOLLOW_UP_DELAY_MILLIS)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            // Titles not reached keep no cooldown; the next sync asks again.
            Log.w(LOG_TAG, "chapter list fetch stopped", failure)
        } finally {
            EXECUTION_MUTEX.unlock()
        }
        return Result.success()
    }

    companion object {
        private const val UNIQUE_REQUEST = "epigraph-portable-chapter-prefetch-v1"
        private const val UNIQUE_FOLLOW_UP = "epigraph-portable-chapter-prefetch-follow-up-v1"
        private const val TAG = "epigraph-portable-chapter-prefetch"
        private const val LOG_TAG = "EpigraphChapterPrefetch"
        private const val FOLLOW_UP_DELAY_MILLIS = 60_000L
        private const val AFTER_LIBRARY_UPDATE_DELAY_MILLIS = 10 * 60 * 1_000L
        private val EXECUTION_MUTEX = Mutex()
        private val CONSTRAINTS = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

        /** Asked by every sync pass that leaves chapters pending; a queued or running fetch absorbs it. */
        fun request(context: Context) = enqueue(context, UNIQUE_REQUEST, 0L, ExistingWorkPolicy.KEEP)

        private fun enqueueFollowUp(context: Context, delayMillis: Long) =
            enqueue(context, UNIQUE_FOLLOW_UP, delayMillis, ExistingWorkPolicy.REPLACE)

        private fun enqueue(context: Context, name: String, delayMillis: Long, policy: ExistingWorkPolicy) {
            val request = OneTimeWorkRequestBuilder<PortableChapterPrefetchWorker>()
                .setConstraints(CONSTRAINTS)
                .setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(name, policy, request)
        }
    }
}

/** Runs [block] until [paused] turns true, then cancels it and returns null. */
internal suspend fun <T> untilPaused(paused: StateFlow<Boolean>, block: suspend () -> T): T? = coroutineScope {
    val work = async { block() }
    val stop = launch {
        paused.first { it }
        work.cancel()
    }
    try {
        work.await()
    } catch (cancelled: CancellationException) {
        if (!isActive) throw cancelled
        null
    } finally {
        stop.cancel()
    }
}
