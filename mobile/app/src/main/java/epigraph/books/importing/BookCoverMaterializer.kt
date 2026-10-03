package epigraph.books.importing

import epigraph.books.local.BookCoverFormat
import epigraph.contract.ContentType
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.util.zip.ZipFile
import org.w3c.dom.Element
import org.w3c.dom.NodeList

/**
 * Creates a private, immutable thumbnail for an imported EPUB/PDF.
 *
 * The publication itself remains content-addressed. Covers are derived assets, stored below the
 * same private root and published only after an atomic write. A cover failure never invalidates a
 * valid book import; the library will use its existing type placeholder instead.
 */
class BookCoverMaterializer(
    private val storageRoot: File,
    private val maxBytes: Long = 8L * 1024L * 1024L,
) {
    fun materialize(file: File, contentType: ContentType, assetId: String): File? {
        if (!file.isFile || assetId.isBlank()) return null
        val coverDirectory = File(storageRoot, COVERS_DIRECTORY)
        if (!ensureDirectory(coverDirectory)) return null

        synchronized(this) {
            existingCover(coverDirectory, assetId)?.let { return it }
            val bytes = runCatching {
                when (contentType) {
                    ContentType.EPUB -> extractEpubCover(file) ?: extractFirstImageEntry(file)
                    ContentType.PDF -> renderPdfCover(file)
                    else -> null
                }
            }.getOrNull() ?: return null
            return writeCoverAtomically(coverDirectory, assetId, bytes)
        }
    }

    private fun writeCoverAtomically(directory: File, assetId: String, bytes: ByteArray): File? {
        if (bytes.isEmpty() || bytes.size.toLong() > maxBytes) return null
        val part = File(directory, "$assetId$PART_SUFFIX")
        return runCatching {
            FileOutputStream(part).use { output ->
                output.write(bytes)
                output.flush()
                output.fd.sync()
            }
            val mime = BookCoverFormat.detect(part) ?: return@runCatching null
            val extension = when (mime) {
                BookCoverFormat.JPEG -> "jpg"
                BookCoverFormat.PNG -> "png"
                BookCoverFormat.WEBP -> "webp"
                else -> return@runCatching null
            }
            val target = File(directory, "$assetId.$extension")
            if (target.isFile) {
                part.delete()
                return@runCatching target.takeIf { BookCoverFormat.detect(it) == mime }
            }
            if (!part.renameTo(target)) {
                if (target.isFile) {
                    part.delete()
                    target
                } else {
                    null
                }
            } else {
                target
            }
        }.getOrNull().also {
            if (it == null) runCatching { part.delete() }
        }
    }

    private fun existingCover(directory: File, assetId: String): File? =
        COVER_EXTENSIONS.asSequence()
            .map { File(directory, "$assetId.$it") }
            .firstOrNull { it.isFile && it.length() in 1..maxBytes && BookCoverFormat.detect(it) != null }

    private fun extractEpubCover(file: File): ByteArray? {
        ZipFile(file).use { zip ->
            val container = zip.getEntry(CONTAINER_PATH)?.let { readEntry(zip, it) } ?: return null
            val containerDocument = secureXml(container) ?: return null
            val rootfile = containerDocument.getElementsByTagNameNS("*", "rootfile").elements()
                .asSequence()
                .firstOrNull { it.getAttribute("media-type") == OPF_MEDIA_TYPE }
                ?: return null
            val packagePath = normalizeZipPath(rootfile.getAttribute("full-path")) ?: return null
            val packageEntry = zip.getEntry(packagePath) ?: return null
            val packageBytes = readEntry(zip, packageEntry) ?: return null
            val packageDocument = secureXml(packageBytes) ?: return null
            val manifestItems = packageDocument.getElementsByTagNameNS("*", "item").elements()
                .asSequence()
                .mapNotNull { item ->
                    val id = item.getAttribute("id").trim()
                    val href = item.getAttribute("href").trim()
                    val mediaType = item.getAttribute("media-type").trim().lowercase()
                    if (id.isBlank() || href.isBlank()) null else ManifestItem(
                        id = id,
                        href = href,
                        mediaType = mediaType,
                        properties = item.getAttribute("properties").orEmpty(),
                    )
                }
                .toList()
            if (manifestItems.isEmpty()) return null

            val coverId = packageDocument.getElementsByTagNameNS("*", "meta").elements()
                .asSequence()
                .firstOrNull { it.getAttribute("name").equals("cover", ignoreCase = true) }
                ?.getAttribute("content")
                ?.trim()
                ?.takeIf(String::isNotBlank)
            val candidates = buildList {
                coverId?.let { id -> manifestItems.firstOrNull { it.id == id }?.let(::add) }
                manifestItems.filter { it.properties.split(' ').contains("cover-image") }.forEach(::add)
                manifestItems.filter { it.mediaType.startsWith("image/") && it.href.contains("cover", true) }
                    .forEach(::add)
                manifestItems.filter { it.mediaType in IMAGE_MEDIA_TYPES }.forEach(::add)
            }.distinctBy { it.id }

            val packageDirectory = packagePath.substringBeforeLast('/', "")
            for (candidate in candidates) {
                if (candidate.mediaType !in IMAGE_MEDIA_TYPES) continue
                val path = resolveZipPath(packageDirectory, candidate.href) ?: continue
                val entry = zip.getEntry(path) ?: continue
                val bytes = readEntry(zip, entry) ?: continue
                if (bytes.size <= maxBytes && detectMime(bytes) != null) return bytes
            }

            // A few EPUB producers ship valid archives whose OPF namespace metadata is not
            // exposed consistently by Android's XML implementation (the same document parses
            // correctly on the JVM). The importer has already validated every ZIP path, so a
            // conservative image-entry fallback keeps the derived cover deterministic without
            // trusting remote resources or arbitrary filesystem paths.
            zip.entries().asSequence()
                .filterNot { it.isDirectory }
                .mapNotNull { entry ->
                    val path = normalizeZipPath(entry.name) ?: return@mapNotNull null
                    val lower = path.lowercase()
                    if (IMAGE_MEDIA_TYPES.any { lower.endsWith(it.substringAfter('/')) }) path else null
                }
                .sortedWith(compareBy<String> { !it.contains("cover", ignoreCase = true) }.thenBy { it })
                .forEach { path ->
                    val bytes = readEntry(zip, zip.getEntry(path) ?: return@forEach)
                    if (bytes != null && detectMime(bytes) != null) return bytes
                }
            return null
        }
    }

    /**
     * Last-resort cover extraction for EPUBs whose XML parser rejects an otherwise valid OPF.
     * The archive validator has already bounded and canonicalized every entry before this
     * method is called, so only local raster image entries are considered here.
     */
    private fun extractFirstImageEntry(file: File): ByteArray? = ZipFile(file).use { zip ->
        val paths = zip.entries().asSequence()
            .filterNot { it.isDirectory }
            .mapNotNull { entry ->
                val path = normalizeZipPath(entry.name) ?: return@mapNotNull null
                val lower = path.lowercase()
                if (IMAGE_EXTENSIONS.any { lower.endsWith(it) }) path else null
            }
            .sortedWith(compareBy<String> { !it.contains("cover", ignoreCase = true) }.thenBy { it })
            .toList()

        paths.asSequence().mapNotNull { path ->
            val bytes = readEntry(zip, zip.getEntry(path) ?: return@mapNotNull null)
            bytes?.takeIf { detectMime(it) != null }
        }.firstOrNull()
    }

    private fun renderPdfCover(file: File): ByteArray? {
        if (android.os.Build.VERSION.SDK_INT < 21) return null
        val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        return PdfRenderer(descriptor).use { renderer ->
            if (renderer.pageCount <= 0) return@use null
            renderer.openPage(0).use { page ->
                val maxDimension = 900
                val scale = minOf(1.0, maxDimension.toDouble() / maxOf(page.width, page.height).toDouble())
                val width = (page.width * scale).toInt().coerceAtLeast(1)
                val height = (page.height * scale).toInt().coerceAtLeast(1)
                val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                return@use page.run {
                    bitmap.eraseColor(Color.WHITE)
                    render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                    ByteArrayOutputStream().use { output ->
                        if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 88, output)) null
                        else output.toByteArray()
                    }.also { bitmap.recycle() }
                }
            }
        }
    }

    private fun readEntry(zip: ZipFile, entry: java.util.zip.ZipEntry): ByteArray? {
        val declared = entry.size
        if (declared > maxBytes || declared < -1L) return null
        zip.getInputStream(entry).use { input ->
            val output = ByteArrayOutputStream(if (declared > 0) declared.toInt() else 16 * 1024)
            val buffer = ByteArray(BUFFER_SIZE)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                if (total > maxBytes) return null
                output.write(buffer, 0, count)
            }
            return output.toByteArray()
        }
    }

    private fun secureXml(bytes: ByteArray): org.w3c.dom.Document? = SafeXml.parseOrNull(bytes)

    private fun resolveZipPath(base: String, href: String): String? {
        val cleanHref = href.substringBefore('#').substringBefore('?').replace('\\', '/')
        val raw = if (base.isBlank()) cleanHref else "$base/$cleanHref"
        return normalizeZipPath(raw)
    }

    private fun normalizeZipPath(path: String): String? {
        val result = ArrayDeque<String>()
        path.replace('\\', '/').split('/').forEach { segment ->
            when (segment) {
                "", "." -> Unit
                ".." -> if (result.isEmpty()) return null else result.removeLast()
                else -> result.addLast(segment)
            }
        }
        return result.joinToString("/").takeIf(String::isNotBlank)
    }

    private fun detectMime(bytes: ByteArray): String? {
        if (bytes.size >= 3 && bytes[0] == 0xff.toByte() && bytes[1] == 0xd8.toByte() && bytes[2] == 0xff.toByte()) {
            return BookCoverFormat.JPEG
        }
        if (bytes.size >= PNG_SIGNATURE.size && bytes.copyOfRange(0, PNG_SIGNATURE.size).contentEquals(PNG_SIGNATURE)) {
            return BookCoverFormat.PNG
        }
        if (bytes.size >= 12 && bytes.copyOfRange(0, 4).contentEquals(RIFF) &&
            bytes.copyOfRange(8, 12).contentEquals(WEBP_SIGNATURE)
        ) {
            return BookCoverFormat.WEBP
        }
        return null
    }

    private fun ensureDirectory(directory: File): Boolean =
        runCatching { directory.isDirectory || directory.mkdirs() || directory.isDirectory }.getOrDefault(false)

    private fun NodeList.elements(): List<Element> = buildList {
        for (index in 0 until length) {
            (item(index) as? Element)?.let(::add)
        }
    }

    private data class ManifestItem(
        val id: String,
        val href: String,
        val mediaType: String,
        val properties: String,
    )

    private companion object {
        const val COVERS_DIRECTORY = "covers"
        const val CONTAINER_PATH = "META-INF/container.xml"
        const val OPF_MEDIA_TYPE = "application/oebps-package+xml"
        const val PART_SUFFIX = ".part"
        const val BUFFER_SIZE = 32 * 1024
        val IMAGE_MEDIA_TYPES = setOf("image/jpeg", "image/jpg", "image/png", "image/webp")
        val IMAGE_EXTENSIONS = setOf(".jpg", ".jpeg", ".png", ".webp")
        val COVER_EXTENSIONS = setOf("jpg", "png", "webp")
        val PNG_SIGNATURE = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
        val RIFF = byteArrayOf(0x52, 0x49, 0x46, 0x46)
        val WEBP_SIGNATURE = byteArrayOf(0x57, 0x45, 0x42, 0x50)
    }
}
