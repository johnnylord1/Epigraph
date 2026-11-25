package epigraph.sync.v4

import android.app.Application
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], application = Application::class, manifest = Config.NONE)
@ConscryptMode(ConscryptMode.Mode.OFF)
class V4ProductionSyncCoordinatorLocalEditTest {

    @Test
    fun offlineEditPersistsAcrossStoreRecreation() {
        val context = RuntimeEnvironment.getApplication()
        val store1 = SharedPreferencesV4LocalEditPendingStore(context)
        val gen = store1.markPending()
        assertTrue(gen > 0L)

        // Simulate process death / coordinator recreation with a fresh store instance.
        val store2 = SharedPreferencesV4LocalEditPendingStore(context)
        assertEquals(gen, store2.snapshotGeneration())
    }

    @Test
    fun failedSyncKeepsDurableFlagSet() {
        val context = RuntimeEnvironment.getApplication()
        val store = SharedPreferencesV4LocalEditPendingStore(context)
        val gen = store.markPending()

        val snapshot = store.snapshotGeneration()
        assertEquals(gen, snapshot)

        // Simulate V4SyncRunResult.Failed: clearIfUnchanged is NOT called.
        val afterFailure = SharedPreferencesV4LocalEditPendingStore(context)
        assertEquals(gen, afterFailure.snapshotGeneration())
    }

    @Test
    fun concurrentEditDuringInFlightSyncIsNotLostOnCompletion() {
        val context = RuntimeEnvironment.getApplication()
        val store = SharedPreferencesV4LocalEditPendingStore(context)
        val initialGen = store.markPending()

        // Snapshot taken at the start of syncOnce().
        val inFlightGen = store.snapshotGeneration()
        assertEquals(initialGen, inFlightGen)

        // A new local edit arrives while engine.syncWithLocalEdits(...) is in flight.
        val concurrentGen = store.markPending()
        assertNotEquals(inFlightGen, concurrentGen)

        // In-flight sync finishes with V4SyncRunResult.Synced and calls clearIfUnchanged(inFlightGen).
        store.clearIfUnchanged(inFlightGen)

        // The concurrent edit must still be pending for the next sync pass.
        val persisted = SharedPreferencesV4LocalEditPendingStore(context)
        assertEquals(concurrentGen, persisted.snapshotGeneration())
    }
}
