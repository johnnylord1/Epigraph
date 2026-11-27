package epigraph.sync.v4

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class V4LocalEditLedgerTest {

    @Test
    fun workMarkScopesThePassToThatWork() {
        val store = MemoryV4LocalEditPendingStore()
        val gen = store.markWorkPending("comic:a")

        val snapshot = store.snapshot()
        assertEquals(gen, snapshot.generation)
        assertFalse(snapshot.fullPass)
        assertEquals(setOf("comic:a"), snapshot.workKeys)
    }

    @Test
    fun unscopedMarkForcesAFullPass() {
        val store = MemoryV4LocalEditPendingStore()
        store.markWorkPending("comic:a")
        store.markPending()

        assertTrue(store.snapshot().fullPass)
    }

    @Test
    fun editRecordedAfterTheReadGenerationSurvivesClearUpTo() {
        val store = MemoryV4LocalEditPendingStore()
        val read = store.markWorkPending("comic:a")

        // A second edit lands between the pass's read and its commit.
        store.markWorkPending("comic:b")
        store.clearUpTo(read)

        val snapshot = store.snapshot()
        assertEquals(setOf("comic:b"), snapshot.workKeys)
        assertFalse(snapshot.fullPass)
    }

    @Test
    fun clearUpToRemovesReadMarksAndTheirFullPassFlag() {
        val store = MemoryV4LocalEditPendingStore()
        val gen = store.markPending()
        store.clearUpTo(gen)

        val snapshot = store.snapshot()
        assertFalse(snapshot.fullPass)
        assertTrue(snapshot.workKeys.isEmpty())
        assertFalse(snapshot.hasPending(nowMs = 0L))
    }

    @Test
    fun generationStaysMonotonicAcrossClears() {
        val store = MemoryV4LocalEditPendingStore()
        val first = store.markWorkPending("comic:a")
        store.clearUpTo(first)
        val second = store.markWorkPending("comic:a")

        assertTrue(second > first)
        assertEquals(second, store.snapshotGeneration())
    }

    @Test
    fun aScheduledFullPassStaysPendingEvenBeforeItIsDue() {
        val store = MemoryV4LocalEditPendingStore()
        store.clearUpTo(store.markWorkPending("comic:a"))
        store.scheduleFullPassAt(60_000L)

        val snapshot = store.snapshot()
        // A debounced full pass that is not yet due does not start a sync pass by itself.
        assertFalse(snapshot.hasPending(nowMs = 59_999L))
        assertTrue(snapshot.workKeys.isEmpty())
        assertFalse(snapshot.fullPassDue(nowMs = 59_999L))
        assertTrue(snapshot.fullPassDue(nowMs = 60_000L))
        assertTrue(snapshot.hasPending(nowMs = 60_000L))
    }

    @Test
    fun notDueFullPassNeverDelaysAScopedEdit() {
        val store = MemoryV4LocalEditPendingStore()
        store.scheduleFullPassAt(60_000L)
        store.markWorkPending("comic:a")

        val snapshot = store.snapshot()
        assertTrue(snapshot.hasPending(nowMs = 1_000L))
        assertEquals(setOf("comic:a"), snapshot.workKeys)
        assertFalse(snapshot.fullPassDue(nowMs = 1_000L))
    }

    @Test
    fun unscopedMarkStillCountsBeforeTheDebounceIsDue() {
        val store = MemoryV4LocalEditPendingStore()
        store.scheduleFullPassAt(60_000L)
        store.markPending()

        assertTrue(store.snapshot().hasPending(nowMs = 1_000L))
    }

    @Test
    fun laterScheduleMovesTheDebouncedFullPass() {
        val store = MemoryV4LocalEditPendingStore()
        store.scheduleFullPassAt(60_000L)
        store.scheduleFullPassAt(90_000L)

        assertEquals(90_000L, store.snapshot().fullPassDueAt)
    }

    @Test
    fun clearFullPassDueOnlyClearsTheExpectedDueTime() {
        val store = MemoryV4LocalEditPendingStore()
        store.scheduleFullPassAt(90_000L)

        store.clearFullPassDue(expectedDueAt = 60_000L)
        assertEquals(90_000L, store.snapshot().fullPassDueAt)

        store.clearFullPassDue(expectedDueAt = 90_000L)
        assertEquals(0L, store.snapshot().fullPassDueAt)
    }

    @Test
    fun compositeScopedReadWithNoScopedBridgesIsEmpty() = runBlocking {
        val unscopedBridge = object : V4DomainBridge {
            override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock) = emptyList<V4OutgoingItem>()
            override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) = Unit
            override suspend fun digestSnapshot(serverId: String, profileId: String) = listOf(
                V4DigestedItem(V4DigestKey("novels", "novel.work", "n1"), "digest", deleted = false),
            )
        }
        val composite = CompositeV4DomainBridge(unscopedBridge)

        val read = composite.readLocalScoped("server", "profile", V4LocalScope(setOf("comic:a")))

        // The default scoped read covers nothing, so the scoped commit writes nothing for this domain.
        assertTrue(read.digests.isEmpty())
        val pass = read.commit(V4HlcClock("phone"))
        assertTrue(pass.outgoing.isEmpty())
        assertTrue(pass.digests.isEmpty())
        // A scoped commit reports its stored digests, here none: the engine must not load the whole baseline.
        assertEquals(emptyMap<V4DigestKey, V4StoredDigest>(), pass.stored)
    }
}
