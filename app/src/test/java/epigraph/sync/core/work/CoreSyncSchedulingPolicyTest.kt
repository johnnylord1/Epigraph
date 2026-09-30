package epigraph.sync.core.work

import androidx.work.ExistingWorkPolicy
import androidx.work.WorkRequest
import epigraph.sync.core.events.CoreBackgroundSyncReason
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreSyncSchedulingPolicyTest {
    private val scheduler = EpigraphCoreSyncWorker.Companion

    @Test
    fun `outbox wakes coalesce on their own unique work and never cancel a running worker`() {
        assertEquals(
            ExistingWorkPolicy.KEEP,
            scheduler.immediateWorkPolicy(CoreBackgroundSyncReason.OUTBOX_PENDING, executionActive = false),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            scheduler.immediateWorkPolicy(CoreBackgroundSyncReason.OUTBOX_PENDING, executionActive = true),
        )
        assertNotEquals(
            scheduler.immediateWorkName(CoreBackgroundSyncReason.OUTBOX_PENDING),
            scheduler.immediateWorkName(CoreBackgroundSyncReason.MANUAL),
        )
    }

    @Test
    fun `other wakes replace only when no worker is executing`() {
        assertEquals(
            ExistingWorkPolicy.REPLACE,
            scheduler.immediateWorkPolicy(CoreBackgroundSyncReason.MANUAL, executionActive = false),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            scheduler.immediateWorkPolicy(CoreBackgroundSyncReason.MANUAL, executionActive = true),
        )
    }

    @Test
    fun `delayed chain appends behind a running reconciliation instead of replacing it`() {
        assertEquals(ExistingWorkPolicy.APPEND_OR_REPLACE, scheduler.delayedWorkPolicy())
    }

    @Test
    fun `failures that stop the outbox itself keep WorkManager backoff`() {
        listOf(
            CoreOutboxRetryReason.CONNECTION,
            CoreOutboxRetryReason.CAPABILITIES,
            CoreOutboxRetryReason.CREDENTIAL_IO,
        ).forEach { reason ->
            assertTrue(scheduler.retryUsesWorkManagerBackoff(reason), reason.name)
        }
        assertFalse(scheduler.shouldScheduleFollowUp(usesWorkManagerBackoff = true, awaitingExternalAction = false))
    }

    @Test
    fun `comic-side failures never park the outbox work in WorkManager backoff`() {
        // Suwayomi catalog 503, replica retry and desktop projection still pending all happen after
        // the book/novel outbox drained. They must leave the outbox unique work finished so the next
        // OUTBOX_PENDING wake (KEEP) runs after its debounce instead of after the backoff.
        listOf(
            CoreOutboxRetryReason.REPLICA,
            CoreOutboxRetryReason.SUWAYOMI,
            CoreOutboxRetryReason.OUTBOX_PENDING,
        ).forEach { reason ->
            assertFalse(scheduler.retryUsesWorkManagerBackoff(reason), reason.name)
        }
        // Such a run still keeps the regular reconciliation as a safety net.
        assertTrue(scheduler.shouldScheduleFollowUp(usesWorkManagerBackoff = false, awaitingExternalAction = false))
    }

    @Test
    fun `degraded retry keeps the backoff cadence but is capped at the periodic reconciliation`() {
        val delays = (0..12).map(scheduler::degradedRetryDelayMillis)

        assertEquals(WorkRequest.MIN_BACKOFF_MILLIS, delays[0])
        assertEquals(2 * WorkRequest.MIN_BACKOFF_MILLIS, delays[1])
        assertEquals(4 * WorkRequest.MIN_BACKOFF_MILLIS, delays[2])
        assertEquals(15 * 60 * 1_000L, delays.last())
        assertTrue(delays.zipWithNext().all { (a, b) -> a <= b })
        assertEquals(15 * 60 * 1_000L, scheduler.degradedRetryDelayMillis(Int.MAX_VALUE))
    }

    @Test
    fun `degraded retry chain ends where the periodic follow-up already covers it`() {
        val scheduled = (0..12).map(scheduler::shouldScheduleDegradedRetry)

        // 10 s .. 640 s precede the 15-minute periodic wake; from the cap on it would duplicate it.
        assertTrue(scheduled.take(7).all { it })
        assertTrue(scheduled.drop(7).none { it })
        assertFalse(scheduler.shouldScheduleDegradedRetry(Int.MAX_VALUE))
    }

    @Test
    fun `degraded retry chain never replaces and does not grow from outside wakes`() {
        assertEquals(
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            scheduler.degradedRetryWorkPolicy(scheduledFromDegradedRetry = true),
        )
        assertEquals(
            ExistingWorkPolicy.KEEP,
            scheduler.degradedRetryWorkPolicy(scheduledFromDegradedRetry = false),
        )
    }
}
