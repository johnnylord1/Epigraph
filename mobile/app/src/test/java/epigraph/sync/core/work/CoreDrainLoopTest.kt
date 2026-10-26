package epigraph.sync.core.work

import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport
import kotlinx.coroutines.test.runTest
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
}
