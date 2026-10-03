package epigraph.contract

import kotlinx.serialization.Serializable

/**
 * Stable coordinates for content supplied by an extension or plugin.
 * Secret material (cookies, tokens and credentials) is deliberately not representable here.
 */
@Serializable
data class SourceBinding(
    val ecosystem: String,
    val repository: String,
    val plugin: String,
    val sourceId: String,
    val normalizedUrl: String,
) {
    init {
        validateBindingPart(ecosystem, "ecosystem")
        validateBindingPart(repository, "repository")
        validateBindingPart(plugin, "plugin")
        validateBindingPart(sourceId, "source ID")
        require(normalizedUrl == SourceUrlNormalizer.normalize(normalizedUrl)) {
            "normalizedUrl must already be canonical"
        }
    }

    companion object {
        fun create(
            ecosystem: String,
            repository: String,
            plugin: String,
            sourceId: String,
            url: String,
        ): SourceBinding = SourceBinding(
            ecosystem = ecosystem,
            repository = repository,
            plugin = plugin,
            sourceId = sourceId,
            normalizedUrl = SourceUrlNormalizer.normalize(url),
        )
    }
}

object SourceUrlNormalizer {
    /**
     * Canonicalizes the stable parts of a HTTP(S) source URL without decoding its path or query.
     * Fragments are discarded because they are client-side navigation state.
     */
    fun normalize(rawUrl: String): String {
        val input = rawUrl.trim()
        require(input.isNotEmpty()) { "source URL must not be blank" }
        require(input.length <= MAX_URL_LENGTH) { "source URL is too long" }
        require(input.none(Char::isISOControl)) { "source URL must not contain control characters" }
        require(input.none(Char::isWhitespace)) { "source URL must encode whitespace" }

        val schemeSeparator = input.indexOf("://")
        require(schemeSeparator > 0) { "source URL must be absolute" }
        val scheme = input.substring(0, schemeSeparator).lowercase()
        require(scheme == "https" || scheme == "http") { "source URL must use HTTP or HTTPS" }

        val withoutFragment = input.substring(0, input.indexOf('#').takeIf { it >= 0 } ?: input.length)
        val authorityStart = schemeSeparator + 3
        val authorityEnd = withoutFragment.indexOfAny(charArrayOf('/', '?'), authorityStart)
            .takeIf { it >= 0 }
            ?: withoutFragment.length
        val authority = withoutFragment.substring(authorityStart, authorityEnd)
        require(authority.isNotBlank()) { "source URL must contain a host" }
        require('@' !in authority) { "source URL must not contain credentials" }

        val canonicalAuthority = canonicalizeAuthority(authority, scheme)
        val suffix = withoutFragment.substring(authorityEnd).let { if (it == "/") "" else it }
        return "$scheme://$canonicalAuthority$suffix"
    }

    /** Public dependency indexes must never resolve to local/private infrastructure. */
    fun normalizePublicHttpsIndex(rawUrl: String): String {
        val normalized = normalize(rawUrl)
        require(normalized.startsWith("https://")) { "dependency index must use HTTPS" }
        val authorityStart = "https://".length
        val authorityEnd = normalized.indexOfAny(charArrayOf('/', '?'), authorityStart)
            .takeIf { it >= 0 }
            ?: normalized.length
        val authority = normalized.substring(authorityStart, authorityEnd)
        val host = if (authority.startsWith('[')) {
            authority.substringAfter('[').substringBefore(']')
        } else if (authority.count { it == ':' } == 1) {
            authority.substringBeforeLast(':')
        } else {
            authority
        }.lowercase()
        require(!isPrivateHost(host)) { "dependency index must use a public host" }
        require('?' !in normalized && '#' !in normalized) {
            "dependency index must not contain query parameters or fragments"
        }
        return normalized
    }

    private fun isPrivateHost(host: String): Boolean {
        if (
            '.' !in host ||
            host == "localhost" ||
            host.endsWith(".localhost") ||
            host.endsWith(".local") ||
            host.endsWith(".internal") ||
            host.endsWith(".lan") ||
            host == "::1"
        ) {
            return true
        }
        val ipv4 = host.split('.').mapNotNull(String::toIntOrNull)
        if (ipv4.size != 4 || ipv4.any { it !in 0..255 }) return false
        val (a, b) = ipv4
        return a == 0 || a == 10 || a == 127 ||
            (a == 100 && b in 64..127) ||
            (a == 169 && b == 254) ||
            (a == 172 && b in 16..31) ||
            (a == 192 && b == 168) ||
            a >= 224
    }

    private fun canonicalizeAuthority(authority: String, scheme: String): String {
        val (host, port) = if (authority.startsWith('[')) {
            val bracket = authority.indexOf(']')
            require(bracket > 1) { "invalid IPv6 host" }
            val suffix = authority.substring(bracket + 1)
            require(suffix.isEmpty() || suffix.startsWith(':')) { "invalid URL authority" }
            authority.substring(0, bracket + 1) to suffix.removePrefix(":").ifEmpty { null }
        } else {
            val colon = authority.lastIndexOf(':')
            if (colon > 0 && authority.indexOf(':') == colon) {
                authority.substring(0, colon) to authority.substring(colon + 1)
            } else {
                authority to null
            }
        }

        require(host.isNotBlank()) { "source URL must contain a host" }
        val numericPort = port?.let {
            require(it.isNotEmpty() && it.all(Char::isDigit)) { "source URL port must be numeric" }
            val parsed = it.toIntOrNull()
            require(parsed != null && parsed in 1..65535) { "source URL port is out of range" }
            parsed
        }
        val canonicalPort = numericPort?.takeUnless {
            (scheme == "https" && it == 443) || (scheme == "http" && it == 80)
        }
        return buildString {
            append(host.lowercase())
            canonicalPort?.let { append(':').append(it) }
        }
    }
}

private fun validateBindingPart(value: String, label: String) {
    require(value.isNotBlank()) { "$label must not be blank" }
    require(value == value.trim()) { "$label must not have surrounding whitespace" }
    require(value.length <= MAX_BINDING_PART_LENGTH) { "$label is too long" }
    require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
}

private const val MAX_BINDING_PART_LENGTH = 512
private const val MAX_URL_LENGTH = 4096
