package epigraph.books.importing

import java.io.File
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class EpubArchiveValidatorTest {
    @TempDir
    lateinit var directory: File

    @Test
    fun `creates a bounded manifest for a structurally valid epub`() {
        val file = epub(
            "OEBPS/chapter.xhtml" to "<html><body>Hello</body></html>".toByteArray(),
        )

        val manifest = EpubArchiveValidator.validate(file)

        assertEquals("META-INF/container.xml", manifest.containerPath)
        assertEquals("OEBPS/content.opf", manifest.packagePath)
        assertEquals(listOf("OEBPS/chapter.xhtml"), manifest.spinePaths)
        assertEquals(4, manifest.entries.size)
        assertTrue(manifest.entries.any { it.path == "OEBPS/chapter.xhtml" })
        assertEquals(manifest.entries.sumOf { it.uncompressedBytes }, manifest.totalUncompressedBytes)
    }

    @Test
    fun `accepts an epub 2 package with a relative resource that remains inside the archive`() {
        val file = epub(
            "OPS/Text/chapter.xhtml" to "<html><body>EPUB 2</body></html>".toByteArray(),
            packagePath = "OPS/Package/content.opf",
            packageXml = packageXml(href = "../Text/chapter.xhtml", version = "2.0"),
            includeChapter = false,
        )

        val manifest = EpubArchiveValidator.validate(file)

        assertEquals("OPS/Package/content.opf", manifest.packagePath)
        assertEquals(listOf("OPS/Text/chapter.xhtml"), manifest.spinePaths)
    }

    @Test
    fun `rejects parent traversal before an epub can be extracted`() {
        val file = epub("../outside.xhtml" to "unsafe".toByteArray())

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.UNSAFE_ARCHIVE_PATH, failure.failure)
    }

    @Test
    fun `rejects windows absolute and backslash paths`() {
        listOf("C:/outside.xhtml", "..\\outside.xhtml", "\\\\server\\book.xhtml").forEachIndexed { index, path ->
            val file = epub(path to "unsafe".toByteArray(), name = "unsafe-$index.epub")

            val failure = assertThrows(BookImportValidationException::class.java) {
                EpubArchiveValidator.validate(file)
            }

            assertEquals(BookImportFailure.UNSAFE_ARCHIVE_PATH, failure.failure)
        }
    }

    @Test
    fun `rejects normalized duplicate paths`() {
        val file = epub(
            "OEBPS/caf\u00e9.xhtml" to "one".toByteArray(),
            "OEBPS/cafe\u0301.xhtml" to "two".toByteArray(),
        )

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.DUPLICATE_ARCHIVE_PATH, failure.failure)
    }

    @Test
    fun `rejects a high compression ratio zip bomb`() {
        val file = epub("OEBPS/bomb.xhtml" to ByteArray(2 * 1024 * 1024))
        val strictLimits = EpubArchiveLimits(
            maxCompressionRatio = 10.0,
            minimumRatioCheckBytes = 1024,
        )

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file, strictLimits)
        }

        assertEquals(BookImportFailure.SUSPICIOUS_COMPRESSION_RATIO, failure.failure)
    }

    @Test
    fun `rejects archives exceeding the entry count limit`() {
        val file = epub(
            "OEBPS/one.xhtml" to "1".toByteArray(),
            "OEBPS/two.xhtml" to "2".toByteArray(),
        )

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file, EpubArchiveLimits(maxEntries = 5))
        }

        assertEquals(BookImportFailure.TOO_MANY_ARCHIVE_ENTRIES, failure.failure)
    }

    @Test
    fun `rejects an archive missing the mandatory epub container`() {
        val file = File(directory, "missing-container.epub")
        ZipOutputStream(file.outputStream()).use { output ->
            output.putStored("mimetype", "application/epub+zip".toByteArray())
        }

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects a mimetype entry that is compressed or not first`() {
        val compressed = File(directory, "compressed-mimetype.epub")
        ZipOutputStream(compressed.outputStream()).use { output ->
            output.putNextEntry(ZipEntry("mimetype"))
            output.write("application/epub+zip".toByteArray())
            output.closeEntry()
        }
        val compressedFailure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(compressed)
        }
        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, compressedFailure.failure)

        val misplaced = File(directory, "misplaced-mimetype.epub")
        ZipOutputStream(misplaced.outputStream()).use { output ->
            output.putNextEntry(ZipEntry("META-INF/"))
            output.closeEntry()
            output.putStored("mimetype", "application/epub+zip".toByteArray())
        }
        val misplacedFailure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(misplaced)
        }
        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, misplacedFailure.failure)
    }

    @Test
    fun `rejects a container without a namespaced package rootfile`() {
        val file = epub(containerXml = "<container/>")

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects doctype and external entity declarations before parsing metadata`() {
        val container = """
            <!DOCTYPE container [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
            <container xmlns="$CONTAINER_NAMESPACE"><rootfiles>&xxe;</rootfiles></container>
        """.trimIndent()
        val file = epub(containerXml = container)

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects a rootfile path escaping the archive`() {
        val container = containerXml("../content.opf")
        val file = epub(containerXml = container)

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.UNSAFE_ARCHIVE_PATH, failure.failure)
    }

    @Test
    fun `rejects a container pointing to a missing package document`() {
        val file = epub(includePackage = false)

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects an opf without a manifest and spine`() {
        val file = epub(packageXml = "<$PACKAGE_TAG version=\"3.0\"/>")

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects external and encoded escaping manifest references`() {
        listOf(
            "https://example.test/chapter.xhtml",
            "%2e%2e/%2e%2e/outside.xhtml",
            "%5c%5cserver%5cbook.xhtml",
        ).forEachIndexed { index, href ->
            val file = epub(
                name = "unsafe-href-$index.epub",
                packageXml = packageXml(href = href),
            )

            val failure = assertThrows(BookImportValidationException::class.java) {
                EpubArchiveValidator.validate(file)
            }

            assertEquals(BookImportFailure.UNSAFE_ARCHIVE_PATH, failure.failure)
        }
    }

    @Test
    fun `rejects manifest resources missing from the archive`() {
        val file = epub(
            packageXml = packageXml(href = "missing.xhtml"),
            includeChapter = false,
        )

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects spine references absent from the manifest`() {
        val file = epub(packageXml = packageXml(spineId = "missing"))

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    @Test
    fun `rejects an empty spine`() {
        val file = epub(packageXml = packageXml(spineId = null))

        val failure = assertThrows(BookImportValidationException::class.java) {
            EpubArchiveValidator.validate(file)
        }

        assertEquals(BookImportFailure.INVALID_EPUB_STRUCTURE, failure.failure)
    }

    private fun epub(
        vararg content: Pair<String, ByteArray>,
        name: String = "book.epub",
        packagePath: String = "OEBPS/content.opf",
        containerXml: String = containerXml(packagePath),
        packageXml: String = packageXml(),
        includePackage: Boolean = true,
        includeChapter: Boolean = true,
    ): File {
        val file = File(directory, name)
        ZipOutputStream(file.outputStream()).use { output ->
            output.putStored("mimetype", "application/epub+zip".toByteArray())
            output.putNextEntry(ZipEntry("META-INF/container.xml"))
            output.write(containerXml.toByteArray())
            output.closeEntry()
            if (includePackage) {
                output.putNextEntry(ZipEntry(packagePath))
                output.write(packageXml.toByteArray())
                output.closeEntry()
            }
            if (includeChapter && content.none { it.first == "OEBPS/chapter.xhtml" }) {
                output.putNextEntry(ZipEntry("OEBPS/chapter.xhtml"))
                output.write("<html xmlns=\"http://www.w3.org/1999/xhtml\"><body>Hello</body></html>".toByteArray())
                output.closeEntry()
            }
            content.forEach { (path, bytes) ->
                output.putNextEntry(ZipEntry(path))
                output.write(bytes)
                output.closeEntry()
            }
        }
        return file
    }

    private fun containerXml(packagePath: String = "OEBPS/content.opf"): String = """
        <container xmlns="$CONTAINER_NAMESPACE" version="1.0">
          <rootfiles>
            <rootfile full-path="$packagePath" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>
    """.trimIndent()

    private fun packageXml(
        href: String = "chapter.xhtml",
        spineId: String? = "chapter",
        version: String = "3.0",
    ): String = """
        <$PACKAGE_TAG version="$version" unique-identifier="book-id">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:identifier id="book-id">test-book</dc:identifier>
            <dc:title>Test</dc:title>
            <dc:language>en</dc:language>
          </metadata>
          <manifest>
            <item id="chapter" href="$href" media-type="application/xhtml+xml"/>
          </manifest>
          <spine>${spineId?.let { "<itemref idref=\"$it\"/>" }.orEmpty()}</spine>
        </package>
    """.trimIndent()

    private fun ZipOutputStream.putStored(path: String, bytes: ByteArray) {
        val crc = CRC32().apply { update(bytes) }
        putNextEntry(
            ZipEntry(path).apply {
                method = ZipEntry.STORED
                size = bytes.size.toLong()
                compressedSize = bytes.size.toLong()
                this.crc = crc.value
            },
        )
        write(bytes)
        closeEntry()
    }

    private companion object {
        const val CONTAINER_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:container"
        const val PACKAGE_TAG = "package xmlns=\"http://www.idpf.org/2007/opf\""
    }
}
