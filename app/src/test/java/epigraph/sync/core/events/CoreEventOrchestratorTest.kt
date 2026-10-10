package epigraph.sync.core.events

import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreReplaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreEventOrchestratorTest {
    @Test
    fun `reconnect waits for network and backoff while bootstrap replaces session`() = runTest {
        val initial = session(4)
        val bootstrapped = session(20)
        var networkWaits = 0
        val retries = mutableListOf<Pair<Int, CoreReconnectReason>>()
        val seenCursors = mutableListOf<Long>()
        var connections = 0
        val orchestrator = CoreEventOrchestrator(
            network = CoreNetworkGate { networkWaits += 1 },
            reconnect = CoreReconnectGate { attempt, reason -> retries += attempt to reason },
            bootstrap = CoreFullBootstrap { reason ->
                assertEquals("CURSOR_TOO_OLD", reason)
                bootstrapped
            },
            connection = CoreEventConnection { current ->
                seenCursors += current.checkpoint.lastGlobalEventId
                connections += 1
                when (connections) {
                    1 -> CoreEventStreamOutcome.Reconnect(
                        current.checkpoint,
                        CoreReconnectReason.END_OF_STREAM,
                    )
                    2 -> CoreEventStreamOutcome.FullBootstrap(
                        current.checkpoint,
                        "CURSOR_TOO_OLD",
                    )
                    else -> CoreEventStreamOutcome.HttpFailure(
                        current.checkpoint,
                        statusCode = 401,
                        retryable = false,
                    )
                }
            },
        )

        val result = orchestrator.run(initial) as CoreEventLoopResult.NeedsUserAction

        assertEquals(401, result.statusCode)
        assertEquals(20L, result.session.checkpoint.lastGlobalEventId)
        assertEquals(listOf(4L, 4L, 20L), seenCursors)
        assertEquals(listOf(1 to CoreReconnectReason.END_OF_STREAM), retries)
        assertEquals(3, networkWaits)
    }

    @Test
    fun `a connection that delivered changes restarts the backoff series`() = runTest {
        val retries = mutableListOf<Pair<Int, CoreReconnectReason>>()
        var connections = 0
        val orchestrator = CoreEventOrchestrator(
            network = CoreNetworkGate {},
            reconnect = CoreReconnectGate { attempt, reason -> retries += attempt to reason },
            bootstrap = CoreFullBootstrap { error("must not bootstrap") },
            connection = CoreEventConnection { current ->
                connections += 1
                when (connections) {
                    1, 2 -> CoreEventStreamOutcome.Reconnect(current.checkpoint, CoreReconnectReason.IO_FAILURE)
                    // The stream applied changes up to 9 before the socket went idle.
                    3 -> CoreEventStreamOutcome.Reconnect(session(9).checkpoint, CoreReconnectReason.IO_FAILURE)
                    4 -> CoreEventStreamOutcome.Reconnect(current.checkpoint, CoreReconnectReason.END_OF_STREAM)
                    else -> CoreEventStreamOutcome.HttpFailure(current.checkpoint, statusCode = 401, retryable = false)
                }
            },
        )

        orchestrator.run(session(4))

        assertEquals(
            listOf(
                1 to CoreReconnectReason.IO_FAILURE,
                2 to CoreReconnectReason.IO_FAILURE,
                1 to CoreReconnectReason.IO_FAILURE,
                2 to CoreReconnectReason.END_OF_STREAM,
            ),
            retries,
        )
    }

    @Test
    fun `cancellation is never converted to reconnect`() = runTest {
        val orchestrator = CoreEventOrchestrator(
            network = CoreNetworkGate {},
            reconnect = CoreReconnectGate { _, _ -> error("must not retry") },
            bootstrap = CoreFullBootstrap { error("must not bootstrap") },
            connection = CoreEventConnection { throw CancellationException("stop") },
        )

        var cancelled = false
        try {
            orchestrator.run(session(0))
        } catch (_: CancellationException) {
            cancelled = true
        }
        assertTrue(cancelled)
    }

    private fun session(version: Long): CoreReplaySession = CoreReplaySession.afterSnapshot(
        version,
        CoreReplayCoverage.AllGrantedScopes,
    )
}
