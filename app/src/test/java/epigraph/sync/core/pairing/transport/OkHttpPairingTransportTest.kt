package epigraph.sync.core.pairing.transport

import epigraph.sync.core.pairing.PairingClaimRequest
import epigraph.sync.core.pairing.PairingClaimStatus
import epigraph.sync.core.pairing.PairingDevice
import epigraph.sync.core.pairing.PairingErrorCode
import epigraph.sync.core.pairing.PairingPlatform
import epigraph.sync.core.pairing.PairingStatusEventType
import epigraph.sync.core.pairing.PairingStatusSubscription
import epigraph.sync.core.pairing.PairingTransportException
import epigraph.sync.core.pairing.SyncdEndpoint
import java.math.BigInteger
import java.security.MessageDigest
import java.security.Principal
import java.security.PublicKey
import java.security.cert.CertificateExpiredException
import java.security.cert.X509Certificate
import java.util.Date
import java.util.concurrent.CopyOnWriteArrayList
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.ByteString
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotSame
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class OkHttpPairingTransportTest {
    @Test
    fun `claim sends exact syncd route and camel case JSON without retaining token`() = runTest {
        val interceptor = RecordingInterceptor { request ->
            val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            assertEquals("POST", request.method)
            assertEquals("/v1/pairing/claim", request.url.encodedPath)
            assertEquals("application/json", request.header("Accept"))
            assertEquals(
                """{"sessionId":"bootstrap-12345678-1234-1234-1234-123456789abc","pairingCode":"ABCDEF123456","deviceId":"phone-1","deviceName":"Phone","platform":"android","clientVersion":"0.1.0","clientProtocolVersion":1}""",
                body,
            )
            response(request, 200, APPROVED_RESPONSE)
        }
        val transport = transportWith(interceptor)

        val result = transport.claim(ENDPOINT, FINGERPRINT, CLAIM)

        assertEquals(PairingClaimStatus.APPROVED, result.status)
        assertEquals("secret-access-token", result.token?.accessToken)
        assertFalse(result.toString().contains("secret-access-token"))
        assertFalse(result.token.toString().contains("secret-access-token"))
        assertEquals(1, interceptor.requests.size)
    }

    @Test
    fun `claim maps structured syncd errors and TLS failures`() = runTest {
        val conflict = transportWith(
            RecordingInterceptor { request -> response(request, 409, CLAIMED_ERROR) },
        )
        val claimed = try {
            conflict.claim(ENDPOINT, FINGERPRINT, CLAIM)
            error("claimed pairing session should fail")
        } catch (error: PairingTransportException) {
            error
        }
        assertEquals(PairingErrorCode.ALREADY_CLAIMED, claimed.error.code)

        val tls = transportWith(
            RecordingInterceptor { throw SSLPeerUnverifiedException("hostname or pin mismatch") },
        )
        val mismatch = try {
            tls.claim(ENDPOINT, FINGERPRINT, CLAIM)
            error("TLS mismatch should fail")
        } catch (error: PairingTransportException) {
            error
        }
        assertEquals(PairingErrorCode.TLS_MISMATCH, mismatch.error.code)
    }

    @Test
    fun `live channel uses exact WSS URL decodes event and cancels socket with collector`() = runTest {
        val connector = FakeWebSocketConnector()
        val transport = OkHttpPairingTransport(
            pinnedClient = { OkHttpClient() },
            webSocketConnector = connector,
        )
        val subscription = PairingStatusSubscription(
            endpoint = ENDPOINT,
            sessionId = CLAIM.sessionId,
            pairingCode = CLAIM.pairingCode,
            expiresAtMs = 99_999,
        )

        val event = async { transport.statusEvents(subscription, FINGERPRINT).first() }
        runCurrent()
        assertEquals("https", connector.request.url.scheme)
        assertEquals(
            "/v1/bootstrap/session/${CLAIM.sessionId}/live",
            connector.request.url.encodedPath,
        )
        assertEquals(CLAIM.pairingCode, connector.request.url.queryParameter("pairingCode"))

        connector.listener.onMessage(connector.socket, APPROVED_EVENT)
        assertEquals(PairingStatusEventType.FINAL_TOKEN_READY, event.await().type)
        runCurrent()
        assertTrue(connector.socket.cancelled)
    }

    @Test
    fun `live channel rejects binary payload and remains cancellable`() = runTest {
        supervisorScope {
            val connector = FakeWebSocketConnector()
            val transport = OkHttpPairingTransport(
                pinnedClient = { OkHttpClient() },
                webSocketConnector = connector,
            )
            val subscription = PairingStatusSubscription(
                endpoint = ENDPOINT,
                sessionId = CLAIM.sessionId,
                pairingCode = CLAIM.pairingCode,
                expiresAtMs = 99_999,
            )

            val event = async { transport.statusEvents(subscription, FINGERPRINT).first() }
            runCurrent()
            connector.listener.onMessage(connector.socket, ByteString.EMPTY)
            val failure = try {
                event.await()
                error("binary WebSocket payload should fail")
            } catch (error: PairingTransportException) {
                error
            }
            assertEquals(PairingErrorCode.INVALID_RESPONSE, failure.error.code)
            assertTrue(connector.socket.cancelled)
        }
    }

    @Test
    fun `DER trust manager accepts only matching currently valid leaf`() {
        val bytes = "leaf DER bytes".toByteArray()
        val fingerprint = bytes.sha256Hex()
        val trustManager = LeafDerSha256TrustManager(fingerprint)

        trustManager.checkServerTrusted(arrayOf(FakeCertificate(bytes)), "RSA")
        assertThrows(java.security.cert.CertificateException::class.java) {
            trustManager.checkServerTrusted(arrayOf(FakeCertificate("other".toByteArray())), "RSA")
        }
        assertThrows(CertificateExpiredException::class.java) {
            trustManager.checkServerTrusted(arrayOf(FakeCertificate(bytes, expired = true)), "RSA")
        }
        assertThrows(IllegalArgumentException::class.java) {
            LeafDerSha256TrustManager("sha256/not-a-syncd-fingerprint")
        }
    }

    @Test
    fun `paired hostname verifier follows the certificate across LAN addresses`() {
        val bytes = "leaf DER bytes".toByteArray()
        val verifier = LeafDerSha256HostnameVerifier(bytes.sha256Hex())

        assertTrue(verifier.matches(FakeCertificate(bytes)))
        assertFalse(verifier.matches(FakeCertificate("other".toByteArray())))
        assertFalse(verifier.matches(FakeCertificate(bytes, expired = true)))
    }

    @Test
    fun `pinned client removes loggers cache cookies redirects retries and unsafe hostname verifier`() {
        val unsafeVerifier = javax.net.ssl.HostnameVerifier { _, _ -> true }
        val base = OkHttpClient.Builder()
            .hostnameVerifier(unsafeVerifier)
            .addInterceptor { chain -> chain.proceed(chain.request()) }
            .addNetworkInterceptor { chain -> chain.proceed(chain.request()) }
            .build()

        val pinned = PinnedPairingClientFactory(base).create(FINGERPRINT)

        assertTrue(pinned.interceptors.isEmpty())
        assertTrue(pinned.networkInterceptors.isEmpty())
        assertFalse(pinned.followRedirects)
        assertFalse(pinned.followSslRedirects)
        assertFalse(pinned.retryOnConnectionFailure)
        assertNotSame(unsafeVerifier, pinned.hostnameVerifier)
        assertTrue(pinned.hostnameVerifier is LeafDerSha256HostnameVerifier)
        assertEquals(0, pinned.certificatePinner.pins.size)
    }

    @Test
    fun `pin resolve posts exact route and maps desktop PIN errors`() = runTest {
        val interceptor = RecordingInterceptor { request ->
            val body = Buffer().also { request.body!!.writeTo(it) }.readUtf8()
            assertEquals("POST", request.method)
            assertEquals("/v1/pairing/pin/resolve", request.url.encodedPath)
            assertEquals("""{"pin":"377299"}""", body)
            response(request, 200, PIN_PAYLOAD)
        }

        val payload = transportWith(interceptor).resolvePin(ENDPOINT, FINGERPRINT, "377299")

        assertEquals("DESKTOP-EPIGRAPH", payload.deviceName)
        assertEquals("server-a", payload.serverId)
        assertEquals(2, payload.schemaVersion)
        assertEquals("https://192.168.1.20:9443/v1/pairing/claim", payload.claimUrl)

        suspend fun failureFor(status: Int, body: String): PairingErrorCode = try {
            transportWith(RecordingInterceptor { request -> response(request, status, body) })
                .resolvePin(ENDPOINT, FINGERPRINT, "000000")
            error("PIN resolve should fail")
        } catch (failure: PairingTransportException) {
            failure.error.code
        }
        assertEquals(
            PairingErrorCode.PIN_NOT_FOUND,
            failureFor(404, """{"error":{"code":"PAIRING_PIN_NOT_FOUND","message":"x","retryable":false}}"""),
        )
        assertEquals(
            PairingErrorCode.PIN_LOCKED,
            failureFor(409, """{"error":{"code":"PAIRING_PIN_LOCKED","message":"x","retryable":true}}"""),
        )
        assertEquals(PairingErrorCode.PIN_INVALID, failureFor(400, """{"error":{"code":"BAD_REQUEST"}}"""))
        assertEquals(PairingErrorCode.INVALID_RESPONSE, failureFor(200, "{}"))
    }

    @Test
    fun `address probe reads the public descriptor and pins the certificate that answered`() = runTest {
        val leaf = "probed leaf".toByteArray()
        var presented = leaf
        var descriptorFingerprint = leaf.sha256Hex()
        val requests = CopyOnWriteArrayList<Request>()
        val probe = OkHttpCoreHostProbe(
            probeClient = { trust ->
                OkHttpClient.Builder().addInterceptor { chain ->
                    val request = chain.request().also(requests::add)
                    // Stands in for the TLS handshake the real client performs.
                    trust.checkServerTrusted(arrayOf(FakeCertificate(presented)), "ECDHE_ECDSA")
                    response(
                        request,
                        200,
                        """{"descriptorVersion":1,"serverId":"server-a","tlsCertSha256":"$descriptorFingerprint",""" +
                            """"advertisedOrigin":{"baseUrl":"https://192.168.15.3:4787","policyName":"lan"}}""",
                    )
                }.build()
            },
        )

        val host = probe.probe("https://192.168.15.3:4787")!!
        assertEquals("server-a", host.serverId)
        assertEquals(leaf.sha256Hex(), host.tlsCertSha256)
        assertEquals(listOf("https://192.168.15.3:4787"), host.origins)
        assertEquals("GET", requests.single().method)
        assertEquals("/v1/discovery/descriptor", requests.single().url.encodedPath)
        assertEquals(null, requests.single().body)

        // A descriptor that names a different certificate than the one presented is not a host.
        presented = "interceptor leaf".toByteArray()
        assertEquals(null, probe.probe("https://192.168.15.3:4787"))

        presented = leaf
        descriptorFingerprint = "not-a-fingerprint"
        assertEquals(null, probe.probe("https://192.168.15.3:4787"))
    }

    @Test
    fun `address probe treats errors and unreachable hosts as not found`() = runTest {
        val notFound = OkHttpCoreHostProbe(
            probeClient = { _ ->
                OkHttpClient.Builder().addInterceptor { chain -> response(chain.request(), 404, "{}") }.build()
            },
        )
        assertEquals(null, notFound.probe("https://192.168.15.3:4787"))

        val unreachable = OkHttpCoreHostProbe(
            probeClient = { _ ->
                OkHttpClient.Builder().addInterceptor { throw java.net.ConnectException("refused") }.build()
            },
        )
        assertEquals(null, unreachable.probe("https://192.168.15.3:4787"))
    }

    private fun transportWith(interceptor: Interceptor) = OkHttpPairingTransport(
        pinnedClient = { OkHttpClient.Builder().addInterceptor(interceptor).build() },
    )

    private class RecordingInterceptor(
        private val responder: (Request) -> Response,
    ) : Interceptor {
        val requests = CopyOnWriteArrayList<Request>()

        override fun intercept(chain: Interceptor.Chain): Response {
            return responder(chain.request().also(requests::add))
        }
    }

    private class FakeWebSocketConnector : PairingWebSocketConnector {
        lateinit var request: Request
        lateinit var listener: WebSocketListener
        val socket = FakeWebSocket()

        override fun open(
            client: OkHttpClient,
            request: Request,
            listener: WebSocketListener,
        ): WebSocket {
            this.request = request
            this.listener = listener
            return socket
        }
    }

    private class FakeWebSocket : WebSocket {
        var cancelled = false

        override fun request(): Request = Request.Builder().url("wss://core.local/").build()
        override fun queueSize(): Long = 0
        override fun send(text: String): Boolean = true
        override fun send(bytes: ByteString): Boolean = true
        override fun close(code: Int, reason: String?): Boolean = true
        override fun cancel() {
            cancelled = true
        }
    }

    @Suppress("DEPRECATION")
    private class FakeCertificate(
        private val der: ByteArray,
        private val expired: Boolean = false,
    ) : X509Certificate() {
        override fun checkValidity() {
            if (expired) throw CertificateExpiredException()
        }

        override fun checkValidity(date: Date?) = checkValidity()
        override fun getEncoded(): ByteArray = der.copyOf()
        override fun getVersion(): Int = 3
        override fun getSerialNumber(): BigInteger = BigInteger.ONE
        override fun getIssuerDN(): Principal = Principal { "CN=Epigraph Core" }
        override fun getSubjectDN(): Principal = Principal { "CN=Epigraph Core" }
        override fun getNotBefore(): Date = Date(0)
        override fun getNotAfter(): Date = Date(Long.MAX_VALUE)
        override fun getTBSCertificate(): ByteArray = der.copyOf()
        override fun getSignature(): ByteArray = byteArrayOf()
        override fun getSigAlgName(): String = "SHA256withRSA"
        override fun getSigAlgOID(): String = "1.2.840.113549.1.1.11"
        override fun getSigAlgParams(): ByteArray? = null
        override fun getIssuerUniqueID(): BooleanArray? = null
        override fun getSubjectUniqueID(): BooleanArray? = null
        override fun getKeyUsage(): BooleanArray? = null
        override fun getBasicConstraints(): Int = -1
        override fun verify(key: PublicKey?) = Unit
        override fun verify(key: PublicKey?, sigProvider: String?) = Unit
        override fun toString(): String = "FakeCertificate"
        override fun getPublicKey(): PublicKey? = null
        override fun hasUnsupportedCriticalExtension(): Boolean = false
        override fun getCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getNonCriticalExtensionOIDs(): MutableSet<String>? = null
        override fun getExtensionValue(oid: String?): ByteArray? = null
    }

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        val ENDPOINT = SyncdEndpoint("https://192.168.1.20:9443")
        val FINGERPRINT = "ab".repeat(32)
        val CLAIM = PairingClaimRequest(
            sessionId = "bootstrap-12345678-1234-1234-1234-123456789abc",
            pairingCode = "ABCDEF123456",
            deviceId = "phone-1",
            deviceName = "Phone",
            platform = PairingPlatform.ANDROID,
            clientVersion = PairingDevice("unused", "unused").clientVersion,
            clientProtocolVersion = PairingDevice("unused", "unused").protocolVersion,
        )

        fun response(request: Request, code: Int, body: String): Response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(code)
            .message("test")
            .body(body.toResponseBody(JSON))
            .build()

        fun ByteArray.sha256Hex(): String = MessageDigest.getInstance("SHA-256")
            .digest(this)
            .joinToString("") { "%02x".format(it) }

        val APPROVED_RESPONSE = """
            {
              "status":"approved",
              "sessionId":"${CLAIM.sessionId}",
              "profileId":"main",
              "claimedDeviceId":"phone-1",
              "expiresAtMs":99999,
              "token":{
                "accessToken":"secret-access-token",
                "tokenId":"token-1",
                "profileId":"main",
                "scopes":["books:global"],
                "inactivityExpiresAtMs":199999,
                "grantedVia":"qr"
              }
            }
        """.trimIndent()

        // serde camelCase shape of syncd `models.rs` BootstrapPayloadResponse.
        val PIN_PAYLOAD = """
            {
              "schemaVersion":2,
              "serverId":"server-a",
              "deviceName":"DESKTOP-EPIGRAPH",
              "pairingSessionId":"bootstrap-12345678-1234-1234-1234-123456789abc",
              "pairingCode":"0192A7C4E5F1",
              "syncdBaseUrl":"https://192.168.1.20:9443",
              "claimUrl":"https://192.168.1.20:9443/v1/pairing/claim",
              "profileId":"main",
              "expiresAtMs":99999,
              "tlsCertSha256":"$FINGERPRINT",
              "mdnsServiceName":"epigraph-syncd-server-a._epigraph-sync._tcp.local."
            }
        """.trimIndent()

        val CLAIMED_ERROR = """
            {"error":{"code":"PAIRING_SESSION_ALREADY_CLAIMED","message":"claimed","retryable":false}}
        """.trimIndent()

        val APPROVED_EVENT = """
            {
              "type":"final_token_ready",
              "sessionId":"${CLAIM.sessionId}",
              "profileId":"main",
              "status":"approved",
              "expiresAtMs":99999,
              "claimedDeviceId":"phone-1"
            }
        """.trimIndent()
    }
}
