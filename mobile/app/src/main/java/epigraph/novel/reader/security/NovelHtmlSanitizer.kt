package epigraph.novel.reader.security

import org.jsoup.Jsoup
import org.jsoup.nodes.DataNode
import org.jsoup.nodes.Element
import org.jsoup.safety.Cleaner
import org.jsoup.safety.Safelist
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/**
 * Sanitizes untrusted chapter markup before it can be inserted into the novel WebView.
 *
 * Chapter HTML is data, never executable application code. The allowlist intentionally drops
 * author CSS, forms, embedded documents and active media. Images are limited to bytes already
 * owned by the reader (the private image scheme or a small raster data URI), so parsing a chapter
 * cannot make the WebView contact a source-controlled host. Callers that opt in with
 * `allowRemoteImages` get absolute HTTPS images rewritten to [REMOTE_IMAGE_SCHEME], which only
 * [NovelRemoteImageBroker] serves.
 *
 * `allowAuthorStyles` (the reader's "Apply EPUB styles" option) keeps the chapter's own
 * `<style>` blocks, `style` and `class` attributes, after [sanitizeCss] drops every construct
 * that can load a resource, run code or escape the style element (`url(`, `@import`,
 * `@font-face`, `expression(`, `behavior`, `-moz-binding`, escapes and `<`).
 */
object NovelHtmlSanitizer {

    private const val MAX_INLINE_IMAGE_URI_CHARS = 5 * 1024 * 1024
    private const val MAX_REMOTE_IMAGE_URL_CHARS = 4096

    const val REMOTE_IMAGE_SCHEME = "epigraph-novel-remote-image"
    private const val REMOTE_IMAGE_PREFIX = "$REMOTE_IMAGE_SCHEME://"

    private val removableElements = listOf(
        "script",
        "style",
        "noscript",
        "iframe",
        "frame",
        "frameset",
        "object",
        "embed",
        "applet",
        "form",
        "input",
        "button",
        "select",
        "option",
        "textarea",
        "fieldset",
        "video",
        "audio",
        "source",
        "track",
        "svg",
        "math",
        "template",
        "canvas",
        "link",
        "meta",
        "base",
    ).joinToString(",")

    private const val MAX_AUTHOR_CSS_CHARS = 64 * 1024

    private val safelist = baseSafelist()

    private val styledSafelist = baseSafelist().addAttributes(":all", "style", "class")

    private fun baseSafelist(): Safelist = Safelist.none()
        .addTags(
            "article", "section", "main", "header", "footer", "aside", "nav",
            "div", "span", "p", "br", "hr",
            "h1", "h2", "h3", "h4", "h5", "h6",
            "strong", "em", "b", "i", "u", "s", "del", "ins", "mark",
            "small", "sub", "sup", "abbr", "cite", "q",
            "blockquote", "pre", "code", "kbd", "samp", "var",
            "ul", "ol", "li", "dl", "dt", "dd",
            "table", "caption", "thead", "tbody", "tfoot", "tr", "th", "td",
            "figure", "figcaption", "details", "summary",
            "ruby", "rt", "rp", "bdi", "bdo", "wbr",
            "a", "img",
        )
        .addAttributes(":all", "dir", "lang")
        .addAttributes("a", "href", "title")
        .addAttributes("img", "src", "alt", "title", "width", "height", "loading")
        .addAttributes("ol", "start", "type", "reversed")
        .addAttributes("li", "value")
        .addAttributes("th", "colspan", "rowspan", "headers", "scope")
        .addAttributes("td", "colspan", "rowspan", "headers")
        .addProtocols("a", "href", "https")
        .addProtocols("img", "src", "data", "epigraph-novel-image", "hayai-novel-image", REMOTE_IMAGE_SCHEME)
        .addEnforcedAttribute("a", "rel", "nofollow noopener noreferrer")
        .preserveRelativeLinks(true)

    /** Returns an HTML body fragment that is safe to place under the app-owned document shell. */
    fun sanitize(html: String, allowRemoteImages: Boolean = false, allowAuthorStyles: Boolean = false): String {
        val untrusted = Jsoup.parseBodyFragment(html, "")
        untrusted.outputSettings().prettyPrint(false)
        if (allowRemoteImages) {
            untrusted.select("img[src]").forEach { image ->
                remoteImageUrl(image.attr("src"))?.let { image.attr("src", it) }
            }
        }

        val authorCss = if (allowAuthorStyles) {
            sanitizeCss(untrusted.select("style").joinToString("\n") { it.data() })
        } else {
            ""
        }

        // Cleaner unwraps unknown elements to preserve their text. Active containers are removed
        // first because even preserving their child text would expose script/CSS source to TTS.
        untrusted.select(removableElements).remove()

        val clean = Cleaner(if (allowAuthorStyles) styledSafelist else safelist).clean(untrusted)
        clean.outputSettings().prettyPrint(false)

        if (allowAuthorStyles) {
            // The reader document's own scripts select `.chapter-content`, transition cards and
            // similar hooks; author classes must never collide with them.
            clean.select("[class]").forEach { element ->
                val kept = element.classNames().filterNot(::isReservedClass)
                if (kept.isEmpty()) element.removeAttr("class") else element.classNames(kept.toMutableSet())
            }
            clean.select("[style]").forEach { element ->
                val style = sanitizeCss(element.attr("style"))
                if (style.isBlank()) element.removeAttr("style") else element.attr("style", style)
            }
            if (authorCss.isNotBlank()) {
                clean.body().prependChild(
                    Element("style").attr("data-epigraph-author-css", "1").appendChild(DataNode(authorCss)),
                )
            }
        }

        clean.select("a[href]").forEach { anchor ->
            if (!isAllowedLink(anchor.attr("href"))) {
                anchor.removeAttr("href")
                anchor.removeAttr("rel")
            }
        }
        clean.select("img").forEach { image ->
            if (!isAllowedImageSource(image.attr("src"), allowRemoteImages)) {
                image.remove()
            }
        }

        return clean.body().html()
    }

    /**
     * Keeps only passive author CSS. Whole declarations (and at-rules) that could fetch a
     * resource, execute code or pin content over the reader are dropped; `<` is removed so the
     * text can never close the `<style>` element it is placed in.
     */
    internal fun sanitizeCss(css: String): String {
        if (css.isBlank()) return ""
        var out = css.take(MAX_AUTHOR_CSS_CHARS)
            .replace(CSS_COMMENT, "")
            .replace("<", "")
            .replace(CSS_FONT_FACE, "")
            .replace(CSS_AT_STATEMENT, "")
        out = out.replace(CSS_DANGEROUS_DECLARATION, "")
        return out.trim()
    }

    private fun isReservedClass(name: String): Boolean {
        val lower = name.lowercase()
        return lower.startsWith("chapter-") ||
            lower.startsWith("initial-") ||
            lower.startsWith("transition") ||
            "tsundoku" in lower ||
            "epigraph" in lower
    }

    internal fun isAllowedLink(value: String): Boolean {
        val candidate = value.trim()
        if (candidate.any(Char::isISOControl)) return false
        if (candidate.startsWith("#")) return candidate.length > 1

        return runCatching {
            val uri = URI(candidate)
            uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank()
        }.getOrDefault(false)
    }

    internal fun isAllowedImageSource(value: String, allowRemoteImages: Boolean = false): Boolean {
        val candidate = value.trim()
        if (candidate.isEmpty() || candidate.any(Char::isISOControl)) return false
        if (candidate.startsWith(REMOTE_IMAGE_PREFIX, ignoreCase = true)) {
            return allowRemoteImages && decodeRemoteImageUrl(candidate) != null
        }

        val imageScheme = when {
            candidate.startsWith("epigraph-novel-image://", ignoreCase = true) -> "epigraph-novel-image://"
            candidate.startsWith("hayai-novel-image://", ignoreCase = true) -> "hayai-novel-image://"
            else -> null
        }
        if (imageScheme != null) {
            val encodedPath = candidate.substringAfter("://")
            if (encodedPath.isBlank()) return false
            val decodedPath = runCatching {
                URLDecoder.decode(encodedPath, StandardCharsets.UTF_8.name())
            }.getOrNull() ?: return false
            val normalized = decodedPath.replace('\\', '/')
            return normalized.none(Char::isISOControl) &&
                normalized.split('/').none { it == ".." }
        }

        if (candidate.length > MAX_INLINE_IMAGE_URI_CHARS) return false
        return SAFE_RASTER_DATA_URI.matches(candidate)
    }

    /** Broker URL for an absolute (or protocol-relative) HTTPS image, else null. */
    internal fun remoteImageUrl(value: String): String? {
        val candidate = value.trim().let { if (it.startsWith("//")) "https:$it" else it }
        if (candidate.length > MAX_REMOTE_IMAGE_URL_CHARS || candidate.any(Char::isISOControl)) return null
        val uri = runCatching { URI(candidate) }.getOrNull() ?: return null
        if (!uri.scheme.equals("https", ignoreCase = true) || uri.host.isNullOrBlank() || uri.rawUserInfo != null) {
            return null
        }
        return REMOTE_IMAGE_PREFIX + URLEncoder.encode(uri.toASCIIString(), StandardCharsets.UTF_8.name())
    }

    /** The HTTPS URL carried by a broker URL, or null when it is not a well-formed one. */
    fun decodeRemoteImageUrl(brokerUrl: String): String? {
        if (!brokerUrl.startsWith(REMOTE_IMAGE_PREFIX, ignoreCase = true)) return null
        val decoded = runCatching {
            URLDecoder.decode(brokerUrl.substring(REMOTE_IMAGE_PREFIX.length), StandardCharsets.UTF_8.name())
        }.getOrNull() ?: return null
        if (decoded.length > MAX_REMOTE_IMAGE_URL_CHARS || decoded.any(Char::isISOControl)) return null
        val uri = runCatching { URI(decoded) }.getOrNull() ?: return null
        val valid = uri.scheme.equals("https", ignoreCase = true) && !uri.host.isNullOrBlank() && uri.rawUserInfo == null
        return decoded.takeIf { valid }
    }

    private val CSS_COMMENT = Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL)
    private val CSS_FONT_FACE = Regex("""@font-face\s*\{[^}]*\}?""", RegexOption.IGNORE_CASE)
    private val CSS_AT_STATEMENT = Regex("""@(?:import|charset|namespace)\b[^;{}]*;?""", RegexOption.IGNORE_CASE)

    /** A declaration (up to `;`, `{` or `}`) that loads, executes, escapes or pins content. */
    private val CSS_DANGEROUS_DECLARATION = Regex(
        """[^;{}]*(?:url\s*\(|image(?:-set)?\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding|\\|""" +
            """position\s*:\s*(?:fixed|sticky))[^;{}]*;?""",
        RegexOption.IGNORE_CASE,
    )

    private val SAFE_RASTER_DATA_URI = Regex(
        pattern = "^data:image/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\\r\\n]+$",
        option = RegexOption.IGNORE_CASE,
    )
}
