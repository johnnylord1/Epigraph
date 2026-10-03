package epigraph.sync.core.work

import epigraph.sync.core.events.CoreBackgroundSyncReason
import androidx.work.ExistingWorkPolicy
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class CoreConnectivityWakeTrackerTest {
    @Test
    fun `initial availability does not duplicate app start wake`() {
        val dispatched = mutableListOf<CoreBackgroundSyncReason>()
        val tracker = CoreConnectivityWakeTracker(dispatched::add)

        tracker.onAvailable()

        assertEquals(emptyList<CoreBackgroundSyncReason>(), dispatched)
    }

    @Test
    fun `availability after loss emits one restored wake`() {
        val dispatched = mutableListOf<CoreBackgroundSyncReason>()
        val tracker = CoreConnectivityWakeTracker(dispatched::add)

        tracker.onUnavailable()
        tracker.onAvailable()
        tracker.onAvailable()

        assertEquals(listOf(CoreBackgroundSyncReason.CONNECTIVITY_RESTORED), dispatched)
    }

    @Test
    fun `outbox writes use their own coalesced work slot`() {
        assertNotEquals(
            EpigraphCoreSyncWorker.immediateWorkName(CoreBackgroundSyncReason.OUTBOX_PENDING),
            EpigraphCoreSyncWorker.immediateWorkName(CoreBackgroundSyncReason.CONNECTIVITY_RESTORED),
        )
        assertEquals(750L, EpigraphCoreSyncWorker.immediateDelayMillis(CoreBackgroundSyncReason.OUTBOX_PENDING))
        assertEquals(0L, EpigraphCoreSyncWorker.immediateDelayMillis(CoreBackgroundSyncReason.CONNECTIVITY_RESTORED))
    }

    @Test
    fun `only current scheduler jobs may execute sync work`() {
        assertEquals(false, EpigraphCoreSyncWorker.isCurrentSchedulerVersion(0))
        assertEquals(false, EpigraphCoreSyncWorker.isCurrentSchedulerVersion(5))
        assertEquals(true, EpigraphCoreSyncWorker.isCurrentSchedulerVersion(6))
    }

    @Test
    fun `pairing and user action states do not self schedule`() {
        assertEquals(
            false,
            EpigraphCoreSyncWorker.shouldScheduleFollowUp(
                usesWorkManagerBackoff = false,
                awaitingExternalAction = true,
            ),
        )
        assertEquals(
            false,
            EpigraphCoreSyncWorker.shouldScheduleFollowUp(
                usesWorkManagerBackoff = true,
                awaitingExternalAction = false,
            ),
        )
        assertEquals(
            true,
            EpigraphCoreSyncWorker.shouldScheduleFollowUp(
                usesWorkManagerBackoff = false,
                awaitingExternalAction = false,
            ),
        )
    }

    @Test
    fun `recovery replaces stale backoff without cancelling active execution`() {
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            EpigraphCoreSyncWorker.immediateWorkPolicy(CoreBackgroundSyncReason.APP_START, executionActive = false),
        )
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            EpigraphCoreSyncWorker.immediateWorkPolicy(
                CoreBackgroundSyncReason.CONNECTIVITY_RESTORED,
                executionActive = false,
            ),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            EpigraphCoreSyncWorker.immediateWorkPolicy(CoreBackgroundSyncReason.APP_START, executionActive = true),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            EpigraphCoreSyncWorker.immediateWorkPolicy(CoreBackgroundSyncReason.OUTBOX_PENDING, executionActive = false),
        )
    }

    @Test
    fun `delayed reconciliation appends its successor without cancelling itself`() {
        assertEquals(
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            EpigraphCoreSyncWorker.delayedWorkPolicy(),
        )
    }

    @Test
    fun `next wake uses the earliest durable retry without exceeding reconciliation interval`() {
        assertEquals(1_500L, nextCoreWakeAt(now = 1_000, nextAttemptAt = 1_500, periodicIntervalMillis = 10_000))
        assertEquals(1_000L, nextCoreWakeAt(now = 1_000, nextAttemptAt = 500, periodicIntervalMillis = 10_000))
        assertEquals(11_000L, nextCoreWakeAt(now = 1_000, nextAttemptAt = null, periodicIntervalMillis = 10_000))
        assertEquals(11_000L, nextCoreWakeAt(now = 1_000, nextAttemptAt = 50_000, periodicIntervalMillis = 10_000))
    }
}
