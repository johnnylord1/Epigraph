package epigraph.sync.core.pairing.transport

import epigraph.sync.core.pairing.BootstrapPayloadResponse
import epigraph.sync.core.pairing.PairingClaimRequest
import epigraph.sync.core.pairing.PairingClaimResponse
import epigraph.sync.core.pairing.PairingError
import epigraph.sync.core.pairing.PairingErrorCode
import epigraph.sync.core.pairing.PairingPinResolveRequest
import epigraph.sync.core.pairing.PairingPinTransport
import epigraph.sync.core.pairing.PairingStatusEvent
import epigraph.sync.core.pairing.PairingStatusSubscription
import epigraph.sync.core.pairing.PairingTransport
import epigraph.sync.core.pairing.PairingTransportErrorMapper
import epigraph.sync.core.pairing.PairingTransportException
import epigraph.sync.core.pairing.SyncdEndpoint
import epigraph.sync.core.protocol.CoreErrorEnvelope
import eu.kanade.tachiyomi.network.await
import java.security.cert.CertificateException
import java.util.concurrent.CancellationException
import javax.net.ssl.SSLHandshakeException
import javax.net.ssl.SSLPeerUnverifiedException
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString

/** Real public pairing transport for the existing Epigraph Core/Syncd v1 routes. */
class OkHttpPairingTransport internal constructor(
    private val pinnedClient: (String) -> OkHttpClient,
    private val webSocketConnector: PairingWebSocketConnector = PairingWebSocketConnector.DEFAULT,
    private val json: Json = DEFAULT_JSON,
) : PairingTransport, PairingPinTransport {
    constructor(baseClient: OkHttpClient) : this(
        pinnedClient = PinnedPairingClientFactory(baseClient)::create,
        webSocketConnector = PairingWebSocketConnector.DEFAULT,
        json = DEFAULT_JSON,
    )

    override suspend fun claim(
        endpoint: SyncdEndpoint,
        tlsCertSha256: String,
        request: PairingClaimRequest,
    ): PairingClaimResponse {
        val body = json.encodeToString(PairingClaimRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        val httpRequest = Request.Builder()
            .url(endpointUrl(endpoint, endpoint.claimPath))
            .post(body)
            .header("Accept", "application/json")
            .build()

        try {
            return pinnedClient(tlsCertSha256).newCall(httpRequest).await().use { response ->
                val responseBody = response.readBoundedBody()
                if (!response.isSuccessful) {
                    throw mappedCoreFailure(response.code, responseBody)
                }
                try {
                    json.decodeFromString(PairingClaimResponse.serializer(), responseBody)
                } catch (_: SerializationException) {
                    throw invalidResponse()
                } catch (_: IllegalArgumentException) {
                    throw invalidResponse()
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: PairingTransportException) {
            throw error
        } catch (error: Throwable) {
            throw transportFailure(error)
        }
    }

    override suspend fun resolvePin(
        endpoint: SyncdEndpoint,
        tlsCertSha256: String,
        pin: String,
    ): BootstrapPayloadResponse {
        val body = json.encodeToString(PairingPinResolveRequest.serializer(), PairingPinResolveRequest(pin))
            .toRequestBody(JSON_MEDIA_TYPE)
        val httpRequest = Request.Builder()
            .url(endpointUrl(endpoint, endpoint.pinResolvePath))
            .post(body)
            .header("Accept", "application/json")
            .build()

        try {
            return pinnedClient(tlsCertSha256).newCall(httpRequest).await().use { response ->
                val responseBody = response.readBoundedBody()
                if (!response.isSuccessful) {
                    if (response.code == 400) {
                        throw PairingTransportException(PairingError(PairingErrorCode.PIN_INVALID))
                    }
                    throw mappedCoreFailure(response.code, responseBody)
                }
                try {
                    json.decodeFromString(BootstrapPayloadResponse.serializer(), responseBody)
                } catch (_: SerializationException) {
                    throw invalidResponse()
                } catch (_: IllegalArgumentException) {
                    throw invalidResponse()
                }
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: PairingTransportException) {
            throw error
        } catch (error: Throwable) {
            throw transportFailure(error)
        }
    }

    override fun statusEvents(
        subscription: PairingStatusSubscription,
        tlsCertSha256: String,
    ): Flow<PairingStatusEvent> = callbackFlow {
        val request = Request.Builder()
            .url(liveStatusUrl(subscription))
            .get()
            .build()
        val client = try {
            pinnedClient(tlsCertSha256)
        } catch (error: Throwable) {
            close(transportFailure(error))
            return@callbackFlow
        }

        val listener = object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (text.toByteArray(Charsets.UTF_8).size > MAX_RESPONSE_BYTES) {
                    webSocket.cancel()
                    close(invalidResponse())
                    return
                }
                val event = try {
                    json.decodeFromString(PairingStatusEvent.serializer(), text)
                } catch (_: SerializationException) {
                    webSocket.cancel()
                    close(invalidResponse())
                    return
                } catch (_: IllegalArgumentException) {
                    webSocket.cancel()
                    close(invalidResponse())
                    return
                }
                if (trySend(event).isFailure) {
                    webSocket.cancel()
                    close(
                        PairingTransportException(
                            PairingError(PairingErrorCode.NETWORK),
                        ),
                    )
                }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                webSocket.cancel()
                close(invalidResponse())
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, "")
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                close()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val failure = if (response != null) {
                    response.use {
                        runCatching { mappedCoreFailure(it.code, it.readBoundedBody()) }
                            .getOrElse(::transportFailure)
                    }
                } else {
                    transportFailure(t)
                }
                close(failure)
            }
        }
        val socket = try {
            webSocketConnector.open(client, request, listener)
        } catch (error: Throwable) {
            close(transportFailure(error))
            return@callbackFlow
        }
        awaitClose { socket.cancel() }
    }

    private fun mappedCoreFailure(statusCode: Int, body: String): PairingTransportException {
        val coreCode = runCatching {
            json.decodeFromString(CoreErrorEnvelope.serializer(), body).error.code
        }.getOrNull()
        return PairingTransportException(PairingTransportErrorMapper.fromCore(statusCode, coreCode))
    }

    private fun liveStatusUrl(subscription: PairingStatusSubscription) =
        // OkHttp's WebSocket API accepts an HTTPS request URL and performs a secure upgrade.
        // HttpUrl itself intentionally supports only http/https, not ws/wss.
        subscription.endpoint.origin.toHttpUrl().newBuilder()
            .addPathSegments(subscription.endpoint.liveStatusPath(subscription.sessionId).removePrefix("/"))
            .addQueryParameter("pairingCode", subscription.pairingCode)
            .build()

    private fun endpointUrl(endpoint: SyncdEndpoint, path: String) =
        endpoint.origin.toHttpUrl().newBuilder()
            .addPathSegments(path.removePrefix("/"))
            .build()

    private fun Response.readBoundedBody(): String {
        val source = body.source()
        source.request(MAX_RESPONSE_BYTES + 1L)
        if (source.buffer.size > MAX_RESPONSE_BYTES) throw invalidResponse()
        return source.readUtf8()
    }

    private companion object {
        const val MAX_RESPONSE_BYTES = 64 * 1024
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            isLenient = false
            coerceInputValues = false
            explicitNulls = false
        }

        fun invalidResponse() = PairingTransportException(
            PairingError(PairingErrorCode.INVALID_RESPONSE),
        )

        fun transportFailure(error: Throwable): PairingTransportException {
            if (error is PairingTransportException) return error
            val tlsFailure = generateSequence(error as Throwable?) { it.cause }
                .any {
                    it is SSLPeerUnverifiedException ||
                        it is SSLHandshakeException ||
                        it is CertificateException
                }
            return PairingTransportException(
                PairingError(if (tlsFailure) PairingErrorCode.TLS_MISMATCH else PairingErrorCode.NETWORK),
            )
        }
    }
}

internal fun interface PairingWebSocketConnector {
    fun open(client: OkHttpClient, request: Request, listener: WebSocketListener): WebSocket

    companion object {
        val DEFAULT = PairingWebSocketConnector(OkHttpClient::newWebSocket)
    }
}
