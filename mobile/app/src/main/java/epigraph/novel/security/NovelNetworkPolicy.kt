package epigraph.novel.security

import java.net.Inet6Address
import java.net.InetAddress
import java.io.IOException
import okhttp3.Dns
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

    /**
     * Wraps [delegate] so every connection, redirects included, is refused when the host resolves
     * to a private address. Checking once before the request is not enough: the name can resolve
     * differently when OkHttp connects (DNS rebinding).
     */
    fun publicOnlyDns(delegate: Dns = Dns.SYSTEM): Dns = Dns { hostname ->
        val host = hostname.lowercase()
        if (host == "localhost" || host.endsWith(".localhost")) {
            throw NovelNetworkPolicyException("Local plugin hosts are not allowed")
        }
        val addresses = delegate.lookup(host)
        if (addresses.isEmpty() || addresses.any(::isPrivateAddress)) {
            throw NovelNetworkPolicyException("Private or local plugin addresses are not allowed")
        }
        addresses
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
            address.hostAddress.orEmpty().startsWith("100.64.") ||
            (address.address.size == 4 && address.address[0] == 0.toByte()) ||
            // IPv6 unique local addresses (fc00::/7) are the private range isSiteLocal misses.
            address is Inet6Address && (address.address[0].toInt() and 0xfe) == 0xfc
}

class NovelNetworkPolicyException(message: String, cause: Throwable? = null) : IOException(message, cause)
