package eu.kanade.tachiyomi.data.download

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DownloadFinalizerTest {

    @Test
    fun `completed directory is published only after final destination is resolved and validated`() {
        val filesystem = FakeFilesystem("chapter_tmp", complete = true)
        val temporary = filesystem.require("chapter_tmp")

        val finalized = finalize(filesystem, temporary, "chapter_tmp", "chapter")

        assertSame(temporary, finalized)
        assertEquals("chapter", finalized.name)
        assertNull(filesystem.find("chapter_tmp"))
        assertSame(finalized, filesystem.find("chapter"))
    }

    @Test
    fun `failed directory rename preserves temporary download and does not publish destination`() {
        val filesystem = FakeFilesystem("chapter_tmp", complete = true).apply {
            failRename = true
        }
        val temporary = filesystem.require("chapter_tmp")

        assertThrows(IllegalStateException::class.java) {
            finalize(filesystem, temporary, "chapter_tmp", "chapter")
        }

        assertSame(temporary, filesystem.find("chapter_tmp"))
        assertNull(filesystem.find("chapter"))
        assertEquals(1, filesystem.renameAttempts)
    }

    @Test
    fun `incomplete temporary archive is rejected before rename`() {
        val filesystem = FakeFilesystem("chapter.cbz_tmp", complete = false)
        val temporary = filesystem.require("chapter.cbz_tmp")

        assertThrows(IllegalStateException::class.java) {
            finalize(filesystem, temporary, "chapter.cbz_tmp", "chapter.cbz")
        }

        assertSame(temporary, filesystem.find("chapter.cbz_tmp"))
        assertNull(filesystem.find("chapter.cbz"))
        assertEquals(0, filesystem.renameAttempts)
    }

    @Test
    fun `archive rename is not accepted when final destination cannot be validated`() {
        val filesystem = FakeFilesystem("chapter.cbz_tmp", complete = true).apply {
            hideFinalDestination = true
        }
        val temporary = filesystem.require("chapter.cbz_tmp")

        assertThrows(IllegalStateException::class.java) {
            finalize(filesystem, temporary, "chapter.cbz_tmp", "chapter.cbz")
        }

        assertEquals(2, filesystem.renameAttempts)
        assertSame(temporary, filesystem.find("chapter.cbz_tmp"))
        assertNull(filesystem.find("chapter.cbz"))
        assertTrue(filesystem.entries.values.none { it.published })
    }

    @Test
    fun `existing final destination prevents overwrite and preserves temporary entry`() {
        val filesystem = FakeFilesystem("chapter_tmp", complete = true).apply {
            entries["chapter"] = Entry("chapter", complete = true)
        }
        val temporary = filesystem.require("chapter_tmp")

        assertThrows(IllegalStateException::class.java) {
            finalize(filesystem, temporary, "chapter_tmp", "chapter")
        }

        assertSame(temporary, filesystem.find("chapter_tmp"))
        assertEquals(0, filesystem.renameAttempts)
    }

    private fun finalize(
        filesystem: FakeFilesystem,
        temporary: Entry,
        temporaryName: String,
        finalName: String,
    ): Entry {
        return DownloadFinalizer.finalizeEntry(
            temporary = temporary,
            temporaryName = temporaryName,
            finalName = finalName,
            findSibling = filesystem::find,
            rename = filesystem::rename,
            isComplete = Entry::complete,
        ).also { it.published = true }
    }

    private data class Entry(
        var name: String,
        val complete: Boolean,
        var published: Boolean = false,
    )

    private class FakeFilesystem(initialName: String, complete: Boolean) {
        val entries = mutableMapOf(initialName to Entry(initialName, complete))
        var failRename = false
        var hideFinalDestination = false
        var renameAttempts = 0

        fun require(name: String): Entry = requireNotNull(entries[name])

        fun find(name: String): Entry? {
            if (hideFinalDestination && !name.endsWith("_tmp")) return null
            return entries[name]
        }

        fun rename(entry: Entry, finalName: String): Boolean {
            renameAttempts++
            if (failRename) return false
            entries.remove(entry.name)
            entry.name = finalName
            entries[finalName] = entry
            return true
        }
    }
}
