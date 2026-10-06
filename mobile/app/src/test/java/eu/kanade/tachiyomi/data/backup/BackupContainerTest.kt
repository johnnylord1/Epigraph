package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.create.BackupOptions
import eu.kanade.tachiyomi.data.backup.models.Backup
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.util.BackupUtil
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.time.Instant
import java.util.zip.GZIPOutputStream
import java.util.zip.ZipFile
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.protobuf.ProtoBuf
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class BackupContainerTest {
    private val directory = Files.createTempDirectory("backup-container").toFile()

    @AfterEach
    fun cleanUp() {
        directory.deleteRecursively()
    }

    private val backup = Backup(
        backupManga = emptyList(),
        backupCategories = listOf(BackupCategory(name = "Novels", order = 1)),
    )

    private fun gzipped(backup: Backup): ByteArray = ByteArrayOutputStream().also { output ->
        GZIPOutputStream(output).use { it.write(ProtoBuf.encodeToByteArray(Backup.serializer(), backup)) }
    }.toByteArray()

    @Test
    fun `a container with book files restores its backup and verified books`() {
        val bookBytes = "%PDF-1.7 test".toByteArray()
        val book = directory.resolve("book.pdf").apply { writeBytes(bookBytes) }
        val sha = BackupContainer.sha256(bookBytes.inputStream())
        val archive = directory.resolve("backup.epigraphbk")

        archive.outputStream().use { output ->
            BackupContainer.write(
                output,
                gzipped(backup),
                listOf(BackupContainer.LocalBookFile(sha, "PDF", book)),
                sourceFilename = "backup.tachibk",
                appVersion = "test",
                createdAt = Instant.EPOCH,
            )
        }

        assertEquals(listOf("Novels"), BackupUtil.decodeContainer(archive).backupCategories.map { it.name })
        assertEquals(listOf("Novels"), BackupUtil.decodeBackupBytes(archive.readBytes()).backupCategories.map { it.name })

        ZipFile(archive).use { zip ->
            val bookPath = BackupContainer.localBookPath(sha, "PDF")
            assertTrue(bookPath.endsWith("$sha.pdf"))
            assertEquals(sha, BackupContainer.sha256(zip.getInputStream(zip.getEntry(bookPath))))

            val manifest = Json.parseToJsonElement(zip.getInputStream(zip.getEntry(BackupContainer.MANIFEST_PATH)).reader().readText())
            assertEquals("epigraph-backup", manifest.jsonObject["format"]!!.jsonPrimitive.content)

            // Every entry but the checksum file itself is covered, with its real hash.
            val checksums = Json.parseToJsonElement(
                zip.getInputStream(zip.getEntry(BackupContainer.CHECKSUMS_PATH)).reader().readText(),
            ).jsonObject["entries"]!!.jsonObject
            val entries = zip.entries().toList().map { it.name }.filter { it != BackupContainer.CHECKSUMS_PATH }
            assertEquals(entries.toSet(), checksums.keys)
            entries.forEach { name ->
                assertEquals(checksums[name]!!.jsonPrimitive.content, BackupContainer.sha256(zip.getInputStream(zip.getEntry(name))))
            }
        }
    }

    @Test
    fun `book files are never mistaken for the manga payload`() {
        val archive = directory.resolve("backup.epigraphbk")
        val book = directory.resolve("book.epub").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val sha = BackupContainer.sha256(book.inputStream())
        archive.outputStream().use { output ->
            BackupContainer.write(output, gzipped(backup), listOf(BackupContainer.LocalBookFile(sha, "EPUB", book)), "b.tachibk", null)
        }

        assertEquals(listOf("Novels"), BackupUtil.decodeContainer(archive).backupCategories.map { it.name })
    }

    @Test
    fun `book paths reject anything but a SHA-256 and a book type`() {
        assertThrows<IllegalArgumentException> { BackupContainer.localBookPath("../escape", "PDF") }
        assertThrows<IllegalArgumentException> { BackupContainer.localBookPath("a".repeat(64), "EXE") }
    }

    @Test
    fun `book files are an opt-in option that survives the stored array`() {
        assertFalse(BackupOptions().bookFiles)
        val withBooks = BackupOptions(bookFiles = true)
        assertEquals(withBooks, BackupOptions.fromBooleanArray(withBooks.asBooleanArray()))
        // Arrays saved before the option existed (the retired private flag at index 9) keep it off.
        val legacy = BackupOptions().asBooleanArray().copyOf(10).also { it[9] = true }
        assertFalse(BackupOptions.fromBooleanArray(legacy).bookFiles)
    }
}
