package epigraph.sync.core.trackers

import epigraph.sync.core.credentials.CoreCredentialBlobStore
import epigraph.sync.core.credentials.CoreCredentialCipher
import epigraph.sync.core.credentials.CoreCredentialException
import epigraph.sync.core.credentials.CoreCredentialFailure
import epigraph.sync.core.credentials.SealedCredential
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreTrackerCredential
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialList
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import java.nio.charset.StandardCharsets
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class TrackerCredentialSyncerTest {
    private val blobs = MemoryBlobStore()
    private val vault = TrackerCredentialVault(XorCipher(), blobs)
    private val source = FakeSource()
    private val core = FakeCore()
    private val syncer = TrackerCredentialSyncer(vault, source, { "device-a" }, Dispatchers.Unconfined)

    @Test
    fun `local login is pushed once against revision zero and then agreed`() = runTest {
        source.logins[MAL] = TrackerSecret("reader", "", "mal-token")

        assertEquals(TrackerCredentialSyncReport(pushed = 1), syncer.synchronize(core))
        assertEquals(listOf("list", "put:myanimelist@0"), core.calls)
        assertEquals("mal-token", core.values.getValue("myanimelist").token)
        assertEquals(
            TrackerCredentialVaultEntry(1, source.logins[MAL], receivedFromCore = false),
            vault.read()["myanimelist"],
        )

        core.calls.clear()
        assertEquals(TrackerCredentialSyncReport(), syncer.synchronize(core))
        assertEquals(listOf("list"), core.calls)
    }

    @Test
    fun `newer core login wins and is marked as received from the core`() = runTest {
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 3, token = "remote")
        source.logins[ANILIST] = TrackerSecret("", "", "local-edit")

        val report = syncer.synchronize(core)

        assertEquals(TrackerCredentialSyncReport(applied = 1, conflicts = 1), report)
        assertEquals(TrackerSecret("", "", "remote"), source.logins[ANILIST])
        assertEquals(listOf(ANILIST), source.applied)
        assertTrue(vault.read().getValue("anilist").receivedFromCore)
    }

    @Test
    fun `stale local write gets a conflict and keeps the previous agreement`() = runTest {
        source.logins[MAL] = TrackerSecret("reader", "", "v1")
        syncer.synchronize(core)
        source.logins[MAL] = TrackerSecret("reader", "", "v2")
        core.rejectWrites = true

        assertEquals(TrackerCredentialSyncReport(conflicts = 1), syncer.synchronize(core))
        assertEquals(1L, vault.read().getValue("myanimelist").revision)
        assertEquals("v1", core.values.getValue("myanimelist").token)
    }

    @Test
    fun `local logout becomes a tombstone on the core`() = runTest {
        source.logins[MAL] = TrackerSecret("reader", "", "v1")
        syncer.synchronize(core)
        source.logins.remove(MAL)

        assertEquals(TrackerCredentialSyncReport(pushed = 1), syncer.synchronize(core))
        assertTrue(core.values.getValue("myanimelist").deleted)
        assertEquals(TrackerCredentialVaultEntry(2, null, receivedFromCore = false), vault.read()["myanimelist"])
    }

    @Test
    fun `agreed login is offered again to a core that lost it`() = runTest {
        source.logins[MAL] = TrackerSecret("reader", "", "mal-token")
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 2, token = "remote")
        syncer.synchronize(core)
        // The desktop was reset: its Core starts over with no record of either login.
        core.values.clear()
        core.calls.clear()

        assertEquals(TrackerCredentialSyncReport(pushed = 2), syncer.synchronize(core))
        assertEquals(listOf("list", "put:myanimelist@0", "put:anilist@0"), core.calls)
        assertEquals("remote", core.values.getValue("anilist").token)
        assertEquals("mal-token", core.values.getValue("myanimelist").token)
        assertEquals(1L, vault.read().getValue("myanimelist").revision)
        assertEquals("remote", source.logins.getValue(ANILIST).token)
    }

    @Test
    fun `core tombstone logs the tracker out`() = runTest {
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 1, token = "remote")
        syncer.synchronize(core)
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 2, deleted = true)

        assertEquals(TrackerCredentialSyncReport(applied = 1), syncer.synchronize(core))
        assertNull(source.logins[ANILIST])
    }

    @Test
    fun `unknown trackers, oversize values and list failures are never applied`() = runTest {
        core.values["future_tracker"] = CoreTrackerCredential("future_tracker", revision = 1, token = "x")
        core.values["anilist"] = CoreTrackerCredential(
            "anilist",
            revision = 1,
            token = "x".repeat(TrackerSecret.MAX_FIELD_BYTES + 1),
        )

        assertEquals(
            TrackerCredentialSyncReport(failed = 1, failures = listOf("anilist unusable")),
            syncer.synchronize(core),
        )
        assertTrue(source.applied.isEmpty())

        core.failList = true
        source.logins[MAL] = TrackerSecret("reader", "", "v1")
        assertEquals(
            TrackerCredentialSyncReport(failed = 1, failures = listOf("list http=503")),
            syncer.synchronize(core),
        )
        assertEquals(listOf("list", "list"), core.calls)
    }

    @Test
    fun `unreadable vault is reset and the core value wins`() = runTest {
        blobs.value = byteArrayOf(1, 2, 3)
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 4, token = "remote")

        assertEquals(TrackerCredentialSyncReport(applied = 1), syncer.synchronize(core))
        assertEquals(4L, vault.read().getValue("anilist").revision)
    }

    @Test
    fun `wipe logs out only unchanged logins that came from the core`() = runTest {
        core.values["anilist"] = CoreTrackerCredential("anilist", revision = 1, token = "remote-anilist")
        core.values["novelupdates"] = CoreTrackerCredential("novelupdates", revision = 1, token = "remote-nu")
        source.logins[MAL] = TrackerSecret("reader", "", "typed-here")
        syncer.synchronize(core)
        source.logins[NOVEL_UPDATES] = TrackerSecret("", "", "changed-after-sync")

        syncer.wipe()

        assertNull(source.logins[ANILIST])
        assertEquals("typed-here", source.logins.getValue(MAL).token)
        assertEquals("changed-after-sync", source.logins.getValue(NOVEL_UPDATES).token)
        assertNull(blobs.value)
    }

    @Test
    fun `vault is sealed and secrets never appear in string forms`() = runTest {
        source.logins[MAL] = TrackerSecret("reader", "hunter2", "mal-token")
        syncer.synchronize(core)

        val stored = String(blobs.value!!, StandardCharsets.ISO_8859_1)
        assertFalse("mal-token" in stored)
        assertFalse("hunter2" in stored)
        val strings = listOf(
            source.logins.getValue(MAL).toString(),
            vault.read().toString(),
            core.values.getValue("myanimelist").toString(),
            CoreTrackerCredentialWrite(0, "device-a", "reader", "hunter2", "mal-token").toString(),
        )
        strings.forEach { value ->
            assertFalse("hunter2" in value, value)
            assertFalse("mal-token" in value, value)
        }
    }

    private class FakeSource : TrackerCredentialSource {
        val logins = mutableMapOf<Long, TrackerSecret>()
        val applied = mutableListOf<Long>()

        override val syncIds: Set<Long> = setOf(MAL, ANILIST, NOVEL_UPDATES)

        override fun read(syncId: Long): TrackerSecret? = logins[syncId]

        override fun apply(syncId: Long, secret: TrackerSecret?) {
            applied += syncId
            if (secret == null) logins.remove(syncId) else logins[syncId] = secret
        }
    }

    private class FakeCore : TrackerCredentialChannel {
        val values = linkedMapOf<String, CoreTrackerCredential>()
        val calls = mutableListOf<String>()
        var rejectWrites = false
        var failList = false

        override suspend fun list(): CoreHttpResult<CoreTrackerCredentialList> {
            calls += "list"
            if (failList) return CoreHttpResult.Failure(503, null)
            return CoreHttpResult.Success(CoreTrackerCredentialList(credentials = values.values.toList()))
        }

        override suspend fun put(
            trackerKey: String,
            write: CoreTrackerCredentialWrite,
        ): CoreHttpResult<CoreTrackerCredential> {
            calls += "put:$trackerKey@${write.baseRevision}"
            return store(trackerKey, write.baseRevision) { revision ->
                CoreTrackerCredential(trackerKey, revision, false, write.username, write.password, write.token)
            }
        }

        override suspend fun delete(
            trackerKey: String,
            delete: CoreTrackerCredentialDelete,
        ): CoreHttpResult<CoreTrackerCredential> {
            calls += "delete:$trackerKey@${delete.baseRevision}"
            return store(trackerKey, delete.baseRevision) { revision ->
                CoreTrackerCredential(trackerKey, revision, deleted = true)
            }
        }

        private fun store(
            trackerKey: String,
            baseRevision: Long,
            next: (Long) -> CoreTrackerCredential,
        ): CoreHttpResult<CoreTrackerCredential> {
            val current = values[trackerKey]?.revision ?: 0L
            if (rejectWrites || current != baseRevision) return CoreHttpResult.Failure(409, null)
            return CoreHttpResult.Success(next(current + 1).also { values[trackerKey] = it })
        }
    }

    private class MemoryBlobStore : CoreCredentialBlobStore {
        var value: ByteArray? = null

        override fun read(): ByteArray? = value?.copyOf()

        override fun writeAtomically(value: ByteArray) {
            this.value = value.copyOf()
        }

        override fun delete() {
            value = null
        }
    }

    private class XorCipher : CoreCredentialCipher {
        override fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential =
            SealedCredential(
                nonce = ByteArray(12) { 7 },
                ciphertext = plaintext.map { (it.toInt() xor 0x5a).toByte() }.toByteArray(),
            )

        override fun open(sealed: SealedCredential, authenticatedData: ByteArray): ByteArray {
            if (sealed.nonce.size != 12) throw CoreCredentialException(CoreCredentialFailure.CORRUPTED)
            return sealed.ciphertext.map { (it.toInt() xor 0x5a).toByte() }.toByteArray()
        }
    }

    private companion object {
        const val MAL = 1L
        const val ANILIST = 2L
        const val NOVEL_UPDATES = 10L
    }
}
