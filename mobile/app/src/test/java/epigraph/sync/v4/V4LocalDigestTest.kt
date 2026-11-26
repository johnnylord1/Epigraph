package epigraph.sync.v4

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Test

class V4LocalDigestTest {
    private fun draft(payload: JsonObject, deleted: Boolean = false) =
        V4ItemDraft(domain = "comics", entityType = "comic.work", entityKey = "src:/work", payload = payload, deleted = deleted)

    @Test
    fun `digest is stable across payload key order`() {
        val ordered = JsonObject(linkedMapOf("title" to JsonPrimitive("A"), "rating" to JsonPrimitive(5)))
        val reversed = JsonObject(linkedMapOf("rating" to JsonPrimitive(5), "title" to JsonPrimitive("A")))

        assertEquals(V4LocalDigest.of(draft(ordered)), V4LocalDigest.of(draft(reversed)))
    }

    @Test
    fun `digest ignores clocks and client mutation ids because they never enter the draft`() {
        // Drafts carry no hlc, clientMutationId or serverSeq, so two stamps of the same state with different clocks
        // must produce the same digest.
        val payload = JsonObject(mapOf("title" to JsonPrimitive("A")))
        val early = V4LocalDigest.of(draft(payload))
        val stampedLater = listOf(draft(payload)).stamp(V4HlcClock("android-1", wallClockMs = { 9_000_000L })).single()
        val stampedEarlier = listOf(draft(payload)).stamp(V4HlcClock("android-1", wallClockMs = { 1_000L })).single()

        assertEquals(early, V4LocalDigest.of(draft(payload)))
        assertEquals(stampedLater.payload, stampedEarlier.payload)
    }

    @Test
    fun `digest changes when the payload changes`() {
        val before = V4LocalDigest.of(draft(JsonObject(mapOf("title" to JsonPrimitive("A")))))
        val after = V4LocalDigest.of(draft(JsonObject(mapOf("title" to JsonPrimitive("B")))))

        assertNotEquals(before, after)
    }

    @Test
    fun `digest changes when the deleted flag flips`() {
        val payload = JsonObject(mapOf("title" to JsonPrimitive("A")))

        assertNotEquals(V4LocalDigest.of(draft(payload, deleted = false)), V4LocalDigest.of(draft(payload, deleted = true)))
    }

    @Test
    fun `canonical json sorts object keys recursively`() {
        val nested = JsonObject(
            linkedMapOf(
                "b" to JsonObject(linkedMapOf("y" to JsonPrimitive(1), "x" to JsonPrimitive(2))),
                "a" to JsonPrimitive("z"),
            ),
        )

        assertEquals(
            V4LocalDigest.canonicalJson(JsonObject(linkedMapOf("a" to JsonPrimitive("z"), "b" to JsonObject(linkedMapOf("x" to JsonPrimitive(2), "y" to JsonPrimitive(1)))))),
            V4LocalDigest.canonicalJson(nested),
        )
    }
}
