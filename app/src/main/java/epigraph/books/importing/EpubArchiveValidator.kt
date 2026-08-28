package epigraph.books.importing

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.text.Normalizer
import java.util.Locale
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipException
import java.util.zip.ZipFile
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.w3c.dom.Document
import org.w3c.dom.Element
import org.xml.sax.InputSource
import org.xml.sax.SAXException

data class EpubArchiveLimits(
    val maxArchiveBytes: Long = 1L * 1024 * 1024 * 1024,
    val maxEntries: Int = 10_000,
    val maxEntryUncompressedBytes: Long = 64L * 1024 * 1024,
    val maxTotalUncompressedBytes: Long = 512L * 1024 * 1024,
    val maxCompressionRatio: Double = 200.0,
    val minimumRatioCheckBytes: Long = 1L * 1024 * 1024,
    val maxPathBytes: Int = 1024,
    val maxPathSegmentBytes: Int = 255,
    val maxMetadataXmlBytes: Int = 1 * 1024 * 1024,
) {
    init {
        require(maxArchiveBytes > 0)
        require(maxEntries > 0)
        require(maxEntryUncompressedBytes > 0)
        require(maxTotalUncompressedBytes > 0)
        require(maxCompressionRatio >= 1.0)
        require(minimumRatioCheckBytes >= 0)
        require(maxPathBytes > 0)
        require(maxPathSegmentBytes > 0)
        require(maxMetadataXmlBytes > 0)
        require(maxMetadataXmlBytes.toLong() <= maxEntryUncompressedBytes)
    }
}

object EpubArchiveValidator {
    private const val MIMETYPE_PATH = "mimetype"
    private const val CONTAINER_PATH = "META-INF/container.xml"
    private const val EPUB_MIMETYPE = "application/epub+zip"
    private const val CONTAINER_NAMESPACE = "urn:oasis:names:tc:opendocument:xmlns:container"
    private const val OPF_NAMESPACE = "http://www.idpf.org/2007/opf"
    private const val OPF_MEDIA_TYPE = "application/oebps-package+xml"
    private const val BUFFER_SIZE = 64 * 1024

    fun validate(
        file: File,
        limits: EpubArchiveLimits = EpubArchiveLimits(),
    ): EpubArchiveManifest {
        if (!file.isFile || !file.canRead()) {
            fail(BookImportFailure.SOURCE_UNAVAILABLE, "The selected EPUB is not readable")
        }
        if (file.length() > limits.maxArchiveBytes) {
            fail(BookImportFailure.FILE_TOO_LARGE, "The EPUB exceeds the archive size limit")
        }

        try {
            return ZipFile(file).use { archive -> validateArchive(archive, limits) }
        } catch (failure: BookImportValidationException) {
            throw failure
        } catch (failure: ZipException) {
            fail(BookImportFailure.MALFORMED_ARCHIVE, "The EPUB ZIP structure is invalid", failure)
        } catch (failure: IOException) {
            fail(BookImportFailure.MALFORMED_ARCHIVE, "The EPUB could not be read safely", failure)
        }
    }

    private fun validateArchive(
        archive: ZipFile,
        limits: EpubArchiveLimits,
    ): EpubArchiveManifest {
        val seenPaths = mutableMapOf<String, Boolean>()
        val entries = mutableListOf<EpubArchiveEntry>()
        var entryCount = 0
        var firstEntryPath: String? = null
        var totalBytes = 0L
        var mimetype: String? = null
        var containerBytes: ByteArray? = null
        val fileEntries = mutableMapOf<String, ZipEntry>()
        val buffer = ByteArray(BUFFER_SIZE)

        val enumeration = archive.entries()
        while (enumeration.hasMoreElements()) {
            val entry = enumeration.nextElement()
            entryCount++
            if (entryCount > limits.maxEntries) {
                fail(BookImportFailure.TOO_MANY_ARCHIVE_ENTRIES, "The EPUB contains too many ZIP entries")
            }

            val safePath = validateEntryPath(entry.name, limits)
            if (firstEntryPath == null) firstEntryPath = safePath
            val identityPath = safePath.removeSuffix("/")
            if (seenPaths.putIfAbsent(identityPath, entry.isDirectory) != null) {
                fail(BookImportFailure.DUPLICATE_ARCHIVE_PATH, "The EPUB contains duplicate path: $safePath")
            }
            rejectFileDirectoryConflict(identityPath, entry.isDirectory, seenPaths)
            if (entry.isDirectory) continue
            fileEntries[safePath] = entry

            if (safePath == MIMETYPE_PATH && (firstEntryPath != MIMETYPE_PATH || entry.method != ZipEntry.STORED)) {
                fail(
                    BookImportFailure.INVALID_EPUB_STRUCTURE,
                    "The EPUB mimetype must be the first ZIP entry and stored without compression",
                )
            }

            validateDeclaredSize(entry, limits)
            var entryBytes = 0L
            val crc = CRC32()
            val mimetypeBytes = if (safePath == MIMETYPE_PATH) ArrayList<Byte>(64) else null
            val metadataBytes = if (safePath == CONTAINER_PATH) ByteArrayOutputStream() else null

            archive.getInputStream(entry).use { input ->
                while (true) {
                    val read = input.read(buffer)
                    if (read < 0) break
                    if (read == 0) continue
                    entryBytes = checkedAdd(entryBytes, read.toLong(), BookImportFailure.ARCHIVE_ENTRY_TOO_LARGE)
                    if (entryBytes > limits.maxEntryUncompressedBytes) {
                        fail(BookImportFailure.ARCHIVE_ENTRY_TOO_LARGE, "EPUB entry exceeds the size limit: $safePath")
                    }
                    totalBytes = checkedAdd(totalBytes, read.toLong(), BookImportFailure.ARCHIVE_TOO_LARGE)
                    if (totalBytes > limits.maxTotalUncompressedBytes) {
                        fail(BookImportFailure.ARCHIVE_TOO_LARGE, "The expanded EPUB exceeds the size limit")
                    }
                    crc.update(buffer, 0, read)
                    if (mimetypeBytes != null) {
                        if (mimetypeBytes.size + read > 128) {
                            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "The EPUB mimetype entry is invalid")
                        }
                        repeat(read) { index -> mimetypeBytes += buffer[index] }
                    }
                    if (metadataBytes != null) {
                        if (metadataBytes.size() + read > limits.maxMetadataXmlBytes) {
                            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB container.xml exceeds the metadata limit")
                        }
                        metadataBytes.write(buffer, 0, read)
                    }
                }
            }

            if (entry.size >= 0 && entryBytes != entry.size) {
                fail(BookImportFailure.MALFORMED_ARCHIVE, "EPUB entry size does not match its ZIP metadata: $safePath")
            }
            if (entry.crc >= 0 && crc.value != entry.crc) {
                fail(BookImportFailure.MALFORMED_ARCHIVE, "EPUB entry checksum does not match its ZIP metadata: $safePath")
            }
            validateCompressionRatio(entryBytes, entry.compressedSize, safePath, limits)
            if (mimetypeBytes != null) {
                mimetype = mimetypeBytes.toByteArray().toString(Charsets.US_ASCII)
            }
            if (metadataBytes != null) containerBytes = metadataBytes.toByteArray()
            entries += EpubArchiveEntry(safePath, entry.compressedSize, entryBytes)
        }

        if (mimetype != EPUB_MIMETYPE || containerBytes == null) {
            fail(
                BookImportFailure.INVALID_EPUB_STRUCTURE,
                "An EPUB must contain the exact mimetype and META-INF/container.xml entries",
            )
        }

        val packagePath = parseContainer(containerBytes, fileEntries)
        val packageEntry = fileEntries[packagePath]
            ?: fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document does not exist: $packagePath")
        val packageBytes = readMetadataEntry(archive, packageEntry, limits)
        val spinePaths = parsePackage(packageBytes, packagePath, fileEntries.keys)

        return EpubArchiveManifest(
            entries = entries,
            totalUncompressedBytes = totalBytes,
            packagePath = packagePath,
            spinePaths = spinePaths,
        )
    }

    private fun parseContainer(
        bytes: ByteArray,
        fileEntries: Map<String, ZipEntry>,
    ): String {
        val document = parseXml(bytes, CONTAINER_PATH)
        val root = document.documentElement
        if (root.localName != "container" || root.namespaceURI != CONTAINER_NAMESPACE) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB container.xml has an invalid root element")
        }

        val rootfilesElement = root.directChild(CONTAINER_NAMESPACE, "rootfiles")
            ?: fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB container.xml is missing rootfiles")
        val rootfiles = rootfilesElement.directChildren(CONTAINER_NAMESPACE, "rootfile")
        var supportedPackage: String? = null
        rootfiles.forEach { rootfile ->
            val fullPath = rootfile.getAttribute("full-path").trim()
            val mediaType = rootfile.getAttribute("media-type").trim()
            if (fullPath.isEmpty()) {
                fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB rootfile is missing its full-path")
            }
            val safePath = validateRootfilePath(fullPath)
            if (mediaType == OPF_MEDIA_TYPE && supportedPackage == null) supportedPackage = safePath
        }

        val packagePath = supportedPackage
            ?: fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB container.xml has no supported package rootfile")
        if (fileEntries[packagePath] == null) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document does not exist: $packagePath")
        }
        return packagePath
    }

    private fun parsePackage(
        bytes: ByteArray,
        packagePath: String,
        archiveFiles: Set<String>,
    ): List<String> {
        val document = parseXml(bytes, packagePath)
        val root = document.documentElement
        if (root.localName != "package" || root.namespaceURI != OPF_NAMESPACE) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document has an invalid root element")
        }
        val majorVersion = root.getAttribute("version").substringBefore('.').toIntOrNull()
        if (majorVersion != 2 && majorVersion != 3) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "Only EPUB 2 and EPUB 3 package documents are supported")
        }
        rejectXmlBase(root)

        val manifest = root.requiredSingleOpfChild("manifest")
        val spine = root.requiredSingleOpfChild("spine")
        rejectXmlBase(manifest)
        rejectXmlBase(spine)

        val itemsById = linkedMapOf<String, PackageItem>()
        manifest.directChildren(OPF_NAMESPACE, "item").forEach { item ->
            rejectXmlBase(item)
            val id = item.getAttribute("id").trim()
            val href = item.getAttribute("href").trim()
            val mediaType = item.getAttribute("media-type").trim()
            if (id.isEmpty() || href.isEmpty() || mediaType.isEmpty()) {
                fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "Every EPUB manifest item needs id, href, and media-type")
            }
            if (itemsById.containsKey(id)) {
                fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB manifest contains duplicate item id: $id")
            }
            val resourcePath = resolvePackageResource(packagePath, href)
            if (resourcePath !in archiveFiles) {
                fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB manifest resource does not exist: $resourcePath")
            }
            itemsById[id] = PackageItem(resourcePath, mediaType)
        }
        if (itemsById.isEmpty()) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB manifest cannot be empty")
        }

        val spinePaths = spine.directChildren(OPF_NAMESPACE, "itemref").map { itemref ->
            val idref = itemref.getAttribute("idref").trim()
            val item = itemsById[idref]
                ?: fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB spine references an unknown manifest item: $idref")
            if (item.mediaType !in SPINE_MEDIA_TYPES) {
                fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB spine item is not a readable content document: $idref")
            }
            item.path
        }
        if (spinePaths.isEmpty()) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB spine cannot be empty")
        }
        return spinePaths
    }

    private fun readMetadataEntry(
        archive: ZipFile,
        entry: ZipEntry,
        limits: EpubArchiveLimits,
    ): ByteArray {
        if (entry.size > limits.maxMetadataXmlBytes) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document exceeds the metadata limit")
        }
        val output = ByteArrayOutputStream()
        val buffer = ByteArray(BUFFER_SIZE)
        archive.getInputStream(entry).use { input ->
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (read == 0) continue
                if (output.size() + read > limits.maxMetadataXmlBytes) {
                    fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document exceeds the metadata limit")
                }
                output.write(buffer, 0, read)
            }
        }
        return output.toByteArray()
    }

    private fun parseXml(bytes: ByteArray, path: String): Document {
        if (containsForbiddenDeclaration(bytes)) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB metadata cannot contain DTD or entity declarations: $path")
        }
        try {
            val factory = DocumentBuilderFactory.newInstance().apply {
                isNamespaceAware = true
                disableXIncludeIfSupported()
                isExpandEntityReferences = false
                // Android's XML provider does not expose the JAXP secure-processing
                // feature consistently across API levels. The input is still kept
                // fail-closed by rejecting DTD/entity declarations before parsing,
                // disabling external entities when supported, and installing an
                // EntityResolver that rejects any external lookup.
                setFeatureIfSupported(XMLConstants.FEATURE_SECURE_PROCESSING, true)
                setFeatureIfSupported("http://apache.org/xml/features/disallow-doctype-decl", true)
                setFeatureIfSupported("http://xml.org/sax/features/external-general-entities", false)
                setFeatureIfSupported("http://xml.org/sax/features/external-parameter-entities", false)
                setFeatureIfSupported("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
                setAttributeIfSupported(ACCESS_EXTERNAL_DTD, "")
                setAttributeIfSupported(ACCESS_EXTERNAL_SCHEMA, "")
            }
            val builder = factory.newDocumentBuilder().apply {
                setEntityResolver { _, _ -> throw SAXException("External XML entities are disabled") }
            }
            return builder.parse(InputSource(ByteArrayInputStream(bytes)))
        } catch (failure: BookImportValidationException) {
            throw failure
        } catch (failure: ParserConfigurationException) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "Secure EPUB XML parsing is unavailable", failure)
        } catch (failure: SAXException) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB metadata XML is malformed: $path", failure)
        } catch (failure: IOException) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB metadata XML could not be read: $path", failure)
        }
    }

    private fun DocumentBuilderFactory.setFeatureIfSupported(name: String, value: Boolean) {
        try {
            setFeature(name, value)
        } catch (_: ParserConfigurationException) {
            // The declaration pre-scan and rejecting EntityResolver keep unsupported parsers fail-closed.
        }
    }

    private fun DocumentBuilderFactory.disableXIncludeIfSupported() {
        try {
            isXIncludeAware = false
        } catch (_: UnsupportedOperationException) {
            // False is the default; some Android XML providers do not implement this setter.
        }
    }

    private fun DocumentBuilderFactory.setAttributeIfSupported(name: String, value: String) {
        try {
            setAttribute(name, value)
        } catch (_: IllegalArgumentException) {
            // Older Android XML providers do not expose these JAXP properties.
        }
    }

    private fun containsForbiddenDeclaration(bytes: ByteArray): Boolean {
        val ascii = bytes.toString(Charsets.ISO_8859_1).uppercase(Locale.ROOT)
        return "<!DOCTYPE" in ascii || "<!ENTITY" in ascii
    }

    private fun validateRootfilePath(rawPath: String): String {
        val uri = parseRelativeUri(rawPath, "EPUB rootfile")
        if (uri.rawFragment != null || uri.rawQuery != null) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "EPUB rootfile path cannot contain a query or fragment")
        }
        return resolveRelativePath(emptyList(), uri.path, rawPath)
    }

    private fun resolvePackageResource(packagePath: String, href: String): String {
        val uri = parseRelativeUri(href, "EPUB manifest href")
        if (uri.rawQuery != null) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "EPUB manifest href cannot contain a query: $href")
        }
        val base = packagePath.substringBeforeLast('/', "")
            .takeIf { it.isNotEmpty() }
            ?.split('/')
            .orEmpty()
        return resolveRelativePath(base, uri.path, href)
    }

    private fun parseRelativeUri(raw: String, label: String): URI {
        val uri = try {
            URI(raw)
        } catch (failure: URISyntaxException) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "$label is not a valid URI path: $raw", failure)
        }
        if (uri.isAbsolute || uri.isOpaque || uri.rawAuthority != null || uri.path.isNullOrBlank()) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "$label must reference a local archive path: $raw")
        }
        return uri
    }

    private fun resolveRelativePath(base: List<String>, decodedPath: String, rawPath: String): String {
        if (decodedPath.startsWith('/') || decodedPath.startsWith('\\')) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "EPUB reference is absolute: $rawPath")
        }
        val components = base.toMutableList()
        decodedPath.split('/').forEach { component ->
            when (component) {
                "", "." -> Unit
                ".." -> if (components.isEmpty()) {
                    fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "EPUB reference escapes the archive: $rawPath")
                } else {
                    components.removeAt(components.lastIndex)
                }
                else -> components += component
            }
        }
        if (components.isEmpty()) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "EPUB reference does not name a file: $rawPath")
        }
        return validateEntryPath(components.joinToString("/"))
    }

    private fun rejectXmlBase(element: Element) {
        if (element.hasAttributeNS(XMLConstants.XML_NS_URI, "base")) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB xml:base is not accepted during secure import")
        }
    }

    private fun Element.requiredSingleOpfChild(localName: String): Element {
        val children = directChildren(OPF_NAMESPACE, localName)
        if (children.size != 1) {
            fail(BookImportFailure.INVALID_EPUB_STRUCTURE, "EPUB package document must contain exactly one $localName")
        }
        return children.single()
    }

    private fun Element.directChild(namespace: String, localName: String): Element? =
        directChildren(namespace, localName).firstOrNull()

    private fun Element.directChildren(namespace: String, localName: String): List<Element> = buildList {
        val children = childNodes
        for (index in 0 until children.length) {
            val element = children.item(index) as? Element ?: continue
            if (element.localName == localName && element.namespaceURI == namespace) add(element)
        }
    }

    internal fun validateEntryPath(
        rawPath: String,
        limits: EpubArchiveLimits = EpubArchiveLimits(),
    ): String {
        if (rawPath.isBlank() || rawPath.indexOf('\u0000') >= 0 || rawPath.any { it.isISOControl() }) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "The EPUB contains an invalid ZIP path")
        }
        if (rawPath.startsWith('/') || rawPath.startsWith('\\') || DRIVE_PATH.matches(rawPath)) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "The EPUB contains an absolute ZIP path: $rawPath")
        }
        if ('\\' in rawPath) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "Backslashes are not accepted in EPUB ZIP paths: $rawPath")
        }

        val normalized = Normalizer.normalize(rawPath, Normalizer.Form.NFC)
        val components = normalized.split('/')
        if (
            components.withIndex().any { (index, component) ->
                component == "." ||
                    component == ".." ||
                    (component.isEmpty() && index != components.lastIndex)
            }
        ) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "The EPUB contains a traversing ZIP path: $rawPath")
        }
        if (
            normalized.toByteArray(Charsets.UTF_8).size > limits.maxPathBytes ||
            components.any { it.toByteArray(Charsets.UTF_8).size > limits.maxPathSegmentBytes }
        ) {
            fail(BookImportFailure.UNSAFE_ARCHIVE_PATH, "The EPUB contains an excessively long ZIP path")
        }
        return normalized
    }

    private fun rejectFileDirectoryConflict(
        path: String,
        isDirectory: Boolean,
        knownPaths: Map<String, Boolean>,
    ) {
        var separator = path.indexOf('/')
        while (separator >= 0) {
            val parent = path.substring(0, separator)
            if (knownPaths[parent] == false) {
                fail(BookImportFailure.DUPLICATE_ARCHIVE_PATH, "An EPUB file is also used as a directory: $parent")
            }
            separator = path.indexOf('/', separator + 1)
        }
        if (!isDirectory && knownPaths.keys.any { it.startsWith("$path/") }) {
            fail(BookImportFailure.DUPLICATE_ARCHIVE_PATH, "An EPUB file is also used as a directory: $path")
        }
    }

    private fun validateDeclaredSize(entry: ZipEntry, limits: EpubArchiveLimits) {
        if (entry.size > limits.maxEntryUncompressedBytes) {
            fail(BookImportFailure.ARCHIVE_ENTRY_TOO_LARGE, "EPUB entry exceeds the size limit: ${entry.name}")
        }
        if (entry.size >= 0) {
            validateCompressionRatio(entry.size, entry.compressedSize, entry.name, limits)
        }
    }

    private fun validateCompressionRatio(
        expandedBytes: Long,
        compressedBytes: Long,
        path: String,
        limits: EpubArchiveLimits,
    ) {
        if (expandedBytes < limits.minimumRatioCheckBytes) return
        val ratio = if (compressedBytes <= 0) Double.POSITIVE_INFINITY else expandedBytes.toDouble() / compressedBytes
        if (ratio > limits.maxCompressionRatio) {
            fail(BookImportFailure.SUSPICIOUS_COMPRESSION_RATIO, "EPUB entry has a suspicious compression ratio: $path")
        }
    }

    private fun checkedAdd(current: Long, increment: Long, failure: BookImportFailure): Long {
        if (current > Long.MAX_VALUE - increment) {
            fail(failure, "EPUB expanded size overflowed its safety counter")
        }
        return current + increment
    }

    private fun fail(
        failure: BookImportFailure,
        message: String,
        cause: Throwable? = null,
    ): Nothing = throw BookImportValidationException(failure, message, cause)

    private val DRIVE_PATH = Regex("^[A-Za-z]:.*")
    private const val ACCESS_EXTERNAL_DTD = "http://javax.xml.XMLConstants/property/accessExternalDTD"
    private const val ACCESS_EXTERNAL_SCHEMA = "http://javax.xml.XMLConstants/property/accessExternalSchema"

    private data class PackageItem(
        val path: String,
        val mediaType: String,
    )

    private val SPINE_MEDIA_TYPES = setOf("application/xhtml+xml", "image/svg+xml")
}
