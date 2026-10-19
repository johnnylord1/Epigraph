package epigraph.sync.core.novels

import epigraph.contract.SourceUrlNormalizer
import java.net.URI
import java.security.MessageDigest

/**
 * Identity rules for LNReader repositories and plugins, matching the Core byte for byte.
 *
 * The Core recomputes these ids from the patch and rejects a mutation whose id disagrees, so the
 * phone and the desktop must derive the same `novel-repository:` and `novel-plugin:` ids for the
 * same repository URL. URLs the Core would canonicalize differently (dot segments, characters it
 * percent-encodes, non-ASCII hosts) are refused instead of guessed.
 */
object CoreNovelDependencyIds {
    /** The Core's canonical form of a public HTTPS repository index URL, or null. */
    fun canonicalRepositoryUrl(raw: String): String? {
        val uri = runCatching { URI(raw.trim()) }.getOrNull() ?: return null
        if (!uri.scheme.equals("https", ignoreCase = true)) return null
        if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
        val host = uri.host?.lowercase() ?: return null
        if (!HOST.matches(host)) return null
        val port = uri.port.takeUnless { it == -1 || it == 443 }?.let { ":$it" }.orEmpty()
        val rawPath = uri.rawPath.orEmpty()
        if (!PATH.matches(rawPath) || rawPath.split('/').any { it == "." || it == ".." }) return null
        val path = when {
            rawPath.isEmpty() -> "/"
            rawPath.length > 1 && rawPath.endsWith('/') -> rawPath.trimEnd('/').ifEmpty { "/" }
            else -> rawPath
        }
        val canonical = "https://$host$port$path"
        // Private repositories stay local configuration and never cross Syncd.
        runCatching { SourceUrlNormalizer.normalizePublicHttpsIndex(canonical) }.getOrNull() ?: return null
        return canonical
    }

    fun repositoryId(canonicalUrl: String): String = "novel-repository:${sha256Hex(canonicalUrl.toByteArray())}"

    fun pluginId(repositoryId: String, pluginId: String, sourceId: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(repositoryId.toByteArray())
        digest.update(0)
        digest.update(pluginId.toByteArray())
        digest.update(0)
        digest.update(sourceId.toByteArray())
        return "novel-plugin:${digest.digest().toHex()}"
    }

    /** Same label the desktop publishes, so either device may own the record. */
    fun repositoryDisplayName(canonicalUrl: String): String {
        val owner = runCatching { URI(canonicalUrl).rawPath }.getOrNull()
            ?.split('/')
            ?.firstOrNull(String::isNotEmpty)
        return if (owner != null && !owner.equals("lnreader", ignoreCase = true)) "$owner plugins" else "LNReader plugins"
    }

    fun sha256Hex(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).toHex()

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private val HOST = Regex("[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+")
    private val PATH = Regex("(?:/(?:[A-Za-z0-9\\-._~!\$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*")
}
