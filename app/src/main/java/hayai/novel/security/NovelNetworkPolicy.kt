package hayai.novel.security

import java.net.InetAddress
import java.io.IOException
import okhttp3.HttpUrl

/**
 * Network boundary for JavaScript novel plugins.
 *
 * Plugins may use public HTTPS by default. Private, loopback and link-local addresses are rejected
 * before a request is handed to OkHttp, including every redirect target.
 */
class NovelNetworkPolicy(
    private val allowHttp: Boolean = false,
    private val allowedHosts: Set<String> = emptySet(),
) {
    fun validate(rawUrl: String): String {
        val uri = try {
            java.net.URI(rawUrl)
        } catch (error: Exception) {
            throw NovelNetworkPolicyException("The plugin URL is malformed", error)
        }
        val host = uri.host ?: throw NovelNetworkPolicyException("The plugin URL has no host")
        validateSchemeAndHost(uri.scheme, host)
        val addresses = resolve(host.lowercase())
        if (addresses.isEmpty() || addresses.any(::isPrivateAddress)) {
            throw NovelNetworkPolicyException("Private or local plugin addresses are not allowed")
        }
        return rawUrl
    }

    fun validate(url: HttpUrl) {
        validateSchemeAndHost(url.scheme, url.host)
        val host = url.host.lowercase()
        val addresses = resolve(host)
        if (addresses.isEmpty() || addresses.any(::isPrivateAddress)) {
            throw NovelNetworkPolicyException("Private or local plugin addresses are not allowed")
        }
    }

    private fun validateSchemeAndHost(rawScheme: String?, rawHost: String) {
        val scheme = rawScheme?.lowercase().orEmpty()
        if (scheme != "https" && !(allowHttp && scheme == "http")) {
            throw NovelNetworkPolicyException("Only HTTPS plugin requests are allowed")
        }
        val host = rawHost.lowercase()
        if (host.isBlank() || host == "localhost" || host.endsWith(".localhost")) {
            throw NovelNetworkPolicyException("Local plugin hosts are not allowed")
        }
        if (allowedHosts.isNotEmpty() && host !in allowedHosts.map(String::lowercase).toSet()) {
            throw NovelNetworkPolicyException("The plugin host is not authorized")
        }
    }

    private fun resolve(host: String): Array<InetAddress> = try {
        InetAddress.getAllByName(host)
    } catch (error: Exception) {
        throw NovelNetworkPolicyException("The plugin host could not be resolved", error)
    }

    private fun isPrivateAddress(address: InetAddress): Boolean =
        address.isAnyLocalAddress ||
            address.isLoopbackAddress ||
            address.isLinkLocalAddress ||
            address.isSiteLocalAddress ||
            address.isMulticastAddress ||
            address.hostAddress.orEmpty().startsWith("169.254.") ||
            address.hostAddress.orEmpty().startsWith("100.64.")
}

class NovelNetworkPolicyException(message: String, cause: Throwable? = null) : IOException(message, cause)
