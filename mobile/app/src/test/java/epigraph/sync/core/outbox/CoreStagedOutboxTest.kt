package epigraph.sync.core.outbox

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreStagedOutboxTest {
    @Test
    fun `stages one command per entity until Core acknowledges it`() {
        val staged = CoreStagedOutbox()

        assertEquals(2, staged.stage(listOf(record("a", "chapter-1"), record("b", "chapter-2"))))
        assertEquals(0, staged.stage(listOf(record("c", "chapter-1"))))
        assertEquals(2, staged.count())
        assertTrue(staged.hasReady())

        val claimed = staged.claim(limit = 10, scopeIds = null)
        assertFalse(staged.hasReady())
        assertEquals(listOf("a", "b"), claimed.map { it.record.clientMutationId })
        assertTrue(claimed.zipWithNext().all { (first, second) -> first.sequence < second.sequence })
        assertEquals(2, staged.count())

        staged.settle(identity("a"))
        assertEquals(1, staged.count())
        assertEquals(1, staged.stage(listOf(record("c", "chapter-1"))))
    }

    @Test
    fun `claims only the granted scopes and keeps the others in order`() {
        val staged = CoreStagedOutbox()
        staged.stage(
            listOf(
                record("a", "chapter-1", scope = "books"),
                record("b", "chapter-2"),
                record("c", "chapter-3", scope = "books"),
            ),
        )

        assertEquals(listOf("b"), staged.claim(limit = 10, scopeIds = setOf(SCOPE)).map { it.record.clientMutationId })
        assertEquals(1, staged.count(setOf(SCOPE)))
        assertEquals(2, staged.count(setOf("books")))
        assertEquals(listOf("a", "c"), staged.claim(limit = 10, scopeIds = null).map { it.record.clientMutationId })
    }

    @Test
    fun `a command never sent is claimed again and a failed one waits for the outbox`() {
        val staged = CoreStagedOutbox()
        staged.stage(listOf(record("a", "chapter-1"), record("b", "chapter-2")))
        staged.claim(limit = 2, scopeIds = null)

        staged.release(identity("a"))
        staged.fail(identity("b"))
        assertFalse(staged.isLeased(identity("a")))
        assertEquals(listOf("a"), staged.claim(limit = 10, scopeIds = null).map { it.record.clientMutationId })
        assertEquals(2, staged.count())

        val unsent = staged.takeUnsent()
        assertEquals(setOf("a", "b"), unsent.map { it.record.clientMutationId }.toSet())
        assertEquals(0, staged.count())
        assertTrue(staged.claim(limit = 10, scopeIds = null).isEmpty())

        staged.restore(unsent)
        assertEquals(2, staged.count())
    }

    @Test
    fun `staged sequences never meet outbox sequences`() {
        val staged = CoreStagedOutbox()
        staged.stage(listOf(record("a", "chapter-1")))

        assertTrue(staged.claim(limit = 1, scopeIds = null).single().sequence > Int.MAX_VALUE)
    }

    private fun record(id: String, entityId: String, scope: String = SCOPE) = CoreOutboxRecord(
        deviceId = DEVICE,
        clientMutationId = id,
        scopeId = scope,
        entityType = "comic.chapter_state",
        entityId = entityId,
        operation = "comic.chapter_state.set",
        payloadJson = "{}",
        createdAtEpochMillis = 1_000,
    )

    private fun identity(id: String) = CoreOutboxIdentity(DEVICE, id)

    private companion object {
        const val DEVICE = "device-1"
        const val SCOPE = "comics"
    }
}
