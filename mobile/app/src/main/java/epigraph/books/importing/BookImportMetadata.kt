package epigraph.books.importing

import epigraph.contract.ContentType
import java.io.File
import java.io.RandomAccessFile
import java.nio.charset.StandardCharsets
import java.util.zip.ZipFile
import org.jsoup.Jsoup
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.w3c.dom.NodeList

/** Metadata extracted from a verified local publication. */
data class BookImportMetadata(
    val title: String? = null,
    val author: String? = null,
    val description: String? = null,
)

/**
 * Reads metadata only from bytes that have already passed [LocalBookImportInspector].
 *
 * EPUB metadata is read from the OPF package document. PDF metadata is read from the uncompressed
 * Info dictionary when it is available; encrypted or compressed metadata simply falls back to the
 * filename. No URI, network request or external XML entity is accepted here.
 */
object BookImportMetadataExtractor {
    fun extract(file: File, contentType: ContentType, fallbackDisplayName: String): BookImportMetadata =
        runCatching {
            when (contentType) {
                ContentType.EPUB -> extractEpub(file, fallbackDisplayName)
                ContentType.PDF -> extractPdf(file, fallbackDisplayName)
                else -> fallback(fallbackDisplayName)
            }
        }.getOrElse { fallback(fallbackDisplayName) }

    private fun extractEpub(file: File, fallbackDisplayName: String): BookImportMetadata {
        ZipFile(file).use { zip ->
            val container = zip.getEntry(CONTAINER_PATH)
                ?.let { zip.getInputStream(it).use(java.io.InputStream::readBytes) }
                ?: return fallback(fallbackDisplayName)
            val containerDocument = secureXml(container) ?: return fallback(fallbackDisplayName)
            val rootfile = elements(containerDocument, "rootfile")
                .firstOrNull { it.getAttribute("full-path").isNotBlank() }
                ?: return fallback(fallbackDisplayName)
            val packagePath = normalizeZipPath(rootfile.getAttribute("full-path"))
                ?: return fallback(fallbackDisplayName)
            val packageBytes = zip.getEntry(packagePath)
                ?.let { zip.getInputStream(it).use(java.io.InputStream::readBytes) }
                ?: return fallback(fallbackDisplayName)
            val packageDocument = secureXml(packageBytes) ?: return fallback(fallbackDisplayName)
            val metadata = elements(packageDocument, "metadata").firstOrNull()
                ?: return fallback(fallbackDisplayName)

            val title = firstText(metadata, "title")
                ?: firstProperty(metadata, setOf("dcterms:title", "title"))
            val author = firstText(metadata, "creator")
                ?: firstProperty(metadata, setOf("dcterms:creator", "creator"))
            val description = firstText(metadata, "description")
                ?: firstProperty(metadata, setOf("dcterms:description", "description"))

            return BookImportMetadata(
                title = title?.let(::cleanText) ?: fallbackTitle(fallbackDisplayName),
                author = author?.let(::cleanText),
                description = description?.let(::cleanDescription),
            )
        }
    }

    private fun extractPdf(file: File, fallbackDisplayName: String): BookImportMetadata {
        val length = file.length()
        val scanLength = minOf(length, MAX_PDF_METADATA_SCAN_BYTES).toInt()
        if (scanLength <= 0) return fallback(fallbackDisplayName)
        // The info dictionary is usually written last, so a large PDF is scanned at both ends.
        val source = RandomAccessFile(file, "r").use { input ->
            val head = ByteArray(scanLength).also(input::readFully)
            if (length <= MAX_PDF_METADATA_SCAN_BYTES) return@use head.toString(StandardCharsets.ISO_8859_1)
            val tail = ByteArray(scanLength)
            input.seek(length - scanLength)
            input.readFully(tail)
            tail.toString(StandardCharsets.ISO_8859_1) + "\n" + head.toString(StandardCharsets.ISO_8859_1)
        }
        return BookImportMetadata(
            title = extractPdfValue(source, "Title")?.let(::cleanText) ?: fallbackTitle(fallbackDisplayName),
            author = extractPdfValue(source, "Author")?.let(::cleanText),
            description = extractPdfValue(source, "Subject")?.let(::cleanDescription),
        )
    }

    private fun extractPdfValue(source: String, key: String): String? {
        val match = Regex("/$key\\s*(\\((?:\\\\.|[^)])*\\)|<([0-9A-Fa-f\\s]+)>)")
            .find(source) ?: return null
        val literal = match.groupValues[1]
        if (literal.startsWith("(")) {
            val raw = decodePdfLiteral(literal.substring(1, literal.length - 1))
            return decodePdfTextString(raw.toByteArray(StandardCharsets.ISO_8859_1))
        }
        val hex = match.groupValues[2].filterNot(Char::isWhitespace)
        if (hex.isEmpty() || hex.length % 2 != 0) return null
        val decoded = ByteArray(hex.length / 2) { index ->
            hex.substring(index * 2, index * 2 + 2).toInt(16).toByte()
        }
        return decodePdfTextString(decoded)
    }

    /** A PDF text string is UTF-16BE or UTF-8 when it starts with that BOM, else PDFDocEncoding. */
    private fun decodePdfTextString(bytes: ByteArray): String = when {
        bytes.size >= 2 && bytes[0] == 0xfe.toByte() && bytes[1] == 0xff.toByte() ->
            bytes.copyOfRange(2, bytes.size).toString(Charsets.UTF_16BE)
        bytes.size >= 3 && bytes[0] == 0xef.toByte() && bytes[1] == 0xbb.toByte() && bytes[2] == 0xbf.toByte() ->
            bytes.copyOfRange(3, bytes.size).toString(Charsets.UTF_8)
        else -> bytes.toString(StandardCharsets.ISO_8859_1)
    }

    private fun decodePdfLiteral(value: String): String {
        val output = StringBuilder(value.length)
        var index = 0
        while (index < value.length) {
            val character = value[index++]
            if (character != '\\' || index >= value.length) {
                output.append(character)
                continue
            }
            when (val escaped = value[index++]) {
                'n' -> output.append('\n')
                'r' -> output.append('\r')
                't' -> output.append('\t')
                'b' -> output.append('\b')
                'f' -> output.append('\u000c')
                '\\', '(', ')' -> output.append(escaped)
                '\n' -> Unit
                '\r' -> if (index < value.length && value[index] == '\n') index++
                in '0'..'7' -> {
                    var octal = escaped - '0'
                    repeat(2) {
                        if (index < value.length && value[index] in '0'..'7') {
                            octal = octal * 8 + (value[index++] - '0')
                        }
                    }
                    output.append(octal.toChar())
                }
                else -> output.append(escaped)
            }
        }
        return output.toString()
    }

    private fun firstText(parent: Element, localName: String): String? =
        elements(parent, localName).firstOrNull()?.textContent?.takeIf(String::isNotBlank)

    private fun firstProperty(parent: Element, names: Set<String>): String? =
        elements(parent, "meta").firstOrNull { element ->
            val property = element.getAttribute("property").trim().lowercase()
            val name = element.getAttribute("name").trim().lowercase()
            property in names || name in names
        }?.getAttribute("content")?.takeIf(String::isNotBlank)

    private fun cleanDescription(value: String): String =
        Jsoup.parseBodyFragment(value).text().replace(WHITESPACE, " ").trim().take(MAX_DESCRIPTION_LENGTH)

    private fun cleanText(value: String): String =
        value.replace(WHITESPACE, " ").trim().take(MAX_TEXT_LENGTH).takeIf(String::isNotBlank).orEmpty()

    private fun fallback(displayName: String): BookImportMetadata =
        BookImportMetadata(title = fallbackTitle(displayName))

    private fun fallbackTitle(displayName: String): String = displayName
        .substringBeforeLast('.', displayName)
        .replace('_', ' ')
        .replace(WHITESPACE, " ")
        .trim()
        .take(MAX_TEXT_LENGTH)

    private fun secureXml(bytes: ByteArray): org.w3c.dom.Document? = SafeXml.parseOrNull(bytes)

    private fun elements(document: Document, localName: String): List<Element> =
        elements(document.getElementsByTagNameNS("*", localName)) +
            elements(document.getElementsByTagName(localName))

    private fun elements(parent: Element, localName: String): List<Element> =
        elements(parent.getElementsByTagNameNS("*", localName)) +
            elements(parent.getElementsByTagName(localName))

    private fun elements(nodes: NodeList): List<Element> = buildList {
        for (index in 0 until nodes.length) {
            (nodes.item(index) as? Element)?.let { element ->
                if (none { it === element }) add(element)
            }
        }
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

    private const val CONTAINER_PATH = "META-INF/container.xml"
    private const val MAX_PDF_METADATA_SCAN_BYTES = 4L * 1024L * 1024L
    private const val MAX_TEXT_LENGTH = 500
    private const val MAX_DESCRIPTION_LENGTH = 20_000
    private val WHITESPACE = Regex("\\s+")
}
