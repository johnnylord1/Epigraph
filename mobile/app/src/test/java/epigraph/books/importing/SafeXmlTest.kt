package epigraph.books.importing

import javax.xml.parsers.DocumentBuilder
import javax.xml.parsers.DocumentBuilderFactory
import javax.xml.parsers.ParserConfigurationException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class SafeXmlTest {
    private val opf = """
        <?xml version="1.0" encoding="UTF-8"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Title</dc:title></metadata>
        </package>
    """.trimIndent().toByteArray()

    @Test
    fun `parses on a provider that rejects every hardening feature like Android`() {
        val document = SafeXml.parseOrNull(opf, AndroidLikeFactory())

        val title = document?.getElementsByTagNameNS("http://purl.org/dc/elements/1.1/", "title")?.item(0)
        assertEquals("Title", title?.textContent)
    }

    @Test
    fun `rejects doctype and entity declarations before parsing`() {
        val doctype = "<?xml version=\"1.0\"?><!DOCTYPE package><package/>".toByteArray()
        val entity = "<?xml version=\"1.0\"?><!doctype p [<!ENTITY x \"y\">]><p>&x;</p>".toByteArray()

        assertNull(SafeXml.parseOrNull(doctype, AndroidLikeFactory()))
        assertNull(SafeXml.parseOrNull(entity))
    }

    @Test
    fun `malformed xml returns null`() {
        assertNull(SafeXml.parseOrNull("<package><metadata></package>".toByteArray()))
    }

    /** Mirrors Android's DocumentBuilderFactoryImpl, which only accepts the namespace/validation features. */
    private class AndroidLikeFactory : DocumentBuilderFactory() {
        private val delegate = DocumentBuilderFactory.newInstance()

        override fun newDocumentBuilder(): DocumentBuilder = delegate.apply {
            isNamespaceAware = this@AndroidLikeFactory.isNamespaceAware
        }.newDocumentBuilder()

        override fun setAttribute(name: String, value: Any?) = throw IllegalArgumentException(name)
        override fun getAttribute(name: String): Any = throw IllegalArgumentException(name)
        override fun setFeature(name: String, value: Boolean) = throw ParserConfigurationException(name)
        override fun getFeature(name: String): Boolean = throw ParserConfigurationException(name)
        override fun setXIncludeAware(state: Boolean) = throw UnsupportedOperationException()
    }
}
