package epigraph.sync.core.work

import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.novels.LocalNovelLibraryOutboxRepair
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import yokai.util.koin.get

class WorkManagerCoreBackgroundSyncScheduler(
    context: Context,
) : CoreBackgroundSyncScheduler {
    private val appContext = context.applicationContext

    override fun enqueue(reason: CoreBackgroundSyncReason) {
        EpigraphCoreSyncWorker.enqueueImmediate(appContext, reason)
    }
}

/** Network-constrained product worker. Its success output says outbox-drained, never synced. */
class EpigraphCoreSyncWorker(
    context: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(context, workerParameters) {
    override suspend fun doWork(): Result {
        if (!isCurrentSchedulerVersion(inputData.getInt(INPUT_SCHEDULER_VERSION, 0))) {
            return Result.success(workDataOf(OUTPUT_STATE to STATE_STALE_SCHEDULER))
        }
        if (!EXECUTION_MUTEX.tryLock()) {
            return Result.success(workDataOf(OUTPUT_STATE to STATE_COALESCED))
        }
        return try {
            var execution: WorkerExecution
            var attempts = 0
            var observedGeneration: Long
            do {
                observedGeneration = WAKE_GENERATION.get()
                execution = runOnce()
                attempts += 1
            } while (attempts < MAX_GENERATION_DRAINS && observedGeneration != WAKE_GENERATION.get())
            if (shouldScheduleFollowUp(execution.usesWorkManagerBackoff, execution.awaitingExternalAction)) {
                scheduleNextWake()
            }
            execution.result
        } finally {
            EXECUTION_MUTEX.unlock()
        }
    }

    private suspend fun runOnce(): WorkerExecution {
        // Backfill favorite LNReader rows created by older builds before counting/draining the
        // outbox. The repair is idempotent and is a no-op until the device is paired.
        runCatching { get<LocalNovelLibraryOutboxRepair>().repair() }
            .onFailure { failure ->
                Log.w(LOG_TAG, "local novel library repair failed", failure)
            }
        val outcome = try {
            get<CoreOutboxSyncRunner>().run(
                nowEpochMillis = System.currentTimeMillis(),
                synchronizeReplica = true,
            )
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            Log.w(
                LOG_TAG,
                "worker failed before producing an outcome: ${failure::class.simpleName ?: "UnknownFailure"}",
            )
            setProgress(workDataOf(OUTPUT_STATE to STATE_RETRY, OUTPUT_REASON to "unexpected_failure"))
            return WorkerExecution(Result.retry(), usesWorkManagerBackoff = true)
        }
        return when (outcome) {
            is CoreOutboxSyncOutcome.OutboxDrained -> WorkerExecution(Result.success(
                workDataOf(
                    OUTPUT_STATE to STATE_OUTBOX_DRAINED,
                    OUTPUT_REPLICA to outcome.replica.name.lowercase(),
                ),
            ))
            is CoreOutboxSyncOutcome.OutboxDeferred -> WorkerExecution(Result.success(
                workDataOf(
                    OUTPUT_STATE to STATE_OUTBOX_DEFERRED,
                    OUTPUT_PENDING_COUNT to outcome.pendingCount,
                    OUTPUT_REPLICA to outcome.replica.name.lowercase(),
                ),
            ))
            is CoreOutboxSyncOutcome.Retry -> {
                Log.w(
                    LOG_TAG,
                    "worker retry: reason=${outcome.reason.name.lowercase()} pending=${outcome.pendingCount}",
                )
                setProgress(
                    workDataOf(
                        OUTPUT_STATE to STATE_RETRY,
                        OUTPUT_REASON to outcome.reason.name.lowercase(),
                        OUTPUT_PENDING_COUNT to outcome.pendingCount,
                    ),
                )
                WorkerExecution(Result.retry(), usesWorkManagerBackoff = true)
            }
            is CoreOutboxSyncOutcome.NeedsPairing -> WorkerExecution(
                result = Result.success(
                    workDataOf(
                        OUTPUT_STATE to STATE_NEEDS_PAIRING,
                        OUTPUT_REASON to outcome.reason.name.lowercase(),
                        OUTPUT_PENDING_COUNT to outcome.pendingCount,
                    ),
                ),
                awaitingExternalAction = true,
            )
            is CoreOutboxSyncOutcome.NeedsUserAction -> WorkerExecution(
                result = Result.success(
                    workDataOf(
                        OUTPUT_STATE to STATE_NEEDS_USER_ACTION,
                        OUTPUT_REASON to outcome.reason.name.lowercase(),
                        OUTPUT_PENDING_COUNT to outcome.pendingCount,
                    ),
                ),
                awaitingExternalAction = true,
            )
        }
    }

    private suspend fun scheduleNextWake() {
        val now = System.currentTimeMillis()
        val nextAttempt = runCatching { get<CoreSyncWakeStore>().nextAttemptAt() }.getOrNull()
        val target = nextCoreWakeAt(now, nextAttempt, PERIODIC_RECONCILIATION_MILLIS)
        enqueueDelayed(applicationContext, target - now)
    }

    private data class WorkerExecution(
        val result: Result,
        val usesWorkManagerBackoff: Boolean = false,
        val awaitingExternalAction: Boolean = false,
    )

    companion object {
        private const val UNIQUE_SYNC = "aethon-core-sync-immediate-v6"
        private const val UNIQUE_OUTBOX_SYNC = "aethon-core-sync-outbox-v6"
        private const val UNIQUE_DELAYED_SYNC = "aethon-core-sync-delayed-v6"
        private const val LEGACY_UNIFIED_SYNC = "aethon-core-sync-v5"
        private const val LEGACY_UNIQUE_ON_DEMAND = "aethon-core-sync-on-demand-v4"
        private const val LEGACY_UNIQUE_PERIODIC = "aethon-core-sync-periodic-v1"
        private const val TAG = "aethon-core-sync"
        private const val LOG_TAG = "EpigraphCoreSync"
        private const val INPUT_REASON = "reason"
        private const val INPUT_SCHEDULER_VERSION = "scheduler_version"
        private const val OUTPUT_STATE = "state"
        private const val OUTPUT_REASON = "reason"
        private const val OUTPUT_PENDING_COUNT = "pending_count"
        private const val OUTPUT_REPLICA = "replica"
        private const val STATE_OUTBOX_DRAINED = "outbox_drained"
        private const val STATE_OUTBOX_DEFERRED = "outbox_deferred"
        private const val STATE_COALESCED = "coalesced"
        private const val STATE_RETRY = "retry"
        private const val STATE_NEEDS_PAIRING = "needs_pairing"
        private const val STATE_NEEDS_USER_ACTION = "needs_user_action"
        private const val STATE_STALE_SCHEDULER = "stale_scheduler"
        private const val SCHEDULER_VERSION = 6

        private val NETWORK_CONSTRAINTS = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        private val EXECUTION_MUTEX = Mutex()
        private val WAKE_GENERATION = AtomicLong(0)
        private const val MAX_GENERATION_DRAINS = 4
        private const val OUTBOX_DEBOUNCE_MILLIS = 750L
        private const val PERIODIC_RECONCILIATION_MILLIS = 15 * 60 * 1_000L
        private const val SCHEDULER_MIGRATION_PREFERENCES = "aethon_core_sync_scheduler"
        private const val SCHEDULER_V6_MIGRATION_COMPLETE = "v6_migration_complete"

        fun enqueueImmediate(context: Context, reason: CoreBackgroundSyncReason) {
            WAKE_GENERATION.incrementAndGet()
            val request = OneTimeWorkRequestBuilder<EpigraphCoreSyncWorker>()
                .setConstraints(NETWORK_CONSTRAINTS)
                .setInitialDelay(immediateDelayMillis(reason), TimeUnit.MILLISECONDS)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
                .setInputData(
                    workDataOf(
                        INPUT_REASON to reason.name.lowercase(),
                        INPUT_SCHEDULER_VERSION to SCHEDULER_VERSION,
                    ),
                )
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                immediateWorkName(reason),
                immediateWorkPolicy(reason, EXECUTION_MUTEX.isLocked),
                request,
            )
        }

        fun setup(context: Context) {
            val appContext = context.applicationContext
            CoreConnectivityWakeMonitor.start(appContext)
            migrateLegacyWork(appContext, WorkManager.getInstance(appContext))
            enqueueImmediate(appContext, CoreBackgroundSyncReason.APP_START)
        }

        private fun migrateLegacyWork(context: Context, workManager: WorkManager) {
            val preferences = context.getSharedPreferences(SCHEDULER_MIGRATION_PREFERENCES, Context.MODE_PRIVATE)
            if (preferences.getBoolean(SCHEDULER_V6_MIGRATION_COMPLETE, false)) {
                workManager.pruneWork()
                return
            }

            // Persist the one-shot decision before asynchronous inspection. A process death must
            // not restart a cancellation traversal on every launch. Legacy workers are harmless:
            // they carry no scheduler version and finish before touching Core or the outbox.
            if (!preferences.edit().putBoolean(SCHEDULER_V6_MIGRATION_COMPLETE, true).commit()) {
                Log.w(LOG_TAG, "legacy scheduler migration marker could not be persisted")
                return
            }
            listOf(
                LEGACY_UNIFIED_SYNC,
                LEGACY_UNIQUE_ON_DEMAND,
                LEGACY_UNIQUE_PERIODIC,
            ).forEach { workManager.cancelUniqueWork(it) }
            workManager.pruneWork()
        }

        private fun enqueueDelayed(context: Context, delayMillis: Long) {
            val request = OneTimeWorkRequestBuilder<EpigraphCoreSyncWorker>()
                .setConstraints(NETWORK_CONSTRAINTS)
                .setInitialDelay(delayMillis.coerceAtLeast(0), TimeUnit.MILLISECONDS)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
                .setInputData(
                    workDataOf(
                        INPUT_REASON to CoreBackgroundSyncReason.PERIODIC_RECONCILIATION.name.lowercase(),
                        INPUT_SCHEDULER_VERSION to SCHEDULER_VERSION,
                    ),
                )
                .addTag(TAG)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                UNIQUE_DELAYED_SYNC,
                delayedWorkPolicy(),
                request,
            )
        }

        /**
         * A delayed reconciliation schedules its successor while the current unique work is
         * still RUNNING. REPLACE cancels that current worker before WorkManager can persist its
         * result, which produces WorkerStoppedException and loses the success output. Appending
         * places exactly one successor behind the active reconciliation and replaces only a
         * previously failed/cancelled chain.
         */
        internal fun delayedWorkPolicy(): ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE

        internal fun immediateWorkName(reason: CoreBackgroundSyncReason): String =
            if (reason == CoreBackgroundSyncReason.OUTBOX_PENDING) UNIQUE_OUTBOX_SYNC else UNIQUE_SYNC

        internal fun isCurrentSchedulerVersion(version: Int): Boolean = version == SCHEDULER_VERSION

        internal fun shouldScheduleFollowUp(
            usesWorkManagerBackoff: Boolean,
            awaitingExternalAction: Boolean,
        ): Boolean = !usesWorkManagerBackoff && !awaitingExternalAction

        internal fun immediateDelayMillis(reason: CoreBackgroundSyncReason): Long =
            if (reason == CoreBackgroundSyncReason.OUTBOX_PENDING) OUTBOX_DEBOUNCE_MILLIS else 0

        internal fun immediateWorkPolicy(
            reason: CoreBackgroundSyncReason,
            executionActive: Boolean,
        ): ExistingWorkPolicy = when {
            reason == CoreBackgroundSyncReason.OUTBOX_PENDING -> ExistingWorkPolicy.KEEP
            executionActive -> ExistingWorkPolicy.KEEP
            else -> ExistingWorkPolicy.REPLACE
        }
    }
}

internal fun nextCoreWakeAt(now: Long, nextAttemptAt: Long?, periodicIntervalMillis: Long): Long {
    require(now >= 0)
    require(periodicIntervalMillis > 0)
    val periodic = now + periodicIntervalMillis
    return nextAttemptAt?.coerceAtLeast(now)?.coerceAtMost(periodic) ?: periodic
}

/** Process-lifetime connectivity wake. Work execution remains single-flight through EXECUTION_MUTEX. */
private object CoreConnectivityWakeMonitor {
    private val started = AtomicBoolean(false)

    fun start(context: Context) {
        if (!started.compareAndSet(false, true)) return
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        if (connectivity == null) {
            started.set(false)
            return
        }
        val tracker = CoreConnectivityWakeTracker { reason ->
            EpigraphCoreSyncWorker.enqueueImmediate(context, reason)
        }
        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = tracker.onAvailable()

            override fun onLost(network: Network) = tracker.onUnavailable()

            override fun onUnavailable() = tracker.onUnavailable()
        }
        try {
            connectivity.registerDefaultNetworkCallback(callback)
        } catch (_: RuntimeException) {
            started.set(false)
        }
    }
}

internal class CoreConnectivityWakeTracker(
    private val sink: (CoreBackgroundSyncReason) -> Unit,
) {
    private var unavailableObserved = false

    @Synchronized
    fun onUnavailable() {
        unavailableObserved = true
    }

    @Synchronized
    fun onAvailable() {
        if (!unavailableObserved) return
        unavailableObserved = false
        sink(CoreBackgroundSyncReason.CONNECTIVITY_RESTORED)
    }
}
