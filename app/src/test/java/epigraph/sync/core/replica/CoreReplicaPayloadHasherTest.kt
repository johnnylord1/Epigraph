package epigraph.sync.core.replica

import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class CoreReplicaPayloadHasherTest {
    @Test
    fun `canonical payload hash ignores object insertion order`() {
        val first = buildJsonObject {
            put("title", "Epigraph")
            put("progress", 0.5)
        }
        val second = buildJsonObject {
            put("progress", 0.5)
            put("title", "Epigraph")
        }

        assertEquals(
            CoreReplicaPayloadHasher.sha256(CoreReplicaPayloadHasher.canonicalJson(first)),
            CoreReplicaPayloadHasher.sha256(CoreReplicaPayloadHasher.canonicalJson(second)),
        )
    }

    @Test
    fun `inbox hash covers complete event identity`() {
        val event = CoreReplicaInboxEvent(8, "books:global", "book.entry", "book-1", "merge")

        assertEquals(64, CoreReplicaPayloadHasher.inbox(event).length)
        assertNotEquals(
            CoreReplicaPayloadHasher.inbox(event),
            CoreReplicaPayloadHasher.inbox(event.copy(operation = "delete")),
        )
    }
}
