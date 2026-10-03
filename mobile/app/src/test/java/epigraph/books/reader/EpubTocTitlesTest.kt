package epigraph.books.reader

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

class EpubTocTitlesTest {
    @Test
    fun `epub 3 nav maps toc anchors to archive paths`() {
        val nav = """
            <?xml version="1.0" encoding="utf-8"?>
            <!DOCTYPE html>
            <html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
            <body>
              <nav epub:type="landmarks"><ol><li><a href="text/cover.xhtml">Cover</a></li></ol></nav>
              <nav epub:type="toc"><ol>
                <li><a href="text/ch1.xhtml">  The
                    Beginning </a></li>
                <li><a href="text/ch1.xhtml#part2">Part two</a></li>
                <li><a href="text/Chapter%202.xhtml#top">Second</a></li>
                <li><a href="https://example.com/">External</a></li>
              </ol></nav>
            </body></html>
        """.trimIndent()

        assertEquals(
            mapOf(
                "OEBPS/text/ch1.xhtml" to "The Beginning",
                "OEBPS/text/Chapter 2.xhtml" to "Second",
            ),
            EpubTocTitles.parse(nav, "OEBPS/nav.xhtml"),
        )
    }

    @Test
    fun `epub 2 ncx uses nav point labels`() {
        val ncx = """
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">
            <ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
              <navMap>
                <navPoint id="p1" playOrder="1">
                  <navLabel><text>Prologue</text></navLabel>
                  <content src="../Text/prologue.html"/>
                  <navPoint id="p1a" playOrder="2">
                    <navLabel><text>Nested</text></navLabel>
                    <content src="../Text/nested.html"/>
                  </navPoint>
                </navPoint>
              </navMap>
            </ncx>
        """.trimIndent()

        assertEquals(
            mapOf("Text/prologue.html" to "Prologue", "Text/nested.html" to "Nested"),
            EpubTocTitles.parse(ncx, "Misc/toc.ncx"),
        )
    }

    @Test
    fun `links escaping the archive are ignored`() {
        assertNull(EpubTocTitles.resolve("nav.xhtml", "../outside.xhtml"))
        assertNull(EpubTocTitles.resolve("nav.xhtml", "/absolute.xhtml"))
        assertEquals("a/b.xhtml", EpubTocTitles.resolve("a/nav.xhtml", "./b.xhtml"))
    }
}
