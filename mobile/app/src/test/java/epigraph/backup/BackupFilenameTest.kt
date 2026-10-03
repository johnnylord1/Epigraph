package epigraph.backup

import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.data.backup.models.Backup
import eu.kanade.tachiyomi.util.BackupUtil
import java.io.ByteArrayOutputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class BackupFilenameTest {
    @Test
    fun `canonical and historical backup filenames remain discoverable`() {
        assertTrue(Backup.filenameRegex.matches("${BuildConfig.APPLICATION_ID}_2026-08-28_12-00.epigraphbk"))
        assertTrue(Backup.filenameRegex.matches("app.aethon.mobile.debug_2026-08-28_12-00.aethonbk"))
        assertTrue(Backup.filenameRegex.matches("tachiyomi_2026-08-28_12-00.tachibk"))
        assertTrue(Backup.filenameRegex.matches("aethon_2026-08-28_12-00.proto.gz"))
    }

    @Test
    fun `desktop unified container exposes its manga payload`() {
        val mangaPayload = byteArrayOf(0x0a, 0x01, 0x2a)
        val container = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                zip.putNextEntry(ZipEntry("manifest.json"))
                zip.write("{\"format\":\"epigraph-backup\"}".toByteArray())
                zip.closeEntry()
                zip.putNextEntry(ZipEntry("payloads/manga/library.tachibk"))
                zip.write(mangaPayload)
                zip.closeEntry()
            }
        }.toByteArray()

        assertArrayEquals(mangaPayload, BackupUtil.extractMangaPayload(container))
    }

    @Test
    fun `desktop container without manga payload is rejected`() {
        val container = ByteArrayOutputStream().also { output ->
            ZipOutputStream(output).use { zip ->
                zip.putNextEntry(ZipEntry("payloads/books/library.epigraphbk"))
                zip.write(byteArrayOf(1))
                zip.closeEntry()
            }
        }.toByteArray()

        assertThrows(IllegalArgumentException::class.java) { BackupUtil.extractMangaPayload(container) }
    }
}
