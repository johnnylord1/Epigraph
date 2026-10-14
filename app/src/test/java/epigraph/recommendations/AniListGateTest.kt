package epigraph.recommendations

import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AniListGateTest {

    private fun TestScope.gate() = AniListGate(now = { testScheduler.currentTime })

    @Test
    fun `a burst never starts more than the minute allows`() = runTest {
        val gate = gate()
        val starts = mutableListOf<Long>()
        repeat(40) { launch { gate.schedule(AniListGate.Priority.FEED) { starts += testScheduler.currentTime } } }
        testScheduler.advanceUntilIdle()

        val allowed = AniListGate.DEFAULT_PER_MINUTE - AniListGate.RESERVED_PER_MINUTE
        assertEquals(40, starts.size)
        assertEquals(allowed, starts.count { it < AniListGate.WINDOW_MS })
        assertTrue(starts.drop(allowed).all { it >= AniListGate.WINDOW_MS })
    }

    @Test
    fun `rows are filled before lookups once the minute frees up`() = runTest {
        val gate = gate()
        repeat(AniListGate.DEFAULT_PER_MINUTE - AniListGate.RESERVED_PER_MINUTE) {
            gate.schedule(AniListGate.Priority.FEED) {}
        }
        val order = mutableListOf<String>()
        launch { gate.schedule(AniListGate.Priority.LOOKUP) { order += "lookup" } }
        launch { gate.schedule(AniListGate.Priority.FEED) { order += "feed" } }
        testScheduler.advanceUntilIdle()

        assertEquals(listOf("feed", "lookup"), order)
    }

    @Test
    fun `a 429 holds every request back for its Retry-After`() = runTest {
        val gate = gate()
        gate.schedule(AniListGate.Priority.FEED) { gate.observe(429, 30, null, 10) }
        var startedAt = -1L
        launch { gate.schedule(AniListGate.Priority.FEED) { startedAt = testScheduler.currentTime } }
        testScheduler.advanceUntilIdle()

        assertEquals(10_000L, startedAt)
    }

    @Test
    fun `AniList's own count of what is left is respected`() = runTest {
        val gate = gate()
        // Another client used the minute: AniList says only the reserved request is left.
        gate.schedule(AniListGate.Priority.FEED) { gate.observe(200, 30, AniListGate.RESERVED_PER_MINUTE, null) }
        var startedAt = -1L
        launch { gate.schedule(AniListGate.Priority.LOOKUP) { startedAt = testScheduler.currentTime } }
        testScheduler.advanceUntilIdle()

        assertEquals(AniListGate.WINDOW_MS, startedAt)
    }
}
