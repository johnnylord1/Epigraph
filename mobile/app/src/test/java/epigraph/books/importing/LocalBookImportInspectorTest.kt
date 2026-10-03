package epigraph.books.importing

import epigraph.contract.ContentType
import java.io.File
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class LocalBookImportInspectorTest {
    @TempDir
    lateinit var directory: File

    @Test
    fun `pdf inspection produces a content addressed manifest`() {
        val pdf = File(directory, "sample.pdf").apply {
            writeBytes("%PDF-1.7\nbody".toByteArray())
        }

        val manifest = LocalBookImportInspector().inspect(
            LocalBookImportRequest(pdf, ContentType.PDF, "Sample"),
        )

        assertEquals(ContentType.PDF, manifest.contentType)
        assertEquals("pdf:sha256:${manifest.assetId.value}", manifest.entityId.value)
        assertEquals("application/pdf", manifest.mediaType)
        assertEquals(pdf.length(), manifest.byteSize)
        assertEquals("3f972854841afd236b04b5d7435b73216bc5fa6e39a86aff6e492b744086189c", manifest.assetId.value)
        assertNull(manifest.epubArchive)
    }

    @Test
    fun `epub inspection includes its validated archive manifest`() {
        val epub = validEpub()

        val manifest = LocalBookImportInspector().inspect(
            LocalBookImportRequest(epub, ContentType.EPUB),
        )

        assertEquals(ContentType.EPUB, manifest.contentType)
        assertEquals(epub.length(), manifest.byteSize)
        assertNotNull(manifest.epubArchive)
        assertEquals(4, manifest.epubArchive?.entries?.size)
        assertEquals("OEBPS/content.opf", manifest.epubArchive?.packagePath)
        assertEquals(listOf("OEBPS/chapter.xhtml"), manifest.epubArchive?.spinePaths)
    }

    @Test
    fun `pdf extension cannot disguise a non pdf payload`() {
        val fake = File(directory, "fake.pdf").apply { writeText("not a PDF") }

        val failure = assertThrows(BookImportValidationException::class.java) {
            LocalBookImportInspector().inspect(LocalBookImportRequest(fake, ContentType.PDF))
        }

        assertEquals(BookImportFailure.INVALID_PDF_HEADER, failure.failure)
    }

    private fun validEpub(): File {
        val file = File(directory, "book.epub")
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
                      <manifest>
                        <item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/>
                      </manifest>
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
}
