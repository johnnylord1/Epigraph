package epigraph.sync.core.work

import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.yield
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreDrainLoopTest {
    @Test
    fun `blocked book asset remains pending without spinning or releasing metadata`() = runTest {
        var batches = 0

        val result = drainCoreBacklog(
            countPending = { 2 },
            drainBatch = {
                batches += 1
                CoreDrainBatch(
                    assets = epigraph.sync.core.assets.BookAssetDrainReport(1, 0, 0, 1),
                    suwayomi = SuwayomiMutationDrainReport(0, 0, 0, 0, 0),
                    core = CoreOutboxDrainReport(0, 0, 0, 0, 0),
                )
            },
        )

        assertEquals(1, batches)
        assertEquals(2, result.pendingCount)
        assertFalse(result.transientFailure)
    }

    @Test
    fun `healthy backlog drains across multiple batches without deferral`() = runTest {
        var pending = 53L
        var batches = 0

        val result = drainCoreBacklog(
            countPending = { pending },
            drainBatch = {
                batches += 1
                val settled = minOf(8L, pending).toInt()
                pending -= settled
                CoreDrainBatch(
                    suwayomi = SuwayomiMutationDrainReport(settled, settled, 0, 0, pending),
                    core = CoreOutboxDrainReport(0, 0, 0, 0, 0),
                )
            },
        )

        assertEquals(7, batches)
        assertEquals(0, result.pendingCount)
        assertFalse(result.transientFailure)
    }

    @Test
    fun `reports between batches only while more rows remain`() = runTest {
        var pending = 20L
        val seen = mutableListOf<Long>()

        drainCoreBacklog(
            countPending = { pending },
            drainBatch = {
                val settled = minOf(8L, pending).toInt()
                pending -= settled
                CoreDrainBatch(
                    suwayomi = SuwayomiMutationDrainReport(settled, settled, 0, 0, pending),
                    core = CoreOutboxDrainReport(0, 0, 0, 0, 0),
                )
            },
            onBatchWithMorePending = { seen += pending },
        )

        assertEquals(listOf(12L, 4L), seen)
    }

    @Test
    fun `delayed backlog defers successfully when no ready row can progress`() = runTest {
        val result = drainCoreBacklog(
            countPending = { 5 },
            drainBatch = {
                CoreDrainBatch(
                    suwayomi = SuwayomiMutationDrainReport(0, 0, 0, 0, 5),
                    core = CoreOutboxDrainReport(0, 0, 0, 0, 0),
                )
            },
        )

        assertEquals(5, result.pendingCount)
        assertFalse(result.transientFailure)
    }

    @Test
    fun `actual transient failure remains retryable`() = runTest {
        val result = drainCoreBacklog(
            countPending = { 1 },
            drainBatch = {
                CoreDrainBatch(
                    suwayomi = SuwayomiMutationDrainReport(1, 0, 1, 0, 1),
                    core = CoreOutboxDrainReport(0, 0, 0, 0, 0),
                )
            },
        )

        assertEquals(1, result.pendingCount)
        assertTrue(result.transientFailure)
        assertFalse(result.coreTransientFailure)
    }

    @Test
    fun `core row transient failure is not mistaken for a comic-only failure`() = runTest {
        val result = drainCoreBacklog(
            countPending = { 2 },
            drainBatch = {
                CoreDrainBatch(
                    suwayomi = SuwayomiMutationDrainReport(1, 0, 1, 0, 1),
                    core = CoreOutboxDrainReport(1, 1, 0, 1, 0),
                )
            },
        )

        assertTrue(result.transientFailure)
        assertTrue(result.coreTransientFailure)
    }

    @Test
    fun `backfill rows are sent while they are queued and passes stop once one queues nothing`() = runTest {
        var waiting = 0
        var sent = 0
        val sentWhileQueueing = mutableListOf<Int>()
        var passes = 0
        var queueing = false

        val result = drainWhileQueueing(
            maxPasses = 5,
            queue = { onQueued ->
                passes += 1
                if (passes > 1) return@drainWhileQueueing 0
                queueing = true
                repeat(3) {
                    waiting += 10
                    onQueued()
                    yield()
                }
                queueing = false
                30
            },
            drain = {
                val batch = waiting
                waiting = 0
                sent += batch
                if (queueing) sentWhileQueueing += batch
                CoreDrainLoopResult(CoreOutboxDrainReport(batch, batch, batch, 0, 0), 0, false, false)
            },
        )

        assertEquals(2, passes)
        assertEquals(30, sent)
        assertTrue(sentWhileQueueing.isNotEmpty())
        assertEquals(30, result?.report?.acknowledged)
        assertEquals(0, result?.pendingCount)
    }

    @Test
    fun `a backfill that must not run sends nothing`() = runTest {
        var drains = 0

        val result = drainWhileQueueing(
            maxPasses = 5,
            queue = { null },
            drain = {
                drains += 1
                CoreDrainLoopResult(CoreOutboxDrainReport(0, 0, 0, 0, 0), 0, false, false)
            },
        )

        assertEquals(0, drains)
        assertEquals(null, result)
    }

    @Test
    fun `a desktop that fails a drain is not asked again for the rest of the backfill`() = runTest {
        var drains = 0
        var passes = 0

        val result = drainWhileQueueing(
            maxPasses = 5,
            queue = { onQueued ->
                passes += 1
                repeat(4) {
                    onQueued()
                    yield()
                }
                40
            },
            drain = {
                drains += 1
                CoreDrainLoopResult(CoreOutboxDrainReport(10, 10, 0, 10, 0), 40, true, true)
            },
        )

        assertEquals(1, drains)
        assertEquals(1, passes)
        assertTrue(result!!.coreTransientFailure)
        assertEquals(40, result.pendingCount)
    }

    @Test
    fun `a failing backfill ends the drain it started`() = runTest {
        val failure = runCatching {
            drainWhileQueueing(
                maxPasses = 5,
                queue = { onQueued ->
                    onQueued()
                    error("scan failed")
                },
                drain = { CoreDrainLoopResult(CoreOutboxDrainReport(0, 0, 0, 0, 0), 0, false, false) },
            )
        }.exceptionOrNull()

        assertTrue(failure is IllegalStateException)
    }
}
