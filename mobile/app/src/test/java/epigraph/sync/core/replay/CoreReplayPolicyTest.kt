package epigraph.sync.core.replay

import epigraph.sync.core.protocol.CoreChangeEnvelope
import epigraph.sync.core.protocol.CoreErrorDetail
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreReplayPolicyTest {
    @Test
    fun `snapshot version becomes exact Last-Event-ID`() {
        val session = CoreReplaySession.afterSnapshot(
            snapshotVersion = 42,
            coverage = CoreReplayCoverage.Filtered("books:global"),
        )

        assertEquals("42", session.checkpoint.lastEventIdHeader)
        assertFalse(session.checkpoint.mayInferGlobalDeletes)
    }

    @Test
    fun `filtered stream accepts gaps in global ids without inventing deletes`() {
        val session = CoreReplaySession.afterSnapshot(
            10,
            CoreReplayCoverage.Filtered("books:global"),
        )

        val decision = session.onEvent(changeEvent(14, "books:global", op = "merge"))

        val applied = assertInstanceOf(CoreReplayDecision.ApplyChange::class.java, decision)
        assertEquals(14, applied.checkpoint.lastGlobalEventId)
        assertFalse(applied.checkpoint.mayInferGlobalDeletes)
        assertEquals(10, session.checkpoint.lastGlobalEventId)
        assertEquals(14, session.confirmDurablyApplied(14).lastGlobalEventId)
    }

    @Test
    fun `only explicit delete envelope is delivered as a delete`() {
        val session = CoreReplaySession.afterSnapshot(
            10,
            CoreReplayCoverage.Filtered("books:global"),
        )

        val applied = assertInstanceOf(
            CoreReplayDecision.ApplyChange::class.java,
            session.onEvent(changeEvent(99, "books:global", op = "delete")),
        )

        assertEquals("delete", applied.change.op)
        assertEquals(99, applied.checkpoint.lastGlobalEventId)
        session.confirmDurablyApplied(99)
    }

    @Test
    fun `duplicate replay is ignored idempotently`() {
        val session = CoreReplaySession.afterSnapshot(
            42,
            CoreReplayCoverage.Filtered("books:global"),
        )

        val decision = session.onEvent(changeEvent(42, "books:global"))

        assertInstanceOf(CoreReplayDecision.IgnoreAlreadySeen::class.java, decision)
        assertEquals(42, session.checkpoint.lastGlobalEventId)
    }

    @Test
    fun `filtered session rejects a change from a different scope`() {
        val session = CoreReplaySession.afterSnapshot(
            42,
            CoreReplayCoverage.Filtered("books:global"),
        )

        assertThrows(CoreSseProtocolException::class.java) {
            session.onEvent(changeEvent(43, "novels:profile:main"))
        }
    }

    @Test
    fun `failed durable apply reconnects from previous checkpoint`() {
        val session = CoreReplaySession.afterSnapshot(
            42,
            CoreReplayCoverage.Filtered("books:global"),
        )
        session.onEvent(changeEvent(45, "books:global"))

        val reconnect = session.abandonPendingChange()

        assertEquals("42", reconnect.checkpoint.lastEventIdHeader)
        assertEquals(42, session.checkpoint.lastGlobalEventId)
    }

    @Test
    fun `replay required reconnects from preserved cursor while still replayable`() {
        val session = CoreReplaySession.afterSnapshot(
            42,
            CoreReplayCoverage.AllGrantedScopes,
        )

        val decision = session.onEvent(
            CoreSseEvent.ReplayRequired(
                CoreReplayRequiredPayload(
                    reasonCode = "LIVE_STREAM_LAGGED",
                    requiredAction = "reconnect_and_replay",
                    currentServerVersion = 50,
                    minReplayableServerVersion = 40,
                    lastSentVersion = 42,
                ),
            ),
        )

        val reconnect = assertInstanceOf(CoreReplayDecision.ReconnectAndReplay::class.java, decision)
        assertEquals("42", reconnect.checkpoint.lastEventIdHeader)
    }

    @Test
    fun `replay required falls back to bootstrap when cursor expired or action is unknown`() {
        val session = CoreReplaySession.afterSnapshot(
            39,
            CoreReplayCoverage.AllGrantedScopes,
        )
        val expired = session.onEvent(
            CoreSseEvent.ReplayRequired(
                CoreReplayRequiredPayload(
                    reasonCode = "LIVE_STREAM_LAGGED",
                    requiredAction = "reconnect_and_replay",
                    minReplayableServerVersion = 40,
                ),
            ),
        )
        val unknown = session.onEvent(
            CoreSseEvent.ReplayRequired(
                CoreReplayRequiredPayload(
                    reasonCode = "FUTURE_REASON",
                    requiredAction = "future_action",
                ),
            ),
        )

        assertInstanceOf(CoreReplayDecision.FullBootstrap::class.java, expired)
        assertInstanceOf(CoreReplayDecision.FullBootstrap::class.java, unknown)
    }

    @Test
    fun `HTTP 409 replay window expired mandates authoritative snapshot`() {
        val decision = CoreReplayFailurePolicy.onHttpFailure(
            409,
            CoreErrorDetail(
                code = "REPLAY_WINDOW_EXPIRED",
                message = "Replay window expired.",
                requiredAction = "full_bootstrap",
            ),
        )

        assertInstanceOf(CoreReplayDecision.FullBootstrap::class.java, decision)
        assertEquals(
            null,
            CoreReplayFailurePolicy.onHttpFailure(
                500,
                CoreErrorDetail("REPLAY_WINDOW_EXPIRED", "wrong status"),
            ),
        )
    }

    private fun changeEvent(
        version: Long,
        scopeId: String,
        op: String = "merge",
    ) = CoreSseEvent.Change(
        globalEventId = version,
        envelope = CoreChangeEnvelope(
            serverVersion = version,
            scopeId = scopeId,
            entityType = "book.progress",
            entityId = "book-1",
            op = op,
            lamport = version,
            patch = if (op == "delete") null else buildJsonObject { put("progressPercent", 0.5) },
            appliedAtMs = 1234,
        ),
    )
}
