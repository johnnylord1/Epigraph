package epigraph.books.importing

import epigraph.contract.ContentType
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
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

    @Test
    fun `a bookmark title is not the title of the book`() {
        val pdf = File(directory, "my_book.pdf")
        Files.write(
            pdf.toPath(),
            """
            %PDF-1.4
            1 0 obj << /Type /Catalog /Outlines 2 0 R >> endobj
            3 0 obj << /Title (Part One) /Parent 2 0 R >> endobj
            trailer << /Root 1 0 R >>
            """.trimIndent().toByteArray(),
        )

        assertEquals("my book", BookImportMetadataExtractor.extract(pdf, ContentType.PDF, pdf.name).title)
    }

    @Test
    fun `reads the info dictionary the trailer names, past the bookmarks`() {
        val pdf = File(directory, "my_book.pdf")
        Files.write(
            pdf.toPath(),
            """
            %PDF-1.4
            1 0 obj << /Type /Catalog /Outlines 2 0 R >> endobj
            3 0 obj << /Title (Part One) /Parent 2 0 R >> endobj
            13 0 obj << /Title (Other object) >> endobj
            3 0 obj << /Title (Book title) /Author (Book author) >> endobj
            trailer << /Root 1 0 R /Info 3 0 R >>
            """.trimIndent().toByteArray(),
        )

        val metadata = BookImportMetadataExtractor.extract(pdf, ContentType.PDF, pdf.name)

        assertEquals("Book title", metadata.title)
        assertEquals("Book author", metadata.author)
    }

    @Test
    fun `decodes utf-16 literal titles written with a byte order mark`() {
        val pdf = File(directory, "scan.pdf")
        val title = byteArrayOf(0xfe.toByte(), 0xff.toByte()) + "Livro Ç".toByteArray(Charsets.UTF_16BE)
        Files.write(pdf.toPath(), "%PDF-1.4 /Title (".toByteArray() + title + ") /Author (A)".toByteArray())

        assertEquals("Livro Ç", BookImportMetadataExtractor.extract(pdf, ContentType.PDF, pdf.name).title)
    }

    @Test
    fun `recognizes titles saved with an undecoded byte order mark`() {
        assertTrue(BookImportMetadataExtractor.isMisdecodedPdfTitle("\u00fe\u00ff\u0000L\u0000i"))
        assertTrue(BookImportMetadataExtractor.isMisdecodedPdfTitle("\u00ef\u00bb\u00bfLivro"))
        assertFalse(BookImportMetadataExtractor.isMisdecodedPdfTitle("Livro \u00c7"))
    }

    @Test
    fun `finds the info dictionary at the end of a large pdf`() {
        val pdf = File(directory, "large.pdf")
        pdf.outputStream().use { output ->
            output.write("%PDF-1.7\n".toByteArray())
            output.write(ByteArray(5 * 1024 * 1024) { ' '.code.toByte() })
            output.write("/Title (Tail title)".toByteArray())
        }

        assertEquals("Tail title", BookImportMetadataExtractor.extract(pdf, ContentType.PDF, pdf.name).title)
    }
}
