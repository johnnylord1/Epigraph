package epigraph.sync.core.work

import androidx.work.ExistingWorkPolicy
import androidx.work.WorkInfo
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.events.CoreBackgroundSyncReason
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreSyncStatusTest {
    private val nothing = CoreSyncCounts(unsettled = 0, blocked = 0)
    private val drained = CoreOutboxSyncOutcome.OutboxDrained(
        report = CoreOutboxDrainReport(0, 0, 0, 0, 0),
        replica = CoreReplicaSyncOutcome.APPLIED,
    ).toLastRun(finishedAtMs = 1_000)

    @Test
    fun `synced is reported only for a drained run with nothing unsettled`() {
        assertEquals(
            CoreSyncStatus.Synced(1_000),
            resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, nothing, drained),
        )
        val pending = CoreSyncCounts(unsettled = 3, blocked = 0)
        assertEquals(
            CoreSyncStatus.Pending(pending),
            resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, pending, drained),
        )
        assertEquals(
            CoreSyncStatus.Idle,
            resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, nothing, lastRun = null),
        )
    }

    @Test
    fun `no combination with unsettled work ever resolves to synced`() {
        val lastRuns = listOf(null, drained) + CoreSyncRunState.entries.map {
            CoreSyncLastRun(it, reason = null, pendingCount = 1, replica = CoreReplicaSyncOutcome.APPLIED, finishedAtMs = 5)
        }
        val counts = listOf(CoreSyncCounts(1, 0), CoreSyncCounts(2, 2), CoreSyncCounts(Long.MAX_VALUE, 0))
        for (activity in CoreSyncActivity.entries) {
            for (lastRun in lastRuns) {
                for (count in counts) {
                    val status = resolveCoreSyncStatus(true, activity, count, lastRun)
                    assertTrue(status !is CoreSyncStatus.Synced && status != CoreSyncStatus.Idle) {
                        "$activity $lastRun $count -> $status"
                    }
                }
            }
        }
    }

    @Test
    fun `active work and blockers take precedence over counts`() {
        val counts = CoreSyncCounts(unsettled = 2, blocked = 1)
        assertEquals(CoreSyncStatus.NotPaired, resolveCoreSyncStatus(false, CoreSyncActivity.RUNNING, counts, drained))
        assertEquals(CoreSyncStatus.Syncing(counts), resolveCoreSyncStatus(true, CoreSyncActivity.RUNNING, counts, drained))
        assertEquals(CoreSyncStatus.Queued(counts), resolveCoreSyncStatus(true, CoreSyncActivity.QUEUED, counts, drained))
        assertEquals(CoreSyncStatus.Blocked(counts), resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, counts, drained))

        val retry = CoreOutboxSyncOutcome.Retry(2, CoreOutboxRetryReason.CONNECTION).toLastRun(10)
        assertEquals(
            CoreSyncStatus.Retrying("connection", counts),
            resolveCoreSyncStatus(true, CoreSyncActivity.BACKING_OFF, counts, retry),
        )
        val pairing = CoreOutboxSyncOutcome.NeedsPairing(2, CorePairingRequirement.TOKEN_EXPIRED).toLastRun(10)
        assertEquals(CoreSyncStatus.NeedsPairing(counts), resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, counts, pairing))
    }

    @Test
    fun `blocked desktop projection is surfaced with its reason`() {
        val counts = CoreSyncCounts(unsettled = 0, blocked = 0)
        val blocked = CoreOutboxSyncOutcome.NeedsUserAction(
            0,
            CoreUserActionReason.REMOTE_PROJECTION_BLOCKED,
        ).toLastRun(10)

        assertEquals(
            CoreSyncStatus.NeedsUserAction(CoreUserActionReason.REMOTE_PROJECTION_BLOCKED, counts),
            resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, counts, blocked),
        )
        val replicaRejected = CoreOutboxSyncOutcome.OutboxDrained(
            CoreOutboxDrainReport(0, 0, 0, 0, 0),
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION,
        ).toLastRun(10)
        assertEquals(
            CoreSyncStatus.NeedsUserAction(CoreUserActionReason.REPLICA_REJECTED, counts),
            resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, counts, replicaRejected),
        )
    }

    @Test
    fun `periodic reconciliation alone does not look like a queued sync`() {
        val periodic = CoreWorkSnapshot(WorkInfo.State.ENQUEUED, runAttemptCount = 0, immediate = false)
        assertEquals(CoreSyncActivity.IDLE, coreSyncActivity(listOf(periodic)))
        assertEquals(
            CoreSyncActivity.QUEUED,
            coreSyncActivity(listOf(periodic, CoreWorkSnapshot(WorkInfo.State.ENQUEUED, 0, immediate = true))),
        )
        assertEquals(
            CoreSyncActivity.BACKING_OFF,
            coreSyncActivity(listOf(CoreWorkSnapshot(WorkInfo.State.ENQUEUED, 2, immediate = true))),
        )
        assertEquals(
            CoreSyncActivity.RUNNING,
            coreSyncActivity(listOf(periodic, CoreWorkSnapshot(WorkInfo.State.RUNNING, 0, immediate = false))),
        )
        assertEquals(
            CoreSyncActivity.IDLE,
            coreSyncActivity(listOf(CoreWorkSnapshot(WorkInfo.State.SUCCEEDED, 0, immediate = true))),
        )
    }

    @Test
    fun `manual sync runs immediately and replaces an idle queued wake`() {
        assertEquals(0L, EpigraphCoreSyncWorker.immediateDelayMillis(CoreBackgroundSyncReason.MANUAL))
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            EpigraphCoreSyncWorker.immediateWorkPolicy(CoreBackgroundSyncReason.MANUAL, executionActive = false),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            EpigraphCoreSyncWorker.immediateWorkPolicy(CoreBackgroundSyncReason.MANUAL, executionActive = true),
        )
    }
}
