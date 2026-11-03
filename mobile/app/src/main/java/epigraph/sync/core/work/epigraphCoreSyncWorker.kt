package epigraph.sync.core.work

import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.novels.LocalNovelLibraryOutboxRepair
import epigraph.sync.core.suwayomi.CoreHeldChapterProgressFilter
import epigraph.sync.core.suwayomi.DisplacedComicRowRepair
import epigraph.sync.core.suwayomi.LocalComicLibraryOutboxRepair
import epigraph.sync.EpigraphReaderProgressRouter
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.ForegroundInfo
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.OutOfQuotaPolicy
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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

/**
 * Network-constrained product worker. Its success output says outbox-drained, never synced. A sync
 * the user asked for runs as expedited foreground work with a progress notification; every other
 * wake stays silent.
 */
class EpigraphCoreSyncWorker(
    context: Context,
    workerParameters: WorkerParameters,
) : CoroutineWorker(context, workerParameters) {
    /** What the current pass is doing, read by the progress ticker. */
    @Volatile
    private var phase = CoreSyncPhase.LIBRARY

    /** Used to start an expedited run as a foreground service before API 31. */
    override suspend fun getForegroundInfo(): ForegroundInfo = get<CoreSyncNotifier>().startingForegroundInfo()

    override suspend fun doWork(): Result {
        if (!isCurrentSchedulerVersion(inputData.getInt(INPUT_SCHEDULER_VERSION, 0))) {
            return Result.success(workDataOf(OUTPUT_STATE to STATE_STALE_SCHEDULER))
        }
        // Disconnected from Settings: stand down without a follow-up wake; reconnecting enqueues one.
        if (get<CoreSyncPause>().paused.value) {
            // Nothing will run what was asked before the disconnect; reconnecting asks again.
            USER_REQUESTS.markServed(USER_REQUESTS.snapshot())
            // A notice about a sync the user just disconnected no longer asks for anything.
            runCatching { get<CoreSyncNotifier>().clearAttention() }
            return Result.success(workDataOf(OUTPUT_STATE to STATE_PAUSED))
        }
        if (!EXECUTION_MUTEX.tryLock()) {
            // The running worker sees the pending request and shows its progress instead.
            return Result.success(workDataOf(OUTPUT_STATE to STATE_COALESCED))
        }
        var drainedGeneration: Long? = null
        var usesBackoff = false
        // A retry after backoff stays silent: the user already saw how the run they asked for ended.
        var userVisible = runAttemptCount == 0 && inputData.getBoolean(INPUT_USER_VISIBLE, false)
        var servedUpTo = USER_REQUESTS.snapshot()
        return try {
            val notifier = get<CoreSyncNotifier>()
            val outbox = get<CorePendingOutbox>()
            if (userVisible) notifier.clearResult()
            val execution = notifier.withProgress(
                // Latched: a request that arrives while a background run is going makes it visible.
                userVisible = {
                    if (!userVisible && USER_REQUESTS.pending()) {
                        userVisible = true
                        notifier.clearResult()
                    }
                    userVisible
                },
                phase = { phase },
                remaining = { outbox.unsettledCount() },
                publish = { progress -> setProgress(progress.toWorkData()) },
                promote = { info -> promoteToForeground(info) },
            ) {
                var drained: WorkerExecution
                var attempts = 0
                var observedGeneration: Long
                do {
                    servedUpTo = USER_REQUESTS.snapshot()
                    observedGeneration = WAKE_GENERATION.get()
                    val passGeneration = observedGeneration
                    val pass = attempts
                    drained = runOnce(
                        deferProgress = {
                            deferProgressBackfill(pass, passGeneration, WAKE_GENERATION.get())
                        },
                    )
                    attempts += 1
                } while (attempts < MAX_GENERATION_DRAINS && observedGeneration != WAKE_GENERATION.get())
                drainedGeneration = observedGeneration
                drained
            }
            usesBackoff = execution.usesWorkManagerBackoff
            val lastRun = runCatching { get<CoreSyncRunStore>().lastRun.value }.getOrNull()
            runCatching { lastRun?.let { notifier.update(it, force = userVisible) } }
                .onFailure { failure -> Log.w(LOG_TAG, "sync notice could not be updated", failure) }
            if (userVisible) showResult(notifier, lastRun)
            if (shouldScheduleFollowUp(execution.usesWorkManagerBackoff, execution.awaitingExternalAction)) {
                scheduleNextWake()
            }
            if (execution.degradedRetry) {
                if (execution.sentBackfill) DEGRADED_RETRY_STREAK.set(0)
                // Saturates once past the cap, so the counter can never wrap negative.
                val streak = DEGRADED_RETRY_STREAK.getAndUpdate { if (it > MAX_DEGRADED_RETRY_SHIFT) it else it + 1 }
                if (shouldScheduleDegradedRetry(streak)) scheduleDegradedRetry(streak)
            } else {
                DEGRADED_RETRY_STREAK.set(0)
            }
            execution.result
        } finally {
            // Requests made after the last pass started were not served; the follow-up wake shows them.
            // Marked even when the run failed, so a later background run does not show itself for it.
            USER_REQUESTS.markServed(servedUpTo)
            EXECUTION_MUTEX.unlock()
            // A wake that arrived after the last drain started was coalesced or kept behind this
            // run while the mutex was held; nothing else would run it.
            if (missedWakeAfterDrain(drainedGeneration, WAKE_GENERATION.get(), usesBackoff)) {
                enqueueFollowUp(applicationContext)
            }
        }
    }

    private suspend fun promoteToForeground(info: ForegroundInfo): Boolean = try {
        setForeground(info)
        true
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (failure: Exception) {
        // Android refuses a foreground service started from the background; the plain notice stays.
        Log.w(LOG_TAG, "sync could not run in the foreground: ${failure::class.simpleName}")
        false
    }

    private suspend fun showResult(notifier: CoreSyncNotifier, lastRun: CoreSyncLastRun?) {
        try {
            val counts = get<CoreSyncStatusMonitor>().readCounts()
            val status = resolveCoreSyncStatus(
                paired = true,
                activity = CoreSyncActivity.IDLE,
                counts = counts,
                lastRun = lastRun,
            )
            coreSyncResult(status)?.let(notifier::showResult)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            Log.w(LOG_TAG, "sync result could not be shown", failure)
        }
    }

    /**
     * [includeProgress] adds the reading-progress backfill, which scans every read chapter of the library;
     * [checkWithCore] lets it ask the desktop which chapters it already holds.
     */
    private suspend fun repairLibraries(includeProgress: Boolean, checkWithCore: Boolean): Int {
        // First, so the outbox and replica passes never meet a title that is in the library twice.
        val displaced = runCatching { get<DisplacedComicRowRepair>().repair() }
            .onFailure { failure ->
                Log.w(LOG_TAG, "displaced comic row repair failed", failure)
            }
            .getOrDefault(0)
        val novels = runCatching { get<LocalNovelLibraryOutboxRepair>().repair() }
            .onFailure { failure ->
                Log.w(LOG_TAG, "local novel library repair failed", failure)
            }
            .getOrDefault(0)
        val comics = runCatching { get<LocalComicLibraryOutboxRepair>().repair() }
            .onFailure { failure ->
                Log.w(LOG_TAG, "local comic library repair failed", failure)
            }
            .getOrDefault(0)
        if (!includeProgress) return displaced + novels + comics
        // After the comic repair, so favorites it just bound already carry their reading progress.
        val progress = runCatching {
            val held = get<CoreHeldChapterProgressFilter>()
            get<EpigraphReaderProgressRouter>().backfillComicProgress(
                filter = if (checkWithCore) held else held.cachedOnly,
            )
        }
            .onFailure { failure ->
                Log.w(LOG_TAG, "local comic progress backfill failed", failure)
            }
            .getOrDefault(0)
        return displaced + novels + comics + progress
    }

    /** [deferProgress] says, after the drain, that a newer wake will run another pass of this worker. */
    private suspend fun runOnce(deferProgress: () -> Boolean): WorkerExecution {
        // Backfill favorites recorded on this device before pairing (or by older builds) before
        // counting/draining the outbox, so the catalog read sees them. The repairs are idempotent and
        // no-ops until paired. Reading progress is not part of the catalog and its backfill scans every
        // read chapter, which took seconds on a large library, so it waits for the pass after the first
        // drain instead of delaying a desktop change.
        phase = CoreSyncPhase.LIBRARY
        repairLibraries(includeProgress = false, checkWithCore = false)
        var sentBackfill = false
        val outcome = try {
            val runner = get<CoreOutboxSyncRunner>()
            phase = CoreSyncPhase.EXCHANGE
            val first = runner.run(
                nowEpochMillis = System.currentTimeMillis(),
                synchronizeReplica = true,
            )
            // The first snapshot from a newly paired or rewound Core shows which local favorites and
            // reading progress it lacks; publish them in this run instead of waiting for the next wake.
            // A run that must retry still queues the progress the desktop is known to hold, for the next one.
            // A desktop still applying earlier changes answered, so the backfill asks it and sends now:
            // waiting for it to settle held each batch of reading progress for up to 15 minutes.
            val reachable = coreAnswered(first)
            // A desktop change that arrived during this pass waits for it to end; the next pass runs
            // the backfill instead, so it no longer delays that change by the length of a library scan.
            val repaired = if (deferProgress()) {
                0
            } else {
                phase = CoreSyncPhase.READING_PROGRESS
                repairLibraries(includeProgress = true, checkWithCore = reachable)
            }
            sentBackfill = reachable && repaired > 0
            if (sentBackfill) {
                runner.run(
                    nowEpochMillis = System.currentTimeMillis(),
                    synchronizeReplica = true,
                )
            } else {
                first
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            Log.w(
                LOG_TAG,
                "worker failed before producing an outcome: ${failure::class.simpleName ?: "UnknownFailure"}",
            )
            setProgress(workDataOf(OUTPUT_STATE to STATE_RETRY, OUTPUT_REASON to "unexpected_failure"))
            recordRun(
                CoreSyncLastRun(
                    state = CoreSyncRunState.RETRY,
                    reason = "unexpected_failure",
                    pendingCount = 0,
                    replica = null,
                    finishedAtMs = System.currentTimeMillis(),
                ),
            )
            return WorkerExecution(Result.retry(), usesWorkManagerBackoff = true)
        }
        recordRun(outcome.toLastRun(System.currentTimeMillis()))
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
                val retryData = workDataOf(
                    OUTPUT_STATE to STATE_RETRY,
                    OUTPUT_REASON to outcome.reason.name.lowercase(),
                    OUTPUT_PENDING_COUNT to outcome.pendingCount,
                )
                setProgress(retryData)
                if (retryUsesWorkManagerBackoff(outcome.reason)) {
                    WorkerExecution(Result.retry(), usesWorkManagerBackoff = true)
                } else {
                    // Core answered and the outbox drain already ran; only the desktop's comic
                    // side is degraded. Finishing this unique work keeps later OUTBOX_PENDING
                    // wakes (KEEP) from waiting behind WorkManager's exponential backoff.
                    WorkerExecution(Result.success(retryData), degradedRetry = true, sentBackfill = sentBackfill)
                }
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
                // A blocked desktop projection is fixed on the desktop; keep the periodic check so
                // the phone notices without a manual sync. Other reasons need a phone-side action.
                awaitingExternalAction = outcome.reason != CoreUserActionReason.REMOTE_PROJECTION_BLOCKED,
            )
        }
    }

    private fun recordRun(run: CoreSyncLastRun) {
        runCatching { get<CoreSyncRunStore>().record(run) }
            .onFailure { failure -> Log.w(LOG_TAG, "sync status could not be recorded", failure) }
    }

    private suspend fun scheduleNextWake() {
        val now = System.currentTimeMillis()
        val nextAttempt = runCatching { get<CoreSyncWakeStore>().nextAttemptAt() }.getOrNull()
        val target = nextCoreWakeAt(now, nextAttempt, PERIODIC_RECONCILIATION_MILLIS)
        enqueueDelayed(applicationContext, target - now)
    }

    private fun scheduleDegradedRetry(streak: Int) {
        val request = OneTimeWorkRequestBuilder<EpigraphCoreSyncWorker>()
            .setConstraints(NETWORK_CONSTRAINTS)
            .setInitialDelay(degradedRetryDelayMillis(streak), TimeUnit.MILLISECONDS)
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
            .addTag(DEGRADED_RETRY_TAG)
            .build()
        WorkManager.getInstance(applicationContext).enqueueUniqueWork(
            UNIQUE_DEGRADED_RETRY,
            degradedRetryWorkPolicy(scheduledFromDegradedRetry = DEGRADED_RETRY_TAG in tags),
            request,
        )
    }

    private data class WorkerExecution(
        val result: Result,
        val usesWorkManagerBackoff: Boolean = false,
        val awaitingExternalAction: Boolean = false,
        /** Comic-side retry: finish this work and follow up on [UNIQUE_DEGRADED_RETRY]. */
        val degradedRetry: Boolean = false,
        /** This run sent backfilled rows, so more may be left: the degraded chain starts over. */
        val sentBackfill: Boolean = false,
    )

    companion object {
        private const val UNIQUE_SYNC = "aethon-core-sync-immediate-v6"
        private const val UNIQUE_OUTBOX_SYNC = "aethon-core-sync-outbox-v6"
        private const val UNIQUE_DELAYED_SYNC = "aethon-core-sync-delayed-v6"
        private const val UNIQUE_DEGRADED_RETRY = "aethon-core-sync-degraded-retry-v6"
        private const val LEGACY_UNIFIED_SYNC = "aethon-core-sync-v5"
        private const val LEGACY_UNIQUE_ON_DEMAND = "aethon-core-sync-on-demand-v4"
        private const val LEGACY_UNIQUE_PERIODIC = "aethon-core-sync-periodic-v1"
        internal const val TAG = "aethon-core-sync"

        /** Marks user/app-triggered wakes so Settings can tell them from the periodic check. */
        internal const val IMMEDIATE_TAG = "aethon-core-sync-wake"
        private const val DEGRADED_RETRY_TAG = "aethon-core-sync-degraded-retry"
        private const val LOG_TAG = "EpigraphCoreSync"
        private const val INPUT_REASON = "reason"
        private const val INPUT_SCHEDULER_VERSION = "scheduler_version"
        private const val INPUT_USER_VISIBLE = "user_visible"
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
        private const val STATE_PAUSED = "paused"
        private const val SCHEDULER_VERSION = 6

        private val NETWORK_CONSTRAINTS = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .build()
        private val EXECUTION_MUTEX = Mutex()
        private val WAKE_GENERATION = AtomicLong(0)
        private val USER_REQUESTS = CoreUserSyncRequests()

        /** Consecutive comic-side retries in this process; any other outcome resets it. */
        private val DEGRADED_RETRY_STREAK = AtomicInteger(0)
        private const val MAX_DEGRADED_RETRY_SHIFT = 7
        private const val MAX_GENERATION_DRAINS = 4
        private const val OUTBOX_DEBOUNCE_MILLIS = 750L
        private const val PERIODIC_RECONCILIATION_MILLIS = 15 * 60 * 1_000L
        private const val SCHEDULER_MIGRATION_PREFERENCES = "aethon_core_sync_scheduler"
        private const val SCHEDULER_V6_MIGRATION_COMPLETE = "v6_migration_complete"

        fun enqueueImmediate(context: Context, reason: CoreBackgroundSyncReason) {
            val userVisible = immediateRequestIsUserVisible(reason)
            // Counted before the wake, so a run already going sees it when it checks the generation.
            if (userVisible) USER_REQUESTS.request()
            WAKE_GENERATION.incrementAndGet()
            val delayMillis = immediateDelayMillis(reason)
            val request = OneTimeWorkRequestBuilder<EpigraphCoreSyncWorker>()
                .setConstraints(NETWORK_CONSTRAINTS)
                .apply {
                    // Expedited work cannot be delayed.
                    if (delayMillis > 0) setInitialDelay(delayMillis, TimeUnit.MILLISECONDS)
                    // Out of quota, it still runs at once and promotes itself to the foreground.
                    if (userVisible) setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
                }
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
                .setInputData(
                    workDataOf(
                        INPUT_REASON to reason.name.lowercase(),
                        INPUT_SCHEDULER_VERSION to SCHEDULER_VERSION,
                        INPUT_USER_VISIBLE to userVisible,
                    ),
                )
                .addTag(TAG)
                .addTag(IMMEDIATE_TAG)
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

        /** Runs once more right after the current unique work, without cancelling it. */
        private fun enqueueFollowUp(context: Context) {
            val request = OneTimeWorkRequestBuilder<EpigraphCoreSyncWorker>()
                .setConstraints(NETWORK_CONSTRAINTS)
                .setBackoffCriteria(
                    BackoffPolicy.EXPONENTIAL,
                    WorkRequest.MIN_BACKOFF_MILLIS,
                    TimeUnit.MILLISECONDS,
                )
                .setInputData(
                    workDataOf(
                        INPUT_REASON to CoreBackgroundSyncReason.APP_START.name.lowercase(),
                        INPUT_SCHEDULER_VERSION to SCHEDULER_VERSION,
                    ),
                )
                .addTag(TAG)
                .addTag(IMMEDIATE_TAG)
                .build()
            WorkManager.getInstance(context.applicationContext).enqueueUniqueWork(
                UNIQUE_SYNC,
                followUpWorkPolicy(),
                request,
            )
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

        /** The finishing worker may still be RUNNING in [UNIQUE_SYNC]; see [delayedWorkPolicy]. */
        internal fun followUpWorkPolicy(): ExistingWorkPolicy = ExistingWorkPolicy.APPEND_OR_REPLACE

        /**
         * Whether a pass (0-based) can leave the progress backfill to the next one: a wake came in
         * after it read the generation and the drain cap still allows another pass, which always
         * runs the backfill when it is the last.
         */
        internal fun deferProgressBackfill(pass: Int, passGeneration: Long, currentGeneration: Long): Boolean =
            pass + 1 < MAX_GENERATION_DRAINS && passGeneration != currentGeneration

        /**
         * Whether a wake came in after the last drain read the generation: its worker was coalesced
         * or kept behind this run, or the drain cap was reached. A run that backs off reruns by
         * itself, and a follow-up appended behind it would only wait for that retry.
         */
        internal fun missedWakeAfterDrain(
            drainedGeneration: Long?,
            currentGeneration: Long,
            usesWorkManagerBackoff: Boolean,
        ): Boolean = drainedGeneration != null && !usesWorkManagerBackoff && drainedGeneration != currentGeneration

        /**
         * Only failures that stop the outbox itself (Core unreachable, capabilities, credential
         * I/O) use WorkManager's exponential backoff. Comic-side failures (Suwayomi replica,
         * projection still pending on the desktop, Suwayomi mutations refused with 5xx such as
         * SUWAYOMI_CATALOG_UNAVAILABLE) happen after the book/novel outbox was already drained.
         * Backing off the current unique work there would hold every later OUTBOX_PENDING wake
         * behind KEEP, so those retries move to their own chain instead.
         */
        /**
         * Whether Core answered the run: it did unless the run had to retry, and a desktop whose
         * Suwayomi projection is still pending answered too. Progress that waits on a chapter the
         * desktop lacks keeps that projection pending for minutes without any failure.
         */
        internal fun coreAnswered(outcome: CoreOutboxSyncOutcome): Boolean =
            outcome !is CoreOutboxSyncOutcome.Retry || outcome.reason == CoreOutboxRetryReason.OUTBOX_PENDING

        internal fun retryUsesWorkManagerBackoff(reason: CoreOutboxRetryReason): Boolean = when (reason) {
            CoreOutboxRetryReason.CREDENTIAL_IO,
            CoreOutboxRetryReason.CONNECTION,
            CoreOutboxRetryReason.CAPABILITIES,
            -> true
            CoreOutboxRetryReason.OUTBOX_PENDING,
            CoreOutboxRetryReason.REPLICA,
            CoreOutboxRetryReason.SUWAYOMI,
            -> false
        }

        /**
         * Same first steps as WorkManager's exponential backoff (10 s, 20 s, 40 s...), but capped at
         * the periodic reconciliation instead of five hours, so a desktop whose Suwayomi comes back
         * is noticed within 15 minutes even without any other wake.
         */
        internal fun degradedRetryDelayMillis(streak: Int): Long {
            require(streak >= 0)
            return (WorkRequest.MIN_BACKOFF_MILLIS shl streak.coerceAtMost(MAX_DEGRADED_RETRY_SHIFT))
                .coerceAtMost(PERIODIC_RECONCILIATION_MILLIS)
        }

        /**
         * A degraded retry always comes with the periodic follow-up (Retry never awaits an external
         * action), which already wakes within [PERIODIC_RECONCILIATION_MILLIS]. Once the backoff
         * reaches that cap a second chain would only double the requests to a degraded desktop, so
         * the degraded chain ends there and the periodic chain carries on alone.
         */
        internal fun shouldScheduleDegradedRetry(streak: Int): Boolean =
            degradedRetryDelayMillis(streak) < PERIODIC_RECONCILIATION_MILLIS

        /**
         * Inside the degraded-retry worker its own unique work is RUNNING: append exactly one
         * successor (see [delayedWorkPolicy]; REPLACE would cancel it). From any other worker an
         * already pending degraded retry is kept, so frequent outbox wakes neither grow the chain
         * nor push the retry further out. Never REPLACE.
         */
        internal fun degradedRetryWorkPolicy(scheduledFromDegradedRetry: Boolean): ExistingWorkPolicy =
            if (scheduledFromDegradedRetry) ExistingWorkPolicy.APPEND_OR_REPLACE else ExistingWorkPolicy.KEEP

        internal fun immediateWorkName(reason: CoreBackgroundSyncReason): String =
            if (reason == CoreBackgroundSyncReason.OUTBOX_PENDING) UNIQUE_OUTBOX_SYNC else UNIQUE_SYNC

        /** Only a sync the user asked for shows a notification; the others stay silent. */
        internal fun immediateRequestIsUserVisible(reason: CoreBackgroundSyncReason): Boolean =
            reason == CoreBackgroundSyncReason.MANUAL

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

/**
 * Syncs the user asked for in this process, and how many of them a finished pass covered. A run
 * shows its progress while any request is still unserved, so a tap during a silent background run
 * makes that run visible instead of waiting behind it.
 */
internal class CoreUserSyncRequests {
    private val requested = AtomicLong(0)
    private val served = AtomicLong(0)

    fun request(): Long = requested.incrementAndGet()

    fun snapshot(): Long = requested.get()

    fun pending(): Boolean = served.get() < requested.get()

    /** [upTo] is the [snapshot] taken when the pass that served them started. */
    fun markServed(upTo: Long) {
        served.accumulateAndGet(upTo) { current, next -> maxOf(current, next) }
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
