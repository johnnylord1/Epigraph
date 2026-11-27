package epigraph.sync.v4

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

private fun titled(title: String): JsonObject = buildJsonObject { put("title", JsonPrimitive(title)) }

/** The local-edit pass reads the library outside the sync lock and commits under it. */
class V4LocalReadRaceTest {
    @Test
    fun `remote apply runs while a local-edit read is in progress`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = titled("A1")
        rig.pass()

        rig.local["a"] = titled("A2")
        val readStarted = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        var firstRead = true
        rig.beforeRead = {
            if (firstRead) {
                firstRead = false
                readStarted.complete(Unit)
                release.await()
            }
        }
        val readsBefore = rig.reads

        val pass = async { rig.engine.syncWithLocalEdits("tok") }
        readStarted.await()
        rig.remoteUpsert("r", "R")
        // Would never return if the pass held the lock during its read (runTest's real-time guard fails it).
        val remote = rig.engine.syncOnce("tok")
        assertTrue(remote is V4SyncRunResult.Synced, "remote sync: $remote")
        assertEquals(titled("R"), rig.local["r"])

        release.complete(Unit)
        assertTrue(pass.await() is V4SyncRunResult.Synced)
        // The remote apply moved the sync state while the read ran, so the read was redone once.
        assertEquals(2, rig.reads - readsBefore)
    }

    @Test
    fun `local edit made during the read is uploaded, not lost`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = titled("A1")
        rig.pass()

        rig.local["a"] = titled("A2")
        var firstRead = true
        rig.afterRead = {
            if (firstRead) {
                firstRead = false
                rig.local["a"] = titled("A3")
                rig.generation++
            }
        }
        val readsBefore = rig.reads

        val uploaded = rig.pass()

        assertEquals(2, rig.reads - readsBefore)
        assertEquals(listOf("a"), keysOf(uploaded))
        assertTrue(uploaded.single().toString().contains("A3"), "uploaded: $uploaded")
    }

    @Test
    fun `read is taken under the lock after the unlocked attempts are used up`() = runTest {
        val rig = BaselineRig()
        rig.local["a"] = titled("A1")
        rig.pass()

        rig.local["a"] = titled("A2")
        // Every unlocked read is overtaken by an edit, so the pass must fall back to a locked read.
        rig.afterRead = { rig.generation++ }
        val readsBefore = rig.reads

        val uploaded = rig.pass()

        assertEquals(4, rig.reads - readsBefore)
        assertTrue(uploaded.single().toString().contains("A2"), "uploaded: $uploaded")
    }

    private fun keysOf(items: List<JsonObject>): List<String> =
        items.map { it.getValue("entityKey").toString().trim('"') }
}
