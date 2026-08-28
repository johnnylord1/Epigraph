package epigraph.books.importing

import epigraph.contract.ContentType
import epigraph.books.local.BookCoverFormat
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertArrayEquals
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class LocalBookPrivateImporterTest {
    @TempDir
    lateinit var directory: File

    @Test
    fun `copies validates hashes and atomically publishes a detected pdf`() {
        val bytes = "%PDF-1.7\nprivate book".toByteArray()
        val store = File(directory, "store")

        val result = LocalBookPrivateImporter(store).import(
            PrivateBookImportRequest(ByteArrayBookSource("Chosen name.pdf", bytes)),
        )

        assertEquals(ContentType.PDF, result.manifest.contentType)
        assertEquals("Chosen name.pdf", result.manifest.displayName)
        assertEquals(PrivateBookImportDisposition.IMPORTED, result.disposition)
        assertEquals("${result.manifest.assetId.value}.pdf", result.privateFile.name)
        assertEquals(File(store, "pdf").canonicalFile, requireNotNull(result.privateFile.parentFile).canonicalFile)
        assertArrayEquals(bytes, result.privateFile.readBytes())
        assertNoPublishedParts(store)
    }

    @Test
    fun `reimporting identical bytes is idempotent and preserves the final blob`() {
        val bytes = "%PDF-1.4\nsame bytes".toByteArray()
        val importer = LocalBookPrivateImporter(File(directory, "store"))
        val first = importer.import(PrivateBookImportRequest(ByteArrayBookSource("First.pdf", bytes)))
        val firstModified = first.privateFile.lastModified()

        val second = importer.import(PrivateBookImportRequest(ByteArrayBookSource("Renamed.pdf", bytes)))

        assertEquals(PrivateBookImportDisposition.ALREADY_PRESENT, second.disposition)
        assertEquals(first.privateFile.canonicalFile, second.privateFile.canonicalFile)
        assertEquals(firstModified, second.privateFile.lastModified())
        assertEquals("Renamed.pdf", second.manifest.displayName)
        assertArrayEquals(bytes, second.privateFile.readBytes())
        assertNoPublishedParts(File(directory, "store"))
    }

    @Test
    fun `detects validates and publishes an epub without trusting its filename`() {
        val sourceEpub = validEpub(File(directory, "actually-a-book.bin"))
        val store = File(directory, "store")

        val result = LocalBookPrivateImporter(store).import(
            PrivateBookImportRequest(ByteArrayBookSource("Novel without extension", sourceEpub.readBytes())),
        )

        assertEquals(ContentType.EPUB, result.manifest.contentType)
        assertEquals(PrivateBookImportDisposition.IMPORTED, result.disposition)
        assertEquals(listOf("OEBPS/chapter.xhtml"), result.manifest.epubArchive?.spinePaths)
        assertTrue(result.privateFile.name.endsWith(".epub"))
        assertArrayEquals(sourceEpub.readBytes(), result.privateFile.readBytes())
    }

    @Test
    fun `materializes the declared epub cover into private storage`() {
        val sourceEpub = validEpubWithCover(File(directory, "cover-book.epub"))
        val result = LocalBookPrivateImporter(File(directory, "store")).import(
            PrivateBookImportRequest(ByteArrayBookSource("cover-book.epub", sourceEpub.readBytes())),
        )

        val cover = requireNotNull(result.coverFile)
        assertEquals(File(directory, "store/covers").canonicalFile, cover.parentFile?.canonicalFile)
        assertEquals(BookCoverFormat.PNG, BookCoverFormat.detect(cover))
        assertArrayEquals(PNG_COVER_BYTES, cover.readBytes())
    }

    @Test
    fun `inspection validates a source without publishing a blob`() {
        val store = File(directory, "store")
        val manifest = LocalBookPrivateImporter(store).inspect(
            PrivateBookImportRequest(
                ByteArrayBookSource("preview.pdf", "%PDF-1.7\npreview".toByteArray()),
            ),
        )

        assertEquals(ContentType.PDF, manifest.contentType)
        assertEquals(0, File(store, "pdf").listFiles().orEmpty().size)
        assertNoPublishedParts(store)
    }

    @Test
    fun `rejects a content type mismatch and removes the unpublished part`() {
        val store = File(directory, "store")
        val failure = assertThrows(BookImportValidationException::class.java) {
            LocalBookPrivateImporter(store).import(
                PrivateBookImportRequest(
                    source = ByteArrayBookSource("wrong.epub", "%PDF-1.7\nbody".toByteArray()),
                    expectedContentType = ContentType.EPUB,
                ),
            )
        }

        assertEquals(BookImportFailure.CONTENT_TYPE_MISMATCH, failure.failure)
        assertNoBookBlobs(store)
        assertNoPublishedParts(store)
    }

    @Test
    fun `bounded copy rejects an oversized stream before publication`() {
        val store = File(directory, "store")
        val importer = LocalBookPrivateImporter(
            store,
            LocalBookImportLimits(maxBookBytes = 8, epub = EpubArchiveLimits(maxArchiveBytes = 8)),
        )

        val failure = assertThrows(BookImportValidationException::class.java) {
            importer.import(
                PrivateBookImportRequest(ByteArrayBookSource("large.pdf", "%PDF-123456789".toByteArray())),
            )
        }

        assertEquals(BookImportFailure.FILE_TOO_LARGE, failure.failure)
        assertNoBookBlobs(store)
        assertNoPublishedParts(store)
    }

    @Test
    fun `stream failure removes its unpublished private copy`() {
        val store = File(directory, "store")
        val source = object : LocalBookStreamSource {
            override val displayName = "broken.pdf"

            override fun openStream(): InputStream = object : InputStream() {
                private val prefix = "%PDF-".toByteArray()
                private var index = 0

                override fun read(): Int {
                    if (index < prefix.size) return prefix[index++].toInt() and 0xff
                    throw IOException("provider disconnected")
                }
            }
        }

        val failure = assertThrows(BookImportValidationException::class.java) {
            LocalBookPrivateImporter(store).import(PrivateBookImportRequest(source))
        }

        assertEquals(BookImportFailure.COPY_FAILED, failure.failure)
        assertNoBookBlobs(store)
        assertNoPublishedParts(store)
    }

    @Test
    fun `a corrupt preexisting content address is preserved and reported as collision`() {
        val store = File(directory, "store")
        val bytes = "%PDF-1.7\nexpected".toByteArray()
        val digest = StreamingSha256.digest(ByteArrayInputStream(bytes))
        val occupied = File(File(store, "pdf"), "${digest.assetId.value}.pdf").apply {
            requireNotNull(parentFile).mkdirs()
            writeText("corrupt existing data")
        }

        val failure = assertThrows(BookImportValidationException::class.java) {
            LocalBookPrivateImporter(store).import(
                PrivateBookImportRequest(ByteArrayBookSource("expected.pdf", bytes)),
            )
        }

        assertEquals(BookImportFailure.ASSET_COLLISION, failure.failure)
        assertEquals("corrupt existing data", occupied.readText())
        assertNoPublishedParts(store)
    }

    @Test
    fun `cleanup removes only stale unpublished parts`() {
        val store = File(directory, "store")
        val staging = File(store, ".staging").apply { mkdirs() }
        val stale = File(staging, "old.part").apply {
            writeText("partial")
            setLastModified(1_000)
        }
        val recent = File(staging, "recent.part").apply {
            writeText("partial")
            setLastModified(10_000)
        }
        val unrelated = File(staging, "keep.txt").apply {
            writeText("not managed")
            setLastModified(1_000)
        }

        val deleted = LocalBookPrivateImporter(store).cleanupAbandonedParts(5_000)

        assertEquals(1, deleted)
        assertFalse(stale.exists())
        assertTrue(recent.exists())
        assertTrue(unrelated.exists())
    }

    private fun assertNoPublishedParts(store: File) {
        assertTrue(
            File(store, ".staging").listFiles().orEmpty().none { it.name.endsWith(".part") },
            "No unpublished .part file should remain",
        )
    }

    private fun assertNoBookBlobs(store: File) {
        assertTrue(File(store, "epub").listFiles().orEmpty().isEmpty())
        assertTrue(File(store, "pdf").listFiles().orEmpty().isEmpty())
    }

    private fun validEpub(file: File): File {
        ZipOutputStream(file.outputStream()).use { output ->
            val mimetype = "application/epub+zip".toByteArray()
            val crc = CRC32().apply { update(mimetype) }
            output.putNextEntry(
                ZipEntry("mimetype").apply {
                    method = ZipEntry.STORED
                    size = mimetype.size.toLong()
                    compressedSize = mimetype.size.toLong()
                    this.crc = crc.value
                },
            )
            output.write(mimetype)
            output.closeEntry()
            output.putNextEntry(ZipEntry("META-INF/container.xml"))
            output.write(
                """
                    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
                      <rootfiles>
                        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                      </rootfiles>
                    </container>
                """.trimIndent().toByteArray(),
            )
            output.closeEntry()
            output.putNextEntry(ZipEntry("OEBPS/content.opf"))
            output.write(
                """
                    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
                      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                        <dc:identifier id="book-id">test-book</dc:identifier>
                        <dc:title>Test</dc:title>
                        <dc:language>en</dc:language>
                      </metadata>
                      <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
                      <spine><itemref idref="chapter"/></spine>
                    </package>
                """.trimIndent().toByteArray(),
            )
            output.closeEntry()
            output.putNextEntry(ZipEntry("OEBPS/chapter.xhtml"))
            output.write("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>Hello</body></html>".toByteArray())
            output.closeEntry()
        }
        return file
    }

    private fun validEpubWithCover(file: File): File {
        ZipOutputStream(file.outputStream()).use { output ->
            val mimetype = "application/epub+zip".toByteArray()
            val crc = CRC32().apply { update(mimetype) }
            output.putNextEntry(
                ZipEntry("mimetype").apply {
                    method = ZipEntry.STORED
                    size = mimetype.size.toLong()
                    compressedSize = mimetype.size.toLong()
                    this.crc = crc.value
                },
            )
            output.write(mimetype)
            output.closeEntry()
            output.putNextEntry(ZipEntry("META-INF/container.xml"))
            output.write(
                """
                    <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
                      <rootfiles>
                        <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
                      </rootfiles>
                    </container>
                """.trimIndent().toByteArray(),
            )
            output.closeEntry()
            output.putNextEntry(ZipEntry("OEBPS/content.opf"))
            output.write(
                """
                    <package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
                      <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                        <dc:identifier id="book-id">cover-book</dc:identifier>
                        <dc:title>Cover book</dc:title>
                        <meta name="cover" content="cover-image"/>
                      </metadata>
                      <manifest>
                        <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
                        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
                      </manifest>
                      <spine><itemref idref="chapter"/></spine>
                    </package>
                """.trimIndent().toByteArray(),
            )
            output.closeEntry()
            output.putNextEntry(ZipEntry("OEBPS/images/cover.png"))
            output.write(PNG_COVER_BYTES)
            output.closeEntry()
            output.putNextEntry(ZipEntry("OEBPS/chapter.xhtml"))
            output.write("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>Cover</body></html>".toByteArray())
            output.closeEntry()
        }
        return file
    }

    private class ByteArrayBookSource(
        override val displayName: String,
        private val bytes: ByteArray,
    ) : LocalBookStreamSource {
        override fun openStream(): InputStream = ByteArrayInputStream(bytes)
    }

    private companion object {
        val PNG_COVER_BYTES = byteArrayOf(
            0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            0x00, 0x00, 0x00, 0x00,
        )
    }
}
