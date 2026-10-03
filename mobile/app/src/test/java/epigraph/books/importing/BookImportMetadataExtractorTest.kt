package epigraph.books.importing

import epigraph.contract.ContentType
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class BookImportMetadataExtractorTest {
    @TempDir
    lateinit var directory: File

    @Test
    fun `reads epub dc metadata and strips html from description`() {
        val epub = File(directory, "metadata.epub")
        ZipOutputStream(epub.outputStream()).use { zip ->
            zip.putNextEntry(ZipEntry("META-INF/container.xml"))
            zip.write(
                """
                <?xml version="1.0"?>
                <container xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
                  <rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
                </container>
                """.trimIndent().toByteArray(),
            )
            zip.closeEntry()
            zip.putNextEntry(ZipEntry("OEBPS/package.opf"))
            zip.write(
                """
                <?xml version="1.0" encoding="UTF-8"?>
                <package xmlns="http://www.idpf.org/2007/opf" unique-identifier="id">
                  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
                    <dc:title> A Real Title </dc:title>
                    <dc:creator>Author Name</dc:creator>
                    <dc:description><![CDATA[<p>A <b>description</b>.</p>]]></dc:description>
                  </metadata>
                  <manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest>
                  <spine><itemref idref="chapter"/></spine>
                </package>
                """.trimIndent().toByteArray(),
            )
            zip.closeEntry()
        }

        val metadata = BookImportMetadataExtractor.extract(epub, ContentType.EPUB, "fallback.epub")

        assertEquals("A Real Title", metadata.title)
        assertEquals("Author Name", metadata.author)
        assertEquals("A description.", metadata.description)
    }

    @Test
    fun `reads simple pdf info dictionary and falls back to cleaned filename`() {
        val pdf = File(directory, "my_book.pdf")
        Files.write(pdf.toPath(), "%PDF-1.7 /Title (PDF title) /Author (PDF author)".toByteArray())

        val metadata = BookImportMetadataExtractor.extract(pdf, ContentType.PDF, pdf.name)

        assertEquals("PDF title", metadata.title)
        assertEquals("PDF author", metadata.author)
        assertEquals(null, metadata.description)
    }
}
