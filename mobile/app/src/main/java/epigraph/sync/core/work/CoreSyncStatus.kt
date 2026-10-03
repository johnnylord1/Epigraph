package epigraph.sync.core.work

import android.content.Context
import androidx.work.WorkInfo
import androidx.work.WorkManager
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.pairing.CorePairingUiState
import epigraph.sync.core.pairing.EpigraphCorePairingController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.flow.map

/** Outcome persisted by the worker; the persisted names are the lowercase enum names. */
enum class CoreSyncRunState {
    OUTBOX_DRAINED,
    OUTBOX_DEFERRED,
    RETRY,
    NEEDS_PAIRING,
    NEEDS_USER_ACTION,
}

data class CoreSyncLastRun(
    val state: CoreSyncRunState,
    val reason: String?,
    val pendingCount: Long,
    val replica: CoreReplicaSyncOutcome?,
    val finishedAtMs: Long,
)

enum class CoreSyncActivity { IDLE, QUEUED, RUNNING, BACKING_OFF }

data class CoreWorkSnapshot(
    val state: WorkInfo.State,
    val runAttemptCount: Int,
    /** Only immediate wakes count as "queued"; the periodic reconciliation is always enqueued. */
    val immediate: Boolean,
)

/** Local outbox rows plus replica waits, and the subset the drainer parked as blocked. */
data class CoreSyncCounts(val unsettled: Long, val blocked: Long)

/**
 * What Settings shows. [Synced] carries no counts on purpose: it can only be produced when nothing
 * is unsettled, so the UI never reports "synced" while commands are still queued.
 */
sealed interface CoreSyncStatus {
    data object NotPaired : CoreSyncStatus
    data class Syncing(val counts: CoreSyncCounts) : CoreSyncStatus
    data class Queued(val counts: CoreSyncCounts) : CoreSyncStatus
    data class Retrying(val reason: String?, val counts: CoreSyncCounts) : CoreSyncStatus
    data class NeedsPairing(val counts: CoreSyncCounts) : CoreSyncStatus
    data class NeedsUserAction(val reason: CoreUserActionReason?, val counts: CoreSyncCounts) : CoreSyncStatus
    data class Blocked(val counts: CoreSyncCounts) : CoreSyncStatus
    data class Pending(val counts: CoreSyncCounts) : CoreSyncStatus
    data class Synced(val lastSyncAtMs: Long) : CoreSyncStatus

    /** Nothing is queued locally, but no drained run has confirmed it yet. */
    data object Idle : CoreSyncStatus
}

fun coreSyncActivity(works: List<CoreWorkSnapshot>): CoreSyncActivity = when {
    works.any { it.state == WorkInfo.State.RUNNING } -> CoreSyncActivity.RUNNING
    works.any { it.state == WorkInfo.State.ENQUEUED && it.runAttemptCount > 0 } -> CoreSyncActivity.BACKING_OFF
    works.any { it.state == WorkInfo.State.ENQUEUED && it.immediate } -> CoreSyncActivity.QUEUED
    else -> CoreSyncActivity.IDLE
}

fun resolveCoreSyncStatus(
    paired: Boolean,
    activity: CoreSyncActivity,
    counts: CoreSyncCounts,
    lastRun: CoreSyncLastRun?,
): CoreSyncStatus {
    if (!paired) return CoreSyncStatus.NotPaired
    when (activity) {
        CoreSyncActivity.RUNNING -> return CoreSyncStatus.Syncing(counts)
        CoreSyncActivity.BACKING_OFF -> return CoreSyncStatus.Retrying(lastRun?.retryReason(), counts)
        CoreSyncActivity.QUEUED -> return CoreSyncStatus.Queued(counts)
        CoreSyncActivity.IDLE -> Unit
    }
    when (lastRun?.state) {
        CoreSyncRunState.NEEDS_USER_ACTION -> return CoreSyncStatus.NeedsUserAction(
            CoreUserActionReason.entries.firstOrNull { it.name.equals(lastRun.reason, ignoreCase = true) },
            counts,
        )
        CoreSyncRunState.NEEDS_PAIRING -> return CoreSyncStatus.NeedsPairing(counts)
        CoreSyncRunState.RETRY -> return CoreSyncStatus.Retrying(lastRun.reason, counts)
        CoreSyncRunState.OUTBOX_DRAINED,
        CoreSyncRunState.OUTBOX_DEFERRED,
        -> when (lastRun.replica) {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION ->
                return CoreSyncStatus.NeedsUserAction(CoreUserActionReason.REPLICA_REJECTED, counts)
            CoreReplicaSyncOutcome.RETRY -> return CoreSyncStatus.Retrying(REPLICA_RETRY_REASON, counts)
            else -> Unit
        }
        null -> Unit
    }
    if (counts.blocked > 0) return CoreSyncStatus.Blocked(counts)
    if (counts.unsettled > 0) return CoreSyncStatus.Pending(counts)
    return if (lastRun?.state == CoreSyncRunState.OUTBOX_DRAINED) {
        CoreSyncStatus.Synced(lastRun.finishedAtMs)
    } else {
        CoreSyncStatus.Idle
    }
}

private fun CoreSyncLastRun.retryReason(): String? = when {
    state == CoreSyncRunState.RETRY -> reason
    replica == CoreReplicaSyncOutcome.RETRY -> REPLICA_RETRY_REASON
    else -> null
}

private const val REPLICA_RETRY_REASON = "replica"

fun CoreOutboxSyncOutcome.toLastRun(finishedAtMs: Long): CoreSyncLastRun = when (this) {
    is CoreOutboxSyncOutcome.OutboxDrained ->
        CoreSyncLastRun(CoreSyncRunState.OUTBOX_DRAINED, null, 0, replica, finishedAtMs)
    is CoreOutboxSyncOutcome.OutboxDeferred ->
        CoreSyncLastRun(CoreSyncRunState.OUTBOX_DEFERRED, null, pendingCount, replica, finishedAtMs)
    is CoreOutboxSyncOutcome.Retry ->
        CoreSyncLastRun(CoreSyncRunState.RETRY, reason.name.lowercase(), pendingCount, null, finishedAtMs)
    is CoreOutboxSyncOutcome.NeedsPairing ->
        CoreSyncLastRun(CoreSyncRunState.NEEDS_PAIRING, reason.name.lowercase(), pendingCount, null, finishedAtMs)
    is CoreOutboxSyncOutcome.NeedsUserAction ->
        CoreSyncLastRun(CoreSyncRunState.NEEDS_USER_ACTION, reason.name.lowercase(), pendingCount, null, finishedAtMs)
}

/** Survives WorkManager pruning so Settings can still explain the last background run. */
class CoreSyncRunStore(context: Context) {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val mutableLastRun = MutableStateFlow(read())
    val lastRun: StateFlow<CoreSyncLastRun?> = mutableLastRun.asStateFlow()

    fun record(run: CoreSyncLastRun) {
        preferences.edit()
            .putString(KEY_STATE, run.state.name.lowercase())
            .putString(KEY_REASON, run.reason)
            .putLong(KEY_PENDING, run.pendingCount)
            .putString(KEY_REPLICA, run.replica?.name?.lowercase())
            .putLong(KEY_FINISHED_AT, run.finishedAtMs)
            .apply()
        mutableLastRun.value = run
    }

    private fun read(): CoreSyncLastRun? {
        val state = preferences.getString(KEY_STATE, null)
            ?.let { stored -> CoreSyncRunState.entries.firstOrNull { it.name.equals(stored, ignoreCase = true) } }
            ?: return null
        val replica = preferences.getString(KEY_REPLICA, null)
            ?.let { stored -> CoreReplicaSyncOutcome.entries.firstOrNull { it.name.equals(stored, ignoreCase = true) } }
        return CoreSyncLastRun(
            state = state,
            reason = preferences.getString(KEY_REASON, null),
            pendingCount = preferences.getLong(KEY_PENDING, 0),
            replica = replica,
            finishedAtMs = preferences.getLong(KEY_FINISHED_AT, 0),
        )
    }

    private companion object {
        const val PREFERENCES_NAME = "epigraph_core_sync_status"
        const val KEY_STATE = "last_state"
        const val KEY_REASON = "last_reason"
        const val KEY_PENDING = "last_pending_count"
        const val KEY_REPLICA = "last_replica"
        const val KEY_FINISHED_AT = "last_finished_at"
    }
}

class CoreSyncStatusMonitor(
    private val context: Context,
    private val runs: CoreSyncRunStore,
    private val coordinator: EpigraphMutationCoordinator,
    private val pairing: EpigraphCorePairingController,
    private val scheduler: CoreBackgroundSyncScheduler,
) {
    fun status(pollMillis: Long = COUNT_POLL_MILLIS): Flow<CoreSyncStatus> {
        val activity = WorkManager.getInstance(context.applicationContext)
            .getWorkInfosByTagFlow(EpigraphCoreSyncWorker.TAG)
            .map { infos ->
                coreSyncActivity(
                    infos.map { info ->
                        CoreWorkSnapshot(
                            state = info.state,
                            runAttemptCount = info.runAttemptCount,
                            immediate = EpigraphCoreSyncWorker.IMMEDIATE_TAG in info.tags,
                        )
                    },
                )
            }
        val counts = flow {
            while (true) {
                emit(readCounts())
                delay(pollMillis)
            }
        }.distinctUntilChanged()
        return combine(
            pairing.state.map { it is CorePairingUiState.Paired },
            activity,
            counts,
            runs.lastRun,
        ) { paired, currentActivity, currentCounts, lastRun ->
            resolveCoreSyncStatus(paired, currentActivity, currentCounts, lastRun)
        }
            .distinctUntilChanged()
            .flowOn(Dispatchers.IO)
    }

    suspend fun syncNow() {
        coordinator.releaseRetryBackoff(System.currentTimeMillis())
        scheduler.enqueue(CoreBackgroundSyncReason.MANUAL)
    }

    private suspend fun readCounts(): CoreSyncCounts = try {
        CoreSyncCounts(unsettled = coordinator.unsettledCount(), blocked = coordinator.blockedCount())
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        // An unreadable outbox must never look settled.
        CoreSyncCounts(unsettled = Long.MAX_VALUE, blocked = 0)
    }

    private companion object {
        const val COUNT_POLL_MILLIS = 2_000L
    }
}
