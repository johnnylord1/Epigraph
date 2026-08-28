package eu.kanade.tachiyomi.util

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import eu.kanade.tachiyomi.data.backup.create.BackupCreator
import eu.kanade.tachiyomi.data.backup.models.Backup
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPInputStream
import java.util.zip.ZipInputStream

object BackupUtil {
    /**
     * Decode a native protobuf backup or the manga payload from Epigraph's unified desktop
     * backup container. The extension is deliberately not consulted: `.epigraphbk` is shared by
     * both surfaces and `.aethonbk` remains a supported legacy alias.
     */
    @SuppressLint("Recycle")
    fun decodeBackup(context: Context, uri: Uri): Backup {
        val backupCreator = BackupCreator(context)

        val rawBackup = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
            ?: error("Unable to open backup")
        val backupBytes = when {
            rawBackup.isZipContainer() -> extractMangaPayload(rawBackup)
            rawBackup.isGzip() -> GZIPInputStream(ByteArrayInputStream(rawBackup)).use { it.readBytes() }
            else -> rawBackup
        }

        return backupCreator.parser.decodeFromByteArray(Backup.serializer(), backupBytes)
    }

    /**
     * Extracts the manga backup from a desktop unified container without attempting to import the
     * desktop-only books/novels payloads into the Android database.
     */
    internal fun extractMangaPayload(container: ByteArray): ByteArray {
        ZipInputStream(ByteArrayInputStream(container)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                val normalizedName = entry.name.replace('\\', '/')
                val isMangaBackup = !entry.isDirectory &&
                    normalizedName.startsWith("payloads/manga/", ignoreCase = true) &&
                    normalizedName.endsWith(".tachibk", ignoreCase = true)
                if (isMangaBackup) {
                    return readEntryAtMost(zip, MAX_MANGA_PAYLOAD_BYTES)
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        throw IllegalArgumentException(
            "This Epigraph backup container does not contain a manga backup for Android import",
        )
    }

    private fun readEntryAtMost(input: ZipInputStream, maxBytes: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > maxBytes) {
                throw IllegalArgumentException("The manga backup payload is too large")
            }
            output.write(buffer, 0, count)
        }
        return output.toByteArray()
    }

    private fun ByteArray.isGzip(): Boolean = size >= 2 &&
        this[0].toInt() and 0xff == 0x1f && this[1].toInt() and 0xff == 0x8b

    private fun ByteArray.isZipContainer(): Boolean {
        if (size < 4 || this[0].toInt() and 0xff != 0x50 || this[1].toInt() and 0xff != 0x4b) {
            return false
        }
        return (this[2].toInt() and 0xff == 0x03 && this[3].toInt() and 0xff == 0x04) ||
            (this[2].toInt() and 0xff == 0x05 && this[3].toInt() and 0xff == 0x06) ||
            (this[2].toInt() and 0xff == 0x07 && this[3].toInt() and 0xff == 0x08)
    }

    private const val MAX_MANGA_PAYLOAD_BYTES = 256 * 1024 * 1024
}
