package epigraph.sync.core.pairing.transport

import epigraph.sync.core.pairing.CoreHostProbe
import epigraph.sync.core.pairing.DiscoveredCoreHost
import eu.kanade.tachiyomi.network.await
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.CancellationException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.CertificatePinner
import okhttp3.ConnectionPool
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Records the leaf certificate a server presents instead of trusting a pinned one.
 *
 * Only used to read the public discovery descriptor of an address the user typed, which carries
 * the same unauthenticated identity as a DNS-SD announcement. Nothing secret is sent over it; the
 * PIN and every later request use [LeafDerSha256TrustManager] with the fingerprint captured here.
 */
internal class CapturingLeafTrustManager : X509TrustManager {
    @Volatile
    var leafSha256: String? = null
        private set

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull()
            ?: throw CertificateException("TLS server did not provide a leaf certificate")
        leaf.checkValidity()
        leafSha256 = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
            .joinToString("") { "%02x".format(it) }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not trusted by this manager")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
}

/** Reads `/v1/discovery/descriptor` at a typed address and pins its answer to the presented leaf. */
class OkHttpCoreHostProbe internal constructor(
    private val probeClient: (CapturingLeafTrustManager) -> OkHttpClient,
    private val json: Json = DEFAULT_JSON,
) : CoreHostProbe {
    constructor(baseClient: OkHttpClient) : this(probeClient = { trust -> probeClient(baseClient, trust) })

    override suspend fun probe(origin: String): DiscoveredCoreHost? {
        val trust = CapturingLeafTrustManager()
        val request = try {
            Request.Builder()
                .url(origin.toHttpUrl().newBuilder().addPathSegments(DESCRIPTOR_PATH).build())
                .get()
                .header("Accept", "application/json")
                .build()
        } catch (_: IllegalArgumentException) {
            return null
        }
        return try {
            probeClient(trust).newCall(request).await().use { response ->
                if (!response.isSuccessful) return null
                val source = response.body.source()
                source.request(MAX_RESPONSE_BYTES + 1L)
                if (source.buffer.size > MAX_RESPONSE_BYTES) return null
                val descriptor = json.decodeFromString(ProbeDescriptor.serializer(), source.readUtf8())
                DiscoveredCoreHost.fromDescriptor(
                    origin = origin,
                    serverId = descriptor.serverId,
                    descriptorTlsCertSha256 = descriptor.tlsCertSha256,
                    presentedTlsCertSha256 = trust.leafSha256 ?: return null,
                    advertisedOrigin = descriptor.advertisedOrigin?.baseUrl,
                )
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }
    }

    @Serializable
    private data class ProbeDescriptor(
        val serverId: String,
        val tlsCertSha256: String,
        val advertisedOrigin: ProbeOrigin? = null,
    )

    @Serializable
    private data class ProbeOrigin(val baseUrl: String? = null)

    private companion object {
        const val DESCRIPTOR_PATH = "v1/discovery/descriptor"
        const val MAX_RESPONSE_BYTES = 64 * 1024
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            isLenient = false
        }

        fun probeClient(baseClient: OkHttpClient, trust: CapturingLeafTrustManager): OkHttpClient {
            val sslContext = SSLContext.getInstance("TLS").apply {
                init(null, arrayOf(trust), SecureRandom())
            }
            return baseClient.newBuilder()
                .apply {
                    interceptors().clear()
                    networkInterceptors().clear()
                }
                // Never share a connection accepted by this trust manager with a pinned client.
                .connectionPool(ConnectionPool(0, 1, TimeUnit.SECONDS))
                .cache(null)
                .cookieJar(CookieJar.NO_COOKIES)
                .authenticator(Authenticator.NONE)
                .proxyAuthenticator(Authenticator.NONE)
                .eventListener(EventListener.NONE)
                .certificatePinner(CertificatePinner.Builder().build())
                .sslSocketFactory(sslContext.socketFactory, trust)
                // The address is the user's choice and the certificate is self-signed for the
                // desktop, so no name can be verified; the descriptor check below is the identity.
                .hostnameVerifier { _, _ -> trust.leafSha256 != null }
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .connectTimeout(5, TimeUnit.SECONDS)
                .readTimeout(5, TimeUnit.SECONDS)
                .callTimeout(10, TimeUnit.SECONDS)
                .build()
        }
    }
}
