package epigraph.sync.core.events

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreChangeEnvelope
import epigraph.sync.core.protocol.CoreErrorEnvelope
import epigraph.sync.core.replay.CoreReplayCheckpoint
import epigraph.sync.core.replay.CoreReplayCoverage
import epigraph.sync.core.replay.CoreReplayDecision
import epigraph.sync.core.replay.CoreReplayFailurePolicy
import epigraph.sync.core.replay.CoreReplaySession
import epigraph.sync.core.replay.CoreSseDecoder
import epigraph.sync.core.replay.CoreSseProtocolException
import java.io.IOException
import java.io.InputStreamReader
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response

/**
 * Atomic boundary required by the live feed.
 *
 * Implementations must materialize [change] and persist [nextCheckpoint] in one durable
 * transaction. Returning normally is the acknowledgement; throwing leaves the old reconnect
 * cursor authoritative.
 */
fun interface CoreDurableChangeSink {
    suspend fun applyAndPersistCheckpoint(
        change: CoreChangeEnvelope,
        nextCheckpoint: CoreReplayCheckpoint,
    )
}

enum class CoreReconnectReason {
    END_OF_STREAM,
    IO_FAILURE,
    APPLY_FAILURE,
    REPLAY_REQUESTED,
}

sealed interface CoreEventStreamOutcome {
    val checkpoint: CoreReplayCheckpoint

    data class Reconnect(
        override val checkpoint: CoreReplayCheckpoint,
        val reason: CoreReconnectReason,
    ) : CoreEventStreamOutcome

    data class FullBootstrap(
        override val checkpoint: CoreReplayCheckpoint,
        val reasonCode: String?,
    ) : CoreEventStreamOutcome

    data class HttpFailure(
        override val checkpoint: CoreReplayCheckpoint,
        val statusCode: Int,
        val retryable: Boolean,
    ) : CoreEventStreamOutcome
}

/** Real, incremental `GET /v1/events` transport for the legacy-compatible Syncd wire protocol v1. */
class OkHttpCoreEventStream internal constructor(
    client: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val clientVersion: String,
    private val ioDispatcher: CoroutineDispatcher,
    private val json: Json,
    preserveInterceptorsForTests: Boolean,
) {
    constructor(
        client: OkHttpClient,
        baseUrl: HttpUrl,
        clientVersion: String,
        ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
        json: Json = DEFAULT_JSON,
    ) : this(client, baseUrl, clientVersion, ioDispatcher, json, false)

    // A redirect could forward the bearer token or replay cursor to a different origin.
    private val client = client.newBuilder()
        .apply {
            if (!preserveInterceptorsForTests) {
                // Application interceptors may include Chucker/body loggers. The SSE request
                // carries the Core bearer token, so production construction never inherits them.
                interceptors().clear()
                networkInterceptors().clear()
            }
        }
        .cache(null)
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE)
        .eventListener(EventListener.NONE)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        // syncd keeps this response open; liveness is provided by ping events and reconnect policy.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    init {
        require(baseUrl.isHttps) { "Epigraph Core base URL must use HTTPS" }
        require(baseUrl.username.isEmpty() && baseUrl.password.isEmpty()) {
            "Epigraph Core base URL must not contain credentials"
        }
        require(baseUrl.encodedPath == "/" && baseUrl.query == null && baseUrl.fragment == null) {
            "Epigraph Core base URL must be an origin"
        }
        require(clientVersion.isNotBlank() && clientVersion == clientVersion.trim()) {
            "clientVersion must be non-blank and canonical"
        }
    }

    /**
     * Connects once and consumes the stream until it closes or requires another action.
     * [accessToken] is a per-call value and is never stored by this client.
     */
    suspend fun collect(
        accessToken: String,
        session: CoreReplaySession,
        sink: CoreDurableChangeSink,
    ): CoreEventStreamOutcome = withContext(ioDispatcher) {
        require(accessToken.isNotBlank() && accessToken == accessToken.trim()) {
            "accessToken must be non-blank and canonical"
        }
        val request = eventRequest(accessToken, session.checkpoint)
        val call = client.newCall(request)
        val cancellation = currentCoroutineContext()[Job]?.invokeOnCompletion { cause ->
            if (cause != null) call.cancel()
        }
        try {
            call.execute().use { response -> consume(response, session, sink) }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: CoreSseProtocolException) {
            CoreEventStreamOutcome.Reconnect(
                checkpoint = session.checkpoint,
                reason = CoreReconnectReason.IO_FAILURE,
            )
        } catch (_: IOException) {
            CoreEventStreamOutcome.Reconnect(
                checkpoint = session.checkpoint,
                reason = CoreReconnectReason.IO_FAILURE,
            )
        } finally {
            cancellation?.dispose()
            call.cancel()
        }
    }

    private fun eventRequest(accessToken: String, checkpoint: CoreReplayCheckpoint): Request {
        val url = baseUrl.newBuilder()
            .addPathSegments("v1/events")
            .apply {
                val coverage = checkpoint.coverage
                if (coverage is CoreReplayCoverage.Filtered) {
                    addQueryParameter("scopeId", coverage.scopeId)
                }
            }
            .build()
        return Request.Builder()
            .url(url)
            .get()
            .header("Accept", "text/event-stream")
            .header(EpigraphCoreWireProtocol.AUTHORIZATION_HEADER, "Bearer $accessToken")
            .header(EpigraphCoreWireProtocol.CLIENT_VERSION_HEADER, clientVersion)
            .header(
                EpigraphCoreWireProtocol.CLIENT_PROTOCOL_HEADER,
                EpigraphCoreWireProtocol.CURRENT_VERSION.toString(),
            )
            .header(EpigraphCoreWireProtocol.LEGACY_CLIENT_VERSION_HEADER, clientVersion)
            .header(
                EpigraphCoreWireProtocol.LEGACY_CLIENT_PROTOCOL_HEADER,
                EpigraphCoreWireProtocol.CURRENT_VERSION.toString(),
            )
            .header("Last-Event-ID", checkpoint.lastEventIdHeader)
            .build()
    }

    private suspend fun consume(
        response: Response,
        session: CoreReplaySession,
        sink: CoreDurableChangeSink,
    ): CoreEventStreamOutcome {
        if (!response.isSuccessful) return httpFailure(response, session.checkpoint)

        val decoder = CoreSseDecoder(json)
        // SSE is UTF-8 regardless of an optional/misleading HTTP charset parameter.
        val reader = InputStreamReader(response.body.byteStream(), Charsets.UTF_8)
        val characters = CharArray(READ_BUFFER_CHARS)
        while (true) {
            val count = reader.read(characters)
            if (count < 0) break
            if (count == 0) continue
            val events = decoder.feed(String(characters, 0, count))
            for (event in events) {
                when (val decision = session.onEvent(event)) {
                    is CoreReplayDecision.ApplyChange -> {
                        try {
                            sink.applyAndPersistCheckpoint(decision.change, decision.checkpoint)
                            session.confirmDurablyApplied(decision.change.serverVersion)
                        } catch (cancelled: CancellationException) {
                            session.abandonPendingChange()
                            throw cancelled
                        } catch (_: Exception) {
                            return session.abandonPendingChange().let {
                                CoreEventStreamOutcome.Reconnect(
                                    checkpoint = it.checkpoint,
                                    reason = CoreReconnectReason.APPLY_FAILURE,
                                )
                            }
                        }
                    }
                    is CoreReplayDecision.FullBootstrap -> {
                        return CoreEventStreamOutcome.FullBootstrap(
                            checkpoint = session.checkpoint,
                            reasonCode = decision.reasonCode,
                        )
                    }
                    is CoreReplayDecision.ReconnectAndReplay -> {
                        return CoreEventStreamOutcome.Reconnect(
                            checkpoint = decision.checkpoint,
                            reason = CoreReconnectReason.REPLAY_REQUESTED,
                        )
                    }
                    is CoreReplayDecision.Heartbeat,
                    is CoreReplayDecision.IgnoreAlreadySeen,
                    -> Unit
                }
            }
        }
        decoder.finish()
        return CoreEventStreamOutcome.Reconnect(
            checkpoint = session.checkpoint,
            reason = CoreReconnectReason.END_OF_STREAM,
        )
    }

    private fun httpFailure(
        response: Response,
        checkpoint: CoreReplayCheckpoint,
    ): CoreEventStreamOutcome {
        val envelope = runCatching {
            json.decodeFromString<CoreErrorEnvelope>(response.body.string())
        }.getOrNull()
        val replay = CoreReplayFailurePolicy.onHttpFailure(response.code, envelope?.error)
        val requiresBootstrap = replay is CoreReplayDecision.FullBootstrap ||
            response.code == 409 && envelope?.error?.requiredAction == "full_bootstrap"
        return if (requiresBootstrap) {
            CoreEventStreamOutcome.FullBootstrap(checkpoint, envelope?.error?.code)
        } else {
            CoreEventStreamOutcome.HttpFailure(
                checkpoint = checkpoint,
                statusCode = response.code,
                retryable = envelope?.error?.retryable == true || response.code >= 500,
            )
        }
    }

    override fun toString(): String =
        "OkHttpCoreEventStream(baseUrl=$baseUrl, clientVersion=$clientVersion, accessToken=<per-call>)"

    private companion object {
        const val READ_BUFFER_CHARS = 4_096
        val DEFAULT_JSON = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
