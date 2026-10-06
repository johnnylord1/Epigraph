package eu.kanade.tachiyomi.data.backup

import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest
import java.time.Instant
import java.util.zip.Deflater
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Epigraph's unified backup container (the ZIP layout the desktop app writes), used on Android
 * when a backup also carries the private EPUB/PDF files of local books.
 *
 * The Android backup goes in the manga payload as a gzipped `.tachibk`, exactly like a desktop
 * container, so either app can restore it. The book files sit beside it, named by their SHA-256;
 * desktop ignores them and Android verifies each one against that hash before importing it.
 */
object BackupContainer {
    const val MANIFEST_PATH = "manifest.json"
    const val CHECKSUMS_PATH = "checksums/sha256.json"
    const val MANGA_ROOT = "payloads/manga"
    const val MANGA_MANIFEST_PATH = "$MANGA_ROOT/manifest.json"
    const val MANGA_PAYLOAD_NAME = "library.tachibk"
    const val LOCAL_BOOKS_NAME = "local-books"
    const val LOCAL_BOOKS_DIRECTORY = "$MANGA_ROOT/$LOCAL_BOOKS_NAME/"

    /** Archive path of the stored file of a local book with [sha256] and content type [contentType]. */
    fun localBookPath(sha256: String, contentType: String): String =
        "$LOCAL_BOOKS_DIRECTORY${localBookName(sha256, contentType)}"

    private fun localBookName(sha256: String, contentType: String): String {
        require(sha256.matches(SHA_256)) { "Invalid local book SHA-256" }
        val extension = when (contentType.uppercase()) {
            "EPUB" -> "epub"
            "PDF" -> "pdf"
            else -> throw IllegalArgumentException("Unsupported local book type: $contentType")
        }
        return "$sha256.$extension"
    }

    class LocalBookFile(val sha256: String, val contentType: String, val file: File)

    /**
     * Writes a container with [gzippedBackup] as the manga payload and every [books] file beside
     * it, streaming each file so none has to fit in memory.
     */
    fun write(
        output: OutputStream,
        gzippedBackup: ByteArray,
        books: List<LocalBookFile>,
        sourceFilename: String,
        appVersion: String?,
        createdAt: Instant = Instant.now(),
    ) {
        val checksums = sortedMapOf<String, String>()
        val payloadFiles = mutableListOf<JsonObject>()
        val zip = ZipOutputStream(output)

        fun putEntry(path: String, level: Int, write: (OutputStream) -> Unit): Pair<Long, String> {
            zip.setLevel(level)
            zip.putNextEntry(ZipEntry(path))
            val digest = MessageDigest.getInstance("SHA-256")
            val counting = DigestingOutputStream(zip, digest)
            write(counting)
            zip.closeEntry()
            val sha = digest.digest().toHex()
            checksums[path] = sha
            return counting.count to sha
        }

        fun putJson(path: String, json: JsonObject) {
            val bytes = (PRETTY_JSON.encodeToString(JsonObject.serializer(), json) + "\n").toByteArray(Charsets.UTF_8)
            putEntry(path, Deflater.DEFAULT_COMPRESSION) { it.write(bytes) }
        }

        // The payload is already gzipped and books are compressed formats; speed over size.
        val (payloadSize, payloadSha) = putEntry("$MANGA_ROOT/$MANGA_PAYLOAD_NAME", Deflater.BEST_SPEED) {
            it.write(gzippedBackup)
        }
        payloadFiles += fileEntry(MANGA_PAYLOAD_NAME, payloadSize, payloadSha, "application/octet-stream", "backup")

        books.distinctBy { it.sha256 }.forEach { book ->
            val name = localBookName(book.sha256, book.contentType)
            val (size, sha) = putEntry("$LOCAL_BOOKS_DIRECTORY$name", Deflater.BEST_SPEED) { out ->
                book.file.inputStream().use { it.copyTo(out) }
            }
            val mimeType = if (name.endsWith(".pdf")) "application/pdf" else "application/epub+zip"
            payloadFiles += fileEntry("$LOCAL_BOOKS_NAME/$name", size, sha, mimeType, "local-book")
        }

        val created = createdAt.toString()
        putJson(
            MANGA_MANIFEST_PATH,
            buildJsonObject {
                put("kind", "manga")
                put("payloadVersion", 1)
                put("createdAt", created)
                put("exportMode", "pipeline")
                putJsonArray("restoreModesSupported") { add(JsonPrimitive("pipeline")) }
                put("requiresRuntime", "suwayomi")
                put("requiresRepositories", JsonArray(emptyList()))
                put("portableByDefault", true)
                putJsonObject("metadata") {
                    put("schemaVersion", 1)
                    put("embeddedFormat", "tachibk")
                    put("sourceFilename", sourceFilename)
                    put("repositoryCount", 0)
                    put("localBookFileCount", payloadFiles.size - 1)
                }
                put("files", JsonArray(payloadFiles))
            },
        )
        putJson(
            MANIFEST_PATH,
            buildJsonObject {
                put("format", "epigraph-backup")
                put("formatVersion", 1)
                put("createdAt", created)
                put("packaging", "zip")
                put("checksumsPath", CHECKSUMS_PATH)
                putJsonObject("createdBy") {
                    put("app", "Epigraph")
                    put("version", appVersion)
                    put("platform", "android")
                }
                putJsonObject("source") {
                    put("surface", "mobile")
                    put("profileId", JsonNull)
                }
                put(
                    "payloads",
                    buildJsonArray {
                        add(
                            buildJsonObject {
                                put("kind", "manga")
                                put("payloadVersion", 1)
                                put("payloadRoot", MANGA_ROOT)
                                put("manifestPath", MANGA_MANIFEST_PATH)
                                put("checksumPath", MANGA_MANIFEST_PATH)
                                put("exportMode", "pipeline")
                                put("fileCount", payloadFiles.size)
                                putJsonArray("restoreModesSupported") { add(JsonPrimitive("pipeline")) }
                                put("requiresRuntime", "suwayomi")
                                put("requiresRepositories", JsonArray(emptyList()))
                                put("portableByDefault", true)
                            },
                        )
                    },
                )
            },
        )

        val checksumBytes = (
            PRETTY_JSON.encodeToString(
                JsonObject.serializer(),
                buildJsonObject {
                    put("algorithm", "sha256")
                    put("entries", JsonObject(checksums.mapValues { JsonPrimitive(it.value) }))
                },
            ) + "\n"
            ).toByteArray(Charsets.UTF_8)
        zip.setLevel(Deflater.DEFAULT_COMPRESSION)
        zip.putNextEntry(ZipEntry(CHECKSUMS_PATH))
        zip.write(checksumBytes)
        zip.closeEntry()
        zip.finish()
        zip.flush()
    }

    /** SHA-256 of [input] as lowercase hex. */
    fun sha256(input: InputStream): String {
        val digest = MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
        }
        return digest.digest().toHex()
    }

    private fun fileEntry(path: String, size: Long, sha: String, contentType: String, role: String) = buildJsonObject {
        put("path", path)
        put("sizeBytes", size)
        put("checksumSha256", sha)
        put("contentType", contentType)
        put("role", role)
    }

    private fun ByteArray.toHex(): String = joinToString(separator = "") { "%02x".format(it) }

    private class DigestingOutputStream(
        private val target: OutputStream,
        private val digest: MessageDigest,
    ) : OutputStream() {
        var count = 0L
            private set

        override fun write(b: Int) {
            target.write(b)
            digest.update(b.toByte())
            count++
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            target.write(b, off, len)
            digest.update(b, off, len)
            count += len
        }

        // The entry is closed by the container; closing here would end the whole archive.
        override fun close() = Unit
    }

    private val SHA_256 = Regex("[0-9a-f]{64}")
    private val PRETTY_JSON = Json { prettyPrint = true }
}
