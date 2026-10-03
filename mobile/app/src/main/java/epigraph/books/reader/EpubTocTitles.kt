package epigraph.books.reader

import java.io.ByteArrayOutputStream
import java.io.File
import java.net.URI
import java.util.zip.ZipFile
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import org.jsoup.parser.Parser

/**
 * Chapter labels for the details catalog, taken from the EPUB's own table of contents.
 *
 * The EPUB 3 navigation document and the EPUB 2 NCX both map titles to content documents. Jsoup
 * parses them without resolving DTDs or external entities, so the common `<!DOCTYPE>` headers of
 * these files are harmless here (the strict import parser rejects them). Everything is best
 * effort: an unreadable TOC yields an empty map and the caller keeps its fallback labels.
 */
internal object EpubTocTitles {
    private const val MAX_NAVIGATION_BYTES = 2L * 1024 * 1024

    /** Maps archive paths of content documents to the first TOC title that targets them. */
    fun read(file: File, navigationPath: String?): Map<String, String> {
        navigationPath ?: return emptyMap()
        return runCatching {
            val bytes = ZipFile(file).use { archive ->
                val entry = archive.getEntry(navigationPath) ?: return emptyMap()
                if (entry.size > MAX_NAVIGATION_BYTES) return emptyMap()
                archive.getInputStream(entry).use { input ->
                    val output = ByteArrayOutputStream()
                    val buffer = ByteArray(16 * 1024)
                    while (true) {
                        val read = input.read(buffer)
                        if (read < 0) break
                        if (output.size() + read > MAX_NAVIGATION_BYTES) return emptyMap()
                        output.write(buffer, 0, read)
                    }
                    output.toByteArray()
                }
            }
            parse(bytes.toString(Charsets.UTF_8), navigationPath)
        }.getOrDefault(emptyMap())
    }

    fun parse(content: String, navigationPath: String): Map<String, String> {
        val isNcx = navigationPath.endsWith(".ncx", ignoreCase = true) || "<ncx" in content
        val targets = if (isNcx) ncxTargets(content) else navTargets(content)
        val titles = LinkedHashMap<String, String>()
        targets.forEach { (href, rawTitle) ->
            val title = rawTitle.replace(WHITESPACE, " ").trim()
            if (title.isEmpty()) return@forEach
            val path = resolve(navigationPath, href) ?: return@forEach
            titles.putIfAbsent(path, title)
        }
        return titles
    }

    private fun navTargets(content: String): List<Pair<String, String>> {
        val document = Jsoup.parse(content, "", Parser.xmlParser())
        val navs = document.getElementsByTag("nav")
        val toc = navs.firstOrNull { nav ->
            nav.attr("epub:type").split(' ').contains("toc") || nav.attr("role") == "doc-toc"
        } ?: navs.firstOrNull() ?: return emptyList()
        return toc.getElementsByTag("a").mapNotNull { anchor ->
            anchor.attr("href").takeIf(String::isNotBlank)?.let { it to anchor.text() }
        }
    }

    private fun ncxTargets(content: String): List<Pair<String, String>> {
        val document: Document = Jsoup.parse(content, "", Parser.xmlParser())
        return document.getElementsByTag("navPoint").mapNotNull { point ->
            val label = point.children().firstOrNull { it.normalName() == "navlabel" }
                ?.getElementsByTag("text")?.firstOrNull()?.text()
                ?: return@mapNotNull null
            val src = point.children().firstOrNull { it.normalName() == "content" }?.attr("src")
                ?.takeIf(String::isNotBlank)
                ?: return@mapNotNull null
            src to label
        }
    }

    /** Resolves [href] against the navigation document; null for external or escaping links. */
    internal fun resolve(navigationPath: String, href: String): String? {
        val uri = runCatching { URI(href.trim()) }.getOrNull() ?: return null
        if (uri.isAbsolute || uri.isOpaque || uri.rawAuthority != null) return null
        val decoded = uri.path?.takeIf(String::isNotEmpty) ?: return null
        if (decoded.startsWith('/')) return null
        val components = navigationPath.substringBeforeLast('/', "")
            .split('/')
            .filter(String::isNotEmpty)
            .toMutableList()
        decoded.split('/').forEach { component ->
            when (component) {
                "", "." -> Unit
                ".." -> if (components.isEmpty()) return null else components.removeAt(components.lastIndex)
                else -> components += component
            }
        }
        return components.takeIf { it.isNotEmpty() }?.joinToString("/")
    }

    private val WHITESPACE = Regex("\\s+")
}
