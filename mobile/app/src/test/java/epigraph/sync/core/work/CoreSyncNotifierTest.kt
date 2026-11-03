package epigraph.sync.core.work

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assertions.assertNull
import yokai.i18n.MR
import org.junit.jupiter.api.Test

class CoreSyncNotifierTest {
    private fun run(
        state: CoreSyncRunState,
        reason: String? = null,
        replica: CoreReplicaSyncOutcome? = null,
    ) = CoreSyncLastRun(state, reason, pendingCount = 0, replica = replica, finishedAtMs = 1_000)

    @Test
    fun `a clean run clears the notice and a transient failure keeps it`() {
        assertEquals(
            CoreSyncNoticeUpdate.Clear,
            coreSyncNoticeUpdate(run(CoreSyncRunState.OUTBOX_DRAINED, replica = CoreReplicaSyncOutcome.APPLIED)),
        )
        assertEquals(
            CoreSyncNoticeUpdate.Clear,
            coreSyncNoticeUpdate(run(CoreSyncRunState.OUTBOX_DEFERRED, replica = CoreReplicaSyncOutcome.RETRY)),
        )
        assertEquals(CoreSyncNoticeUpdate.Keep, coreSyncNoticeUpdate(run(CoreSyncRunState.RETRY, "connection")))
    }

    @Test
    fun `forgetting the desktop never raises a notice but a lost pairing does`() {
        assertEquals(
            CoreSyncNoticeUpdate.Clear,
            coreSyncNoticeUpdate(run(CoreSyncRunState.NEEDS_PAIRING, "not_paired")),
        )
        listOf("token_expired", "credential_unreadable", "identity_mismatch").forEach { reason ->
            assertEquals(
                CoreSyncNoticeUpdate.Show(CoreSyncNotice.PAIR_AGAIN),
                coreSyncNoticeUpdate(run(CoreSyncRunState.NEEDS_PAIRING, reason)),
            )
        }
    }

    @Test
    fun `runs the user must act on ask for attention`() {
        assertEquals(
            CoreSyncNoticeUpdate.Show(CoreSyncNotice.NEEDS_ATTENTION),
            coreSyncNoticeUpdate(run(CoreSyncRunState.NEEDS_USER_ACTION, "core_incompatible")),
        )
        assertEquals(
            CoreSyncNoticeUpdate.Show(CoreSyncNotice.NEEDS_ATTENTION),
            coreSyncNoticeUpdate(
                run(CoreSyncRunState.OUTBOX_DRAINED, replica = CoreReplicaSyncOutcome.NEEDS_USER_ACTION),
            ),
        )
    }

    @Test
    fun `progress only moves forward and shows no count while fetching`() {
        val first = coreSyncProgress(peak = 0, remaining = 40)
        assertEquals(CoreSyncProgress(max = 40, done = 0, remaining = 40), first)
        assertFalse(first.indeterminate)

        assertEquals(CoreSyncProgress(max = 40, done = 30, remaining = 10), coreSyncProgress(peak = 40, remaining = 10))
        // New changes while syncing raise the total instead of moving the bar back.
        assertEquals(CoreSyncProgress(max = 50, done = 0, remaining = 50), coreSyncProgress(peak = 40, remaining = 50))

        val fetching = coreSyncProgress(peak = 40, remaining = 0)
        assertTrue(fetching.indeterminate)
        assertTrue(coreSyncProgress(peak = 0, remaining = -1).indeterminate)
    }

    @Test
    fun `huge counts stay within the notification range`() {
        val progress = coreSyncProgress(peak = 0, remaining = Long.MAX_VALUE)
        assertEquals(Int.MAX_VALUE, progress.max)
        assertEquals(0, progress.done)
    }

    @Test
    fun `each phase fills its own share and the bar never moves back or reaches 100 while running`() {
        val nothing = coreSyncProgress(peak = 0, remaining = 0)
        assertEquals(0, coreSyncRunPercent(CoreSyncPhase.LIBRARY, nothing, floor = 0))
        assertEquals(33, coreSyncRunPercent(CoreSyncPhase.EXCHANGE, nothing, floor = 0))
        assertEquals(66, coreSyncRunPercent(CoreSyncPhase.READING_PROGRESS, nothing, floor = 0))

        val halfSent = coreSyncProgress(peak = 10, remaining = 5)
        assertEquals(49, coreSyncRunPercent(CoreSyncPhase.EXCHANGE, halfSent, floor = 0))

        // A second pass starts again at the library phase; the bar holds where the first one got.
        assertEquals(60, coreSyncRunPercent(CoreSyncPhase.LIBRARY, nothing, floor = 60))

        val allSent = coreSyncProgress(peak = 4, remaining = 0)
        assertEquals(99, coreSyncRunPercent(CoreSyncPhase.READING_PROGRESS, allSent, floor = 99))
        assertEquals(95, coreSyncRunPercent(CoreSyncPhase.READING_PROGRESS, coreSyncProgress(8, 1), floor = 0))
        assertEquals(99, coreSyncRunPercent(CoreSyncPhase.READING_PROGRESS, coreSyncProgress(100, 1), floor = 0))
    }

    @Test
    fun `run progress survives the work data round trip and foreign progress reads as none`() {
        val progress = CoreSyncRunProgress(CoreSyncPhase.READING_PROGRESS, percent = 72, remaining = 14, userVisible = true)
        assertEquals(progress, progress.toWorkData().toCoreSyncRunProgress())
        assertNull(androidx.work.workDataOf("state" to "retry", "reason" to "connection").toCoreSyncRunProgress())
    }

    @Test
    fun `the result says synced only when nothing is left to send`() {
        val clean = CoreSyncCounts(unsettled = 0, blocked = 0)
        val drained = run(CoreSyncRunState.OUTBOX_DRAINED, replica = CoreReplicaSyncOutcome.APPLIED)
        fun result(counts: CoreSyncCounts, last: CoreSyncLastRun?) =
            coreSyncResult(resolveCoreSyncStatus(true, CoreSyncActivity.IDLE, counts, last))

        assertEquals(CoreSyncResult.Synced, result(clean, drained))
        assertEquals(CoreSyncResult.Pending(3), result(CoreSyncCounts(unsettled = 3, blocked = 0), drained))
        assertEquals(CoreSyncResult.Blocked(2), result(CoreSyncCounts(unsettled = 5, blocked = 2), drained))
        assertEquals(CoreSyncResult.Finished, result(clean, run(CoreSyncRunState.OUTBOX_DEFERRED)))
        assertEquals(CoreSyncResult.WillRetry, result(clean, run(CoreSyncRunState.RETRY, "connection")))
        // These raise the attention notice instead.
        assertNull(result(clean, run(CoreSyncRunState.NEEDS_PAIRING, "token_expired")))
        assertNull(result(clean, run(CoreSyncRunState.NEEDS_USER_ACTION, "remote_projection_blocked")))
    }

    @Test
    fun `a change count wins over the phase text`() {
        fun text(phase: CoreSyncPhase, remaining: Long) =
            coreSyncPhaseText(CoreSyncRunProgress(phase, percent = 10, remaining = remaining, userVisible = true))

        assertEquals(MR.strings.epigraph_core_sync_notification_remaining, text(CoreSyncPhase.EXCHANGE, 4))
        assertEquals(MR.strings.epigraph_core_sync_notification_preparing, text(CoreSyncPhase.LIBRARY, 0))
        assertEquals(MR.strings.epigraph_core_sync_notification_fetching, text(CoreSyncPhase.EXCHANGE, 0))
        assertEquals(MR.strings.epigraph_core_sync_notification_reading_progress, text(CoreSyncPhase.READING_PROGRESS, 0))
    }
}
