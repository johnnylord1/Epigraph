package epigraph.sync.core.work

import androidx.work.ExistingWorkPolicy
import androidx.work.WorkRequest
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.test.runTest
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
    fun `a wake after the last drain gets a follow-up appended behind the finishing worker`() {
        assertTrue(scheduler.missedWakeAfterDrain(drainedGeneration = 4, currentGeneration = 5, usesWorkManagerBackoff = false))
        // No wake since the last drain, a run that never drained, or a run that backs off by itself.
        assertFalse(scheduler.missedWakeAfterDrain(drainedGeneration = 5, currentGeneration = 5, usesWorkManagerBackoff = false))
        assertFalse(scheduler.missedWakeAfterDrain(drainedGeneration = null, currentGeneration = 5, usesWorkManagerBackoff = false))
        assertFalse(scheduler.missedWakeAfterDrain(drainedGeneration = 4, currentGeneration = 5, usesWorkManagerBackoff = true))
        assertEquals(ExistingWorkPolicy.APPEND_OR_REPLACE, scheduler.followUpWorkPolicy())
    }

    @Test
    fun `a pass leaves the progress backfill to the next pass only when one will run`() {
        assertTrue(scheduler.deferProgressBackfill(pass = 0, passGeneration = 4, currentGeneration = 5))
        assertTrue(scheduler.deferProgressBackfill(pass = 2, passGeneration = 4, currentGeneration = 5))
        // No newer wake, or the last pass allowed by the drain cap.
        assertFalse(scheduler.deferProgressBackfill(pass = 0, passGeneration = 5, currentGeneration = 5))
        assertFalse(scheduler.deferProgressBackfill(pass = 3, passGeneration = 4, currentGeneration = 5))
    }

    @Test
    fun `a desktop still applying earlier changes counts as answered for the progress backfill`() {
        assertTrue(scheduler.coreAnswered(CoreOutboxSyncOutcome.Retry(0, CoreOutboxRetryReason.OUTBOX_PENDING)))
        assertTrue(scheduler.coreAnswered(CoreOutboxSyncOutcome.NeedsUserAction(0, CoreUserActionReason.REMOTE_PROJECTION_BLOCKED)))
        // A failed run gives the backfill nothing to check against.
        listOf(
            CoreOutboxRetryReason.CONNECTION,
            CoreOutboxRetryReason.CAPABILITIES,
            CoreOutboxRetryReason.CREDENTIAL_IO,
            CoreOutboxRetryReason.REPLICA,
            CoreOutboxRetryReason.SUWAYOMI,
        ).forEach { reason ->
            assertFalse(scheduler.coreAnswered(CoreOutboxSyncOutcome.Retry(0, reason)), reason.name)
        }
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
    fun `a desktop still applying the upload is polled within seconds and backs off only when stalled`() {
        val delays = (0..12).map { scheduler.degradedRetryDelayMillis(it, desktopApplying = true) }

        assertEquals(EpigraphCoreSyncWorker.DESKTOP_APPLYING_POLL_MILLIS, delays[0])
        assertTrue(delays[0] < WorkRequest.MIN_BACKOFF_MILLIS)
        assertEquals(2 * EpigraphCoreSyncWorker.DESKTOP_APPLYING_POLL_MILLIS, delays[1])
        assertTrue(delays.zipWithNext().all { (a, b) -> a <= b })
        assertTrue(scheduler.degradedRetryDelayMillis(Int.MAX_VALUE, desktopApplying = true) <= 15 * 60 * 1_000L)
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
    fun `degraded retry starts over only when fewer rows are pending than after the last one`() {
        // First degraded run of the process: nothing to compare against.
        assertFalse(scheduler.degradedRetryMadeProgress(previousPending = -1, pending = 19_590))
        assertTrue(scheduler.degradedRetryMadeProgress(previousPending = 19_590, pending = 19_340))
        assertFalse(scheduler.degradedRetryMadeProgress(previousPending = 19_590, pending = 19_590))
        assertFalse(scheduler.degradedRetryMadeProgress(previousPending = 19_340, pending = 19_400))
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

    @Test
    fun `only a sync the user asks for is visible and it is never delayed`() {
        assertTrue(scheduler.immediateRequestIsUserVisible(CoreBackgroundSyncReason.MANUAL))
        assertEquals(0, scheduler.immediateDelayMillis(CoreBackgroundSyncReason.MANUAL))
        listOf(
            CoreBackgroundSyncReason.APP_START,
            CoreBackgroundSyncReason.CONNECTIVITY_RESTORED,
            CoreBackgroundSyncReason.PERIODIC_RECONCILIATION,
            CoreBackgroundSyncReason.OUTBOX_PENDING,
        ).forEach { reason -> assertFalse(scheduler.immediateRequestIsUserVisible(reason), reason.name) }
    }

    @Test
    fun `a request stays pending until a pass that started after it ends`() {
        val requests = CoreUserSyncRequests()
        assertFalse(requests.pending())

        requests.request()
        val passStart = requests.snapshot()
        assertTrue(requests.pending())
        // Asked again while that pass ran: the pass does not cover it.
        requests.request()
        requests.markServed(passStart)
        assertTrue(requests.pending())

        requests.markServed(requests.snapshot())
        assertFalse(requests.pending())
        // A late, older snapshot never brings a served request back.
        requests.markServed(passStart)
        assertFalse(requests.pending())
    }

    @Test
    fun `progress backfill keeps sending while Core answers and rows are left`() = runTest {
        val drained = CoreOutboxSyncOutcome.OutboxDrained(
            CoreOutboxDrainReport(0, 0, 0, 0, 0),
            CoreReplicaSyncOutcome.APPLIED,
        )
        val queued = ArrayDeque(listOf(2_000, 2_000, 700, 0))
        var runs = 0
        val sent = scheduler.sendProgressBackfill(
            first = drained,
            backfill = { reachable, _ ->
                assertTrue(reachable)
                queued.removeFirst()
            },
            run = {
                runs += 1
                CoreOutboxSyncOutcome.Retry(0, CoreOutboxRetryReason.OUTBOX_PENDING)
            },
        )
        assertEquals(3, runs)
        assertTrue(sent.sentAny)
        assertTrue(queued.isEmpty())
        assertEquals(CoreOutboxSyncOutcome.Retry(0, CoreOutboxRetryReason.OUTBOX_PENDING), sent.outcome)
    }

    @Test
    fun `progress backfill stops sending once Core stops answering and is bounded`() = runTest {
        val offline = CoreOutboxSyncOutcome.Retry(5, CoreOutboxRetryReason.CONNECTION)
        var backfills = 0
        var runs = 0
        // Core did not answer: queue for the next run, send nothing.
        val queuedOnly = scheduler.sendProgressBackfill(
            first = offline,
            backfill = { reachable, _ ->
                assertFalse(reachable)
                backfills += 1
                10
            },
            run = { runs += 1; offline },
        )
        assertEquals(1, backfills)
        assertEquals(0, runs)
        assertFalse(queuedOnly.sentAny)
        // Core went away after the first send: no further backfill.
        backfills = 0
        val drained = CoreOutboxSyncOutcome.OutboxDrained(
            CoreOutboxDrainReport(0, 0, 0, 0, 0),
            CoreReplicaSyncOutcome.APPLIED,
        )
        val dropped = scheduler.sendProgressBackfill(
            first = drained,
            backfill = { _, _ -> backfills += 1; 10 },
            run = { runs += 1; offline },
        )
        assertEquals(1, backfills)
        assertEquals(1, runs)
        assertTrue(dropped.sentAny)
        assertEquals(offline, dropped.outcome)
        // A backfill that never runs dry stops at the pass cap.
        runs = 0
        scheduler.sendProgressBackfill(
            first = drained,
            maxPasses = 3,
            backfill = { _, _ -> 10 },
            run = { runs += 1; drained },
        )
        assertEquals(3, runs)
    }

    @Test
    fun `progress backfill starts sending with its first queued batch`() = runTest {
        val drained = CoreOutboxSyncOutcome.OutboxDrained(
            CoreOutboxDrainReport(0, 0, 0, 0, 0),
            CoreReplicaSyncOutcome.APPLIED,
        )
        val events = mutableListOf<String>()
        val scans = ArrayDeque(listOf(400, 0))
        val gate = CompletableDeferred<Unit>()
        val sent = scheduler.sendProgressBackfill(
            first = drained,
            backfill = { _, onQueued ->
                val queued = scans.removeFirst()
                if (queued > 0) {
                    events += "batch"
                    onQueued()
                    // The send runs while the scan is still going.
                    gate.await()
                    events += "scan end"
                }
                queued
            },
            run = {
                events += "run"
                gate.complete(Unit)
                drained
            },
        )
        // The overlapping send, then one for the rows queued after its drain, then a dry scan.
        assertEquals(listOf("batch", "run", "scan end", "run"), events)
        assertTrue(sent.sentAny)
        assertEquals(drained, sent.outcome)
    }

    @Test
    fun `progress backfill that queues nothing sends nothing`() = runTest {
        val drained = CoreOutboxSyncOutcome.OutboxDrained(
            CoreOutboxDrainReport(0, 0, 0, 0, 0),
            CoreReplicaSyncOutcome.APPLIED,
        )
        var runs = 0
        val sent = scheduler.sendProgressBackfill(
            first = drained,
            backfill = { _, _ -> 0 },
            run = { runs += 1; drained },
        )
        assertEquals(0, runs)
        assertFalse(sent.sentAny)
    }
}
