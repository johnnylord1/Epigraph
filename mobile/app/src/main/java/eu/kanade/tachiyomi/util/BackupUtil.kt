package eu.kanade.tachiyomi.util

import android.annotation.SuppressLint
import android.content.Context
import android.net.Uri
import eu.kanade.tachiyomi.data.backup.lnreader.LnReaderBackupConverter
import eu.kanade.tachiyomi.data.backup.BackupContainer
import eu.kanade.tachiyomi.data.backup.models.Backup
import java.io.BufferedInputStream
import java.io.Closeable
import java.io.EOFException
import java.io.FilterInputStream
import java.io.IOException
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.zip.GZIPInputStream
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import kotlinx.serialization.protobuf.ProtoBuf

object BackupUtil {
    /**
     * Decode a native protobuf backup or the manga payload from Epigraph's unified desktop
     * backup container. The extension is deliberately not consulted: `.epigraphbk` is shared by
     * both surfaces and `.aethonbk` remains a supported legacy alias.
     *
     * An LNReader backup is converted to a native backup of its library novels.
     *
     * @param novelPluginLangs language code of each known novel plugin, read only for LNReader.
     * @param coverSink receives the covers stored in an LNReader backup; null skips them.
     */
    fun decodeBackup(
        context: Context,
        uri: Uri,
        novelPluginLangs: () -> Map<String, String> = { emptyMap() },
        coverSink: ((String, ByteArray) -> Unit)? = null,
    ): Backup = openBackup(context, uri, novelPluginLangs, coverSink).use { it.backup }

    /**
     * Like [decodeBackup], but keeps the archive of a unified container open so a restore can read
     * the local EPUB/PDF files stored beside the manga payload. Close the result when done.
     */
    @SuppressLint("Recycle")
    fun openBackup(
        context: Context,
        uri: Uri,
        novelPluginLangs: () -> Map<String, String> = { emptyMap() },
        coverSink: ((String, ByteArray) -> Unit)? = null,
    ): OpenedBackup {
        val input = context.contentResolver.openInputStream(uri)?.let(::BufferedInputStream)
            ?: error("Unable to open backup")
        input.use {
            val header = ByteArray(4)
            input.mark(header.size)
            val headerSize = input.read(header).coerceAtLeast(0)
            input.reset()
            if (!header.copyOf(headerSize).isZipContainer()) {
                return OpenedBackup(decodeBackupBytes(readAtMost(input, MAX_BACKUP_FILE_BYTES, "The backup file is too large")), null)
            }
            // Archives are read from a private copy: LNReader backups and containers with book
            // files can be far larger than memory, and only a few entries are needed at a time.
            val archive = File.createTempFile("backup", ".zip", context.cacheDir)
            try {
                archive.outputStream().use { copyAtMost(input, it, MAX_ARCHIVE_FILE_BYTES, "The backup file is too large") }
                val isLnReader = ZipFile(archive).use(LnReaderBackupConverter::isLnReaderBackup)
                if (isLnReader) {
                    val backup = LnReaderBackupConverter(novelPluginLangs()).convert(archive, context.cacheDir, coverSink)
                    archive.delete()
                    return OpenedBackup(backup, null)
                }
                return OpenedBackup(decodeContainer(archive), archive)
            } catch (error: Throwable) {
                archive.delete()
                throw error
            }
        }
    }

    /** Decodes the manga payload of a unified container stored in [archive]. */
    internal fun decodeContainer(archive: File): Backup {
        val payload = ZipFile(archive).use { zip ->
            val entry = zip.entries().asSequence().firstOrNull { it.isMangaPayload() }
                ?: throw IllegalArgumentException(
                    "This Epigraph backup container does not contain a manga backup for Android import",
                )
            zip.getInputStream(entry).use { readAtMost(it, MAX_MANGA_PAYLOAD_BYTES, "The manga backup payload is too large") }
        }
        return decodePayload(payload)
    }

    /** Decodes backup bytes, bounding decompression so a small gzip bomb cannot exhaust memory. */
    internal fun decodeBackupBytes(rawBackup: ByteArray): Backup = if (rawBackup.isZipContainer()) {
        decodePayload(extractMangaPayload(rawBackup))
    } else {
        decodePayload(rawBackup)
    }

    /** A manga payload is a gzipped `.tachibk` (desktop and Android) or a raw protobuf. */
    private fun decodePayload(rawBackup: ByteArray): Backup {
        val backupBytes = if (rawBackup.isGzip()) {
            try {
                GZIPInputStream(ByteArrayInputStream(rawBackup)).use {
                    readAtMost(it, MAX_MANGA_PAYLOAD_BYTES, "The decompressed backup is too large")
                }
            } catch (error: EOFException) {
                // A backup picked while another app is still writing it ends early.
                throw IOException(
                    "The backup file is incomplete. If another app is still saving it, wait until it finishes and try again.",
                    error,
                )
            }
        } else {
            rawBackup
        }

        return ProtoBuf.decodeFromByteArray(Backup.serializer(), backupBytes)
    }

    /**
     * Extracts the manga backup from a desktop unified container without attempting to import the
     * desktop-only books/novels payloads into the Android database.
     */
    internal fun extractMangaPayload(container: ByteArray): ByteArray {
        ZipInputStream(ByteArrayInputStream(container)).use { zip ->
            var entry = zip.nextEntry
            while (entry != null) {
                if (entry.isMangaPayload()) {
                    return readAtMost(zip, MAX_MANGA_PAYLOAD_BYTES, "The manga backup payload is too large")
                }
                zip.closeEntry()
                entry = zip.nextEntry
            }
        }
        throw IllegalArgumentException(
            "This Epigraph backup container does not contain a manga backup for Android import",
        )
    }

    internal fun readAtMost(input: InputStream, maxBytes: Int, message: String): ByteArray {
        val output = ByteArrayOutputStream()
        copyAtMost(input, output, maxBytes.toLong(), message)
        return output.toByteArray()
    }

    private fun copyAtMost(input: InputStream, output: java.io.OutputStream, maxBytes: Long, message: String) {
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        var total = 0L
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (total > maxBytes) {
                throw IllegalArgumentException(message)
            }
            output.write(buffer, 0, count)
        }
    }

    private fun ZipEntry.isMangaPayload(): Boolean {
        val normalizedName = name.replace('\\', '/')
        return !isDirectory &&
            normalizedName.startsWith("payloads/manga/", ignoreCase = true) &&
            !normalizedName.startsWith(BackupContainer.LOCAL_BOOKS_DIRECTORY, ignoreCase = true) &&
            normalizedName.endsWith(".tachibk", ignoreCase = true)
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
    private const val MAX_BACKUP_FILE_BYTES = 256 * 1024 * 1024

    /** LNReader backups may include downloaded chapters; they are never loaded into memory. */
    private const val MAX_ARCHIVE_FILE_BYTES = 4L * 1024 * 1024 * 1024
}

/**
 * A decoded backup. When it came from a unified container, the private copy of that archive stays
 * available until [close] so the local book files stored in it can be restored.
 */
class OpenedBackup internal constructor(
    val backup: Backup,
    private val archive: File?,
) : Closeable {
    /** Opens the stored entry at [path], or returns null when the backup does not carry it. */
    fun openEntry(path: String): InputStream? {
        val file = archive?.takeIf(File::isFile) ?: return null
        val zip = ZipFile(file)
        val entry = zip.getEntry(path)
        if (entry == null || entry.isDirectory) {
            zip.close()
            return null
        }
        return object : FilterInputStream(zip.getInputStream(entry)) {
            override fun close() {
                try {
                    super.close()
                } finally {
                    zip.close()
                }
            }
        }
    }

    fun hasEntry(path: String): Boolean {
        val file = archive?.takeIf(File::isFile) ?: return false
        return ZipFile(file).use { zip -> zip.getEntry(path)?.isDirectory == false }
    }

    override fun close() {
        archive?.delete()
    }
}
