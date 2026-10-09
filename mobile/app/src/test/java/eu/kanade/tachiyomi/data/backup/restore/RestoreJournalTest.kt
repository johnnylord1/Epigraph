package eu.kanade.tachiyomi.data.backup.restore

import java.io.File
import java.nio.file.Files
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class RestoreJournalTest {
    private val directory = Files.createTempDirectory("restore-journal").toFile()
    private val file = RestoreJournal.file(directory)

    @AfterEach
    fun cleanUp() {
        directory.deleteRecursively()
    }

    @Test
    fun `an interrupted restore of the same backup resumes after its last step`() {
        RestoreJournal(file).apply {
            assertFalse(open("content://backup abc"))
            markDone(RestoreJournal.CATEGORIES)
            markDone(RestoreJournal.manga(0))
            recordError(42L, "Title [Source]: failed\nsecond line \\ end")
        }

        val resumed = RestoreJournal(file)
        assertTrue(resumed.open("content://backup abc"))
        assertTrue(resumed.isDone(RestoreJournal.CATEGORIES))
        assertTrue(resumed.isDone(RestoreJournal.manga(0)))
        assertFalse(resumed.isDone(RestoreJournal.manga(1)))
        assertEquals(listOf(42L to "Title [Source]: failed\nsecond line \\ end"), resumed.recordedErrors)
    }

    @Test
    fun `a different backup starts over`() {
        RestoreJournal(file).apply {
            open("content://backup abc")
            markDone(RestoreJournal.manga(0))
        }

        val other = RestoreJournal(file)
        assertFalse(other.open("content://backup def"))
        assertTrue(other.completed.isEmpty())
        // The old checkpoints are gone, not merely ignored.
        assertFalse(RestoreJournal(file).open("content://backup abc"))
    }

    @Test
    fun `a line cut short by a crash is ignored and does not corrupt the next one`() {
        RestoreJournal(file).apply {
            open("content://backup abc")
            markDone(RestoreJournal.manga(0))
        }
        file.appendText("done m:1")

        val resumed = RestoreJournal(file)
        assertTrue(resumed.open("content://backup abc"))
        assertFalse(resumed.isDone(RestoreJournal.manga(1)))
        resumed.markDone(RestoreJournal.manga(2))

        val again = RestoreJournal(file)
        again.open("content://backup abc")
        assertEquals(setOf(RestoreJournal.manga(0), RestoreJournal.manga(2)), again.completed)
    }

    @Test
    fun `a finished restore leaves nothing to resume`() {
        RestoreJournal(file).apply {
            open("content://backup abc")
            markDone(RestoreJournal.localBook(0))
            delete()
        }

        assertFalse(File(file.path).exists())
        assertFalse(RestoreJournal(file).open("content://backup abc"))
    }

    @Test
    fun `escaping round-trips control characters and backslashes`() {
        val value = "a\\b\nc\rd\\n"
        assertEquals(value, RestoreJournal.unescape(RestoreJournal.escape(value)))
        assertFalse('\n' in RestoreJournal.escape(value))
    }
}
