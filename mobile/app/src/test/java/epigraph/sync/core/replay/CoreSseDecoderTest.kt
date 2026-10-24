package epigraph.sync.core.replay

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class CoreSseDecoderTest {
    @Test
    fun `decodes syncd change ping and replay required across arbitrary chunks`() {
        val decoder = CoreSseDecoder()
        val first = decoder.feed(
            "event: change\r\nid: 42\r\ndata: ${changeJson(42)}\r",
        )
        val second = decoder.feed(
            "\n\r\nevent: ping\ndata: \n\nevent: replay_required\ndata: {\"reasonCode\":\"LIVE_STREAM_LAGGED\",",
        )
        val third = decoder.feed(
            "\"requiredAction\":\"reconnect_and_replay\",\"minReplayableServerVersion\":7}\n\n",
        )

        assertEquals(emptyList<CoreSseEvent>(), first)
        val change = assertInstanceOf(CoreSseEvent.Change::class.java, second[0])
        assertEquals(42, change.globalEventId)
        assertEquals("books:global", change.envelope.scopeId)
        assertInstanceOf(CoreSseEvent.Ping::class.java, second[1])
        val replay = assertInstanceOf(CoreSseEvent.ReplayRequired::class.java, third.single())
        assertEquals("reconnect_and_replay", replay.payload.requiredAction)
        assertEquals(7, replay.payload.minReplayableServerVersion)
    }

    @Test
    fun `joins multiple data lines and ignores comment frames`() {
        val decoder = CoreSseDecoder()

        val events = decoder.feed(
            buildString {
                append(": keep alive\n\n")
                append("event: replay_required\n")
                append("data: {\"reasonCode\":\"LIVE_STREAM_LAGGED\",\n")
                append("data: \"requiredAction\":\"full_bootstrap\"}\n\n")
            },
        )

        val replay = assertInstanceOf(CoreSseEvent.ReplayRequired::class.java, events.single())
        assertEquals("full_bootstrap", replay.payload.requiredAction)
    }

    @Test
    fun `decodes a catalog revision announcement`() {
        val events = CoreSseDecoder().feed(
            "event: catalog_revision\ndata: {\"scopeId\":\"comics:profile:main\",\"future\":1}\n\n",
        )

        val revision = assertInstanceOf(CoreSseEvent.CatalogRevision::class.java, events.single())
        assertEquals("comics:profile:main", revision.payload.scopeId)
    }

    @Test
    fun `rejects a change whose global SSE id disagrees with envelope`() {
        val decoder = CoreSseDecoder()

        assertThrows(CoreSseProtocolException::class.java) {
            decoder.feed("event: change\nid: 41\ndata: ${changeJson(42)}\n\n")
        }
    }

    @Test
    fun `rejects truncated event at end of stream`() {
        val decoder = CoreSseDecoder()
        decoder.feed("event: change\nid: 42")

        assertThrows(CoreSseProtocolException::class.java, decoder::finish)
    }

    private fun changeJson(version: Long) =
        """{"serverVersion":$version,"scopeId":"books:global","entityType":"book.progress","entityId":"book-1","op":"merge","lamport":9,"patch":{"progressPercent":0.5},"appliedAtMs":1234}"""
}
