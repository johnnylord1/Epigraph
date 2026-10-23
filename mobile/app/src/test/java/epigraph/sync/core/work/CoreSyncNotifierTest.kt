package epigraph.sync.core.work

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
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
}
