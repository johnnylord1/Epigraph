package epigraph.books.importing

import java.io.ByteArrayInputStream
import java.util.Locale
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.w3c.dom.Document
import org.xml.sax.InputSource
import org.xml.sax.SAXException

/**
 * Hardened DOM parsing for EPUB metadata documents.
 *
 * Android's XML provider rejects most JAXP/Xerces features with [ParserConfigurationException],
 * so every hardening switch is applied only when supported. The input stays fail-closed because
 * DTD/entity declarations are rejected before parsing and the builder's EntityResolver refuses
 * any external lookup.
 */
internal object SafeXml {

    /** EPUB metadata never needs a DTD or entity declaration. */
    fun containsForbiddenDeclaration(bytes: ByteArray): Boolean {
        val ascii = bytes.toString(Charsets.ISO_8859_1).uppercase(Locale.ROOT)
        return "<!DOCTYPE" in ascii || "<!ENTITY" in ascii
    }

    /** @throws ParserConfigurationException when the platform cannot create a namespace-aware builder. */
    fun newDocumentBuilder(factory: DocumentBuilderFactory = DocumentBuilderFactory.newInstance()): DocumentBuilder {
        factory.apply {
            isNamespaceAware = true
            disableXIncludeIfSupported()
            isExpandEntityReferences = false
            setFeatureIfSupported(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            setFeatureIfSupported("http://apache.org/xml/features/disallow-doctype-decl", true)
            setFeatureIfSupported("http://xml.org/sax/features/external-general-entities", false)
            setFeatureIfSupported("http://xml.org/sax/features/external-parameter-entities", false)
            setFeatureIfSupported("http://apache.org/xml/features/nonvalidating/load-external-dtd", false)
            setAttributeIfSupported(ACCESS_EXTERNAL_DTD, "")
            setAttributeIfSupported(ACCESS_EXTERNAL_SCHEMA, "")
        }
        return factory.newDocumentBuilder().apply {
            setEntityResolver { _, _ -> throw SAXException("External XML entities are disabled") }
        }
    }

    /** Parses [bytes], or returns null when they are malformed or declare a DTD/entity. */
    fun parseOrNull(
        bytes: ByteArray,
        factory: DocumentBuilderFactory = DocumentBuilderFactory.newInstance(),
    ): Document? {
        if (containsForbiddenDeclaration(bytes)) return null
        return runCatching {
            newDocumentBuilder(factory).parse(InputSource(ByteArrayInputStream(bytes)))
        }.getOrNull()
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

    private const val ACCESS_EXTERNAL_DTD = "http://javax.xml.XMLConstants/property/accessExternalDTD"
    private const val ACCESS_EXTERNAL_SCHEMA = "http://javax.xml.XMLConstants/property/accessExternalSchema"
}
