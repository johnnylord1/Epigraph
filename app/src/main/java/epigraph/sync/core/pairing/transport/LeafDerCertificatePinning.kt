package epigraph.sync.core.pairing.transport

import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSession
import javax.net.ssl.X509TrustManager
import okhttp3.Authenticator
import okhttp3.CertificatePinner
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.OkHttpClient

/**
 * Trusts exactly the leaf certificate advertised by the syncd bootstrap bundle.
 *
 * syncd fingerprints the complete DER-encoded leaf certificate. OkHttp's [CertificatePinner]
 * cannot be used here because it pins the SubjectPublicKeyInfo instead.
 */
internal class LeafDerSha256TrustManager(
    expectedFingerprint: String,
) : X509TrustManager {
    private val expectedDigest = decodeFingerprint(expectedFingerprint)

    override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        val leaf = chain?.firstOrNull()
            ?: throw CertificateException("TLS server did not provide a leaf certificate")
        if (authType.isNullOrBlank()) {
            throw CertificateException("TLS server authentication type is missing")
        }

        // A matching fingerprint must never revive an expired or not-yet-valid certificate.
        leaf.checkValidity()
        val actualDigest = MessageDigest.getInstance(SHA_256).digest(leaf.encoded)
        if (!MessageDigest.isEqual(expectedDigest, actualDigest)) {
            throw CertificateException("Epigraph Core TLS leaf fingerprint does not match")
        }
    }

    override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
        throw CertificateException("Client certificates are not trusted by this manager")
    }

    override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()

    private companion object {
        const val SHA_256 = "SHA-256"
        val FINGERPRINT = Regex("[0-9a-fA-F]{64}")

        fun decodeFingerprint(value: String): ByteArray {
            require(FINGERPRINT.matches(value)) { "Invalid SHA-256 certificate fingerprint" }
            return ByteArray(value.length / 2) { index ->
                value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
            }
        }
    }
}

/**
 * Binds a discovered endpoint to the exact certificate from the pairing bundle.
 *
 * Core endpoints can move between LAN addresses after pairing, so DNS/IP SAN validation cannot be
 * the server identity. The complete leaf DER fingerprint is the identity established out of band.
 * The trust manager performs the same check during the TLS handshake; this verifier repeats it for
 * OkHttp's hostname stage instead of accepting an unrelated certificate for a new address.
 */
internal class LeafDerSha256HostnameVerifier(
    expectedFingerprint: String,
) : javax.net.ssl.HostnameVerifier {
    private val expectedDigest = decodeFingerprint(expectedFingerprint)

    override fun verify(hostname: String?, session: SSLSession?): Boolean {
        if (hostname.isNullOrBlank() || session == null) return false
        val leaf = runCatching { session.peerCertificates.firstOrNull() as? X509Certificate }
            .getOrNull()
            ?: return false
        return matches(leaf)
    }

    internal fun matches(certificate: X509Certificate): Boolean {
        val actualDigest = runCatching {
            certificate.checkValidity()
            MessageDigest.getInstance(SHA_256).digest(certificate.encoded)
        }.getOrNull() ?: return false
        return MessageDigest.isEqual(expectedDigest, actualDigest)
    }

    private companion object {
        const val SHA_256 = "SHA-256"
        val FINGERPRINT = Regex("[0-9a-fA-F]{64}")

        fun decodeFingerprint(value: String): ByteArray {
            require(FINGERPRINT.matches(value)) { "Invalid SHA-256 certificate fingerprint" }
            return ByteArray(value.length / 2) { index ->
                value.substring(index * 2, index * 2 + 2).toInt(16).toByte()
            }
        }
    }
}

/** Builds a one-pin client without carrying loggers, caches, cookies, or unsafe verifiers. */
internal class PinnedPairingClientFactory(
    private val baseClient: OkHttpClient,
) {
    fun create(tlsCertSha256: String): OkHttpClient {
        val trustManager = LeafDerSha256TrustManager(tlsCertSha256)
        val hostnameVerifier = LeafDerSha256HostnameVerifier(tlsCertSha256)
        val sslContext = SSLContext.getInstance("TLS").apply {
            init(null, arrayOf(trustManager), SecureRandom())
        }

        return baseClient.newBuilder()
            // A supplied application client can contain body-logging interceptors. Pairing claim
            // responses contain the only clear-text copy of the access token, so none are kept.
            .apply {
                interceptors().clear()
                networkInterceptors().clear()
            }
            .cache(null)
            .cookieJar(CookieJar.NO_COOKIES)
            .authenticator(Authenticator.NONE)
            .proxyAuthenticator(Authenticator.NONE)
            .eventListener(EventListener.NONE)
            .certificatePinner(CertificatePinner.Builder().build())
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            // Do not inherit an application-provided permissive verifier. The paired leaf
            // certificate, not a changeable LAN address, is the endpoint identity.
            .hostnameVerifier(hostnameVerifier)
            .followRedirects(false)
            .followSslRedirects(false)
            // A successful approved claim rotates the token, so an automatic replay is unsafe.
            .retryOnConnectionFailure(false)
            .build()
    }

}

/** Shared TLS factory for every authenticated aethon-syncd HTTP/SSE/asset call. */
class EpigraphCoreTlsClientFactory(
    baseClient: OkHttpClient,
) {
    private val delegate = PinnedPairingClientFactory(baseClient)

    fun create(tlsCertSha256: String): OkHttpClient = delegate.create(tlsCertSha256)
}
