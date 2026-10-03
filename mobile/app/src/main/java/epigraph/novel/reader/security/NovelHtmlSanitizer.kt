package epigraph.novel.reader.security

import org.jsoup.Jsoup
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

    private val safelist = Safelist.none()
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
    fun sanitize(html: String, allowRemoteImages: Boolean = false): String {
        val untrusted = Jsoup.parseBodyFragment(html, "")
        untrusted.outputSettings().prettyPrint(false)
        if (allowRemoteImages) {
            untrusted.select("img[src]").forEach { image ->
                remoteImageUrl(image.attr("src"))?.let { image.attr("src", it) }
            }
        }

        // Cleaner unwraps unknown elements to preserve their text. Active containers are removed
        // first because even preserving their child text would expose script/CSS source to TTS.
        untrusted.select(removableElements).remove()

        val clean = Cleaner(safelist).clean(untrusted)
        clean.outputSettings().prettyPrint(false)

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

    private val SAFE_RASTER_DATA_URI = Regex(
        pattern = "^data:image/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\\r\\n]+$",
        option = RegexOption.IGNORE_CASE,
    )
}
