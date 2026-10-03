package epigraph.sync.core.credentials

import java.io.File
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class PrivateAtomicCoreCredentialFileTest {
    @TempDir
    lateinit var temporaryDirectory: File

    @Test
    fun `publishes a synced part and removes temporary residue`() {
        val directory = File(temporaryDirectory, "no-backup/aethon-sync")
        val file = PrivateAtomicCoreCredentialFile(directory, publisher = JvmPublisher)

        file.writeAtomically(byteArrayOf(1, 2, 3, 4))

        assertArrayEquals(byteArrayOf(1, 2, 3, 4), file.read())
        assertFalse(File(directory, "core-session-v1.bin.part").exists())
    }

    @Test
    fun `deletes stale part and final credential idempotently`() {
        val directory = File(temporaryDirectory, "no-backup/aethon-sync")
        directory.mkdirs()
        File(directory, "core-session-v1.bin.part").writeBytes(byteArrayOf(9))
        val file = PrivateAtomicCoreCredentialFile(directory, publisher = JvmPublisher)
        file.writeAtomically(byteArrayOf(1))
        File(directory, "core-session-v1.bin.part").writeBytes(byteArrayOf(8))

        file.delete()
        file.delete()

        assertNull(file.read())
        assertFalse(File(directory, "core-session-v1.bin.part").exists())
    }

    @Test
    fun `publisher failure preserves previous final credential and removes part`() {
        val directory = File(temporaryDirectory, "no-backup/aethon-sync")
        PrivateAtomicCoreCredentialFile(directory, publisher = JvmPublisher)
            .writeAtomically(byteArrayOf(1, 2, 3))
        val failing = PrivateAtomicCoreCredentialFile(
            directory = directory,
            publisher = CoreCredentialFilePublisher { _, _ -> error("simulated rename failure") },
        )

        val error = assertThrows(CoreCredentialException::class.java) {
            failing.writeAtomically(byteArrayOf(4, 5, 6))
        }

        assertEquals(CoreCredentialFailure.IO, error.failure)
        assertArrayEquals(byteArrayOf(1, 2, 3), failing.read())
        assertFalse(File(directory, "core-session-v1.bin.part").exists())
    }

    private data object JvmPublisher : CoreCredentialFilePublisher {
        override fun publish(source: File, target: File) {
            if (target.exists() && !target.delete()) error("Could not replace target")
            if (!source.renameTo(target)) error("Could not publish source")
        }
    }
}
