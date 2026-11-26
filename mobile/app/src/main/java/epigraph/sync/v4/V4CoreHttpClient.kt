package epigraph.sync.v4

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreErrorEnvelope
import eu.kanade.tachiyomi.network.await
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromStream
import kotlinx.serialization.json.encodeToStream
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okio.Buffer
import okio.GzipSink
import okio.buffer
import java.io.ByteArrayOutputStream
import java.util.zip.Deflater
import java.util.zip.GZIPOutputStream

/**
 * HTTP client for the Sync V4 endpoints using the paired Core transport.
 *
 * Uses gzip compression for bulk uploads and conditional `If-None-Match` (`304 Not Modified`)
 * for snapshots. OkHttp negotiates and decodes gzip responses before parsing JSON.
 */
@OptIn(ExperimentalSerializationApi::class)
class V4CoreHttpClient(
    baseClient: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val clientVersion: String,
    private val hlcClock: V4HlcClock? = null,
    private val json: Json = DEFAULT_JSON,
) {
    private val client = baseClient.newBuilder()
        .cache(null)
        .cookieJar(CookieJar.NO_COOKIES)
        .authenticator(Authenticator.NONE)
        .proxyAuthenticator(Authenticator.NONE)
        .eventListener(EventListener.NONE)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    suspend fun capabilities(accessToken: String): CoreHttpResult<V4CapabilitiesResponse> =
        executeJson(
            protectedBuilder(endpoint("v4/capabilities"), accessToken)
                .get()
                .build(),
        )

    /**
     * Fetches the V4 snapshot for the authenticated profile. Returns `Success(null)` on
     * HTTP `304 Not Modified` when `ifNoneMatch` matches the Core's current `(profile, serverSeq)`.
     *
     * With [limit] set, the Core returns one page of records with `serverSeq > afterSeq`; without
     * it, the request is the classic single full snapshot.
     */
    suspend fun snapshot(
        accessToken: String,
        domain: String? = null,
        includeTombstones: Boolean = true,
        ifNoneMatch: String? = null,
        afterSeq: Long? = null,
        limit: Long? = null,
    ): CoreHttpResult<V4SnapshotResponse?> {
        val url = endpoint("v4/snapshot").newBuilder()
            .apply {
                if (!domain.isNullOrBlank()) addQueryParameter("domain", domain)
                addQueryParameter("includeTombstones", includeTombstones.toString())
                if (afterSeq != null) addQueryParameter("afterSeq", afterSeq.toString())
                if (limit != null) addQueryParameter("limit", limit.toString())
            }
            .build()
        val req = protectedBuilder(url, accessToken)
            .apply { if (!ifNoneMatch.isNullOrBlank()) header("If-None-Match", ifNoneMatch) }
            .get()
            .build()

        return client.newCall(req).await().use { response ->
            observeServerTime(response)
            when (response.code) {
                304 -> CoreHttpResult.Success(null, etag = response.header("ETag") ?: ifNoneMatch)
                in 200..299 -> {
                    val parsed = json.decodeFromStream<V4SnapshotResponse>(response.body.byteStream())
                    hlcClock?.calibrateServerTime(parsed.serverTimeMs)
                    CoreHttpResult.Success(parsed, etag = response.header("ETag"))
                }
                else -> CoreHttpResult.Failure(response.code, parseErrorEnvelope(response.body.string()))
            }
        }
    }

    suspend fun syncBulk(
        accessToken: String,
        items: List<V4OutgoingItem>,
        expectedServerSeq: Long? = null,
        finalBatch: Boolean = true,
    ): CoreHttpResult<V4WriteSummary> {
        val compressed = ByteArrayOutputStream()
        object : GZIPOutputStream(compressed) {
            init {
                def.setLevel(Deflater.BEST_SPEED)
            }
        }.use { gz ->
            json.encodeToStream(V4BatchRequest(items, expectedServerSeq, finalBatch), gz)
        }
        val body = compressed.toByteArray().toRequestBody(JSON_MEDIA_TYPE)
        val req = protectedBuilder(endpoint("v4/sync/bulk"), accessToken)
            .header("Content-Encoding", "gzip")
            .post(body)
            .build()
        return executeJson<V4WriteSummary>(req).also { result ->
            if (result is CoreHttpResult.Success) {
                hlcClock?.calibrateServerTime(result.value.serverTimeMs)
            }
        }
    }

    suspend fun pushDeltas(
        accessToken: String,
        items: List<V4OutgoingItem>,
    ): CoreHttpResult<V4WriteSummary> {
        val raw = json.encodeToString(V4BatchRequest(items)).toByteArray(Charsets.UTF_8)
        val useGzip = raw.size >= 1024
        val body = (if (useGzip) gzipBytes(raw) else raw).toRequestBody(JSON_MEDIA_TYPE)
        val req = protectedBuilder(endpoint("v4/deltas"), accessToken)
            .apply { if (useGzip) header("Content-Encoding", "gzip") }
            .post(body)
            .build()
        return executeJson<V4WriteSummary>(req).also { result ->
            if (result is CoreHttpResult.Success) {
                hlcClock?.calibrateServerTime(result.value.serverTimeMs)
            }
        }
    }

    suspend fun changes(
        accessToken: String,
        sinceSeq: Long,
        limit: Int = 1_000,
    ): CoreHttpResult<V4ChangesResponse> {
        val url = endpoint("v4/changes").newBuilder()
            .addQueryParameter("sinceSeq", sinceSeq.toString())
            .addQueryParameter("limit", limit.toString())
            .build()
        val req = protectedBuilder(url, accessToken)
            .get()
            .build()
        return executeJson<V4ChangesResponse>(req).also { result ->
            if (result is CoreHttpResult.Success) {
                hlcClock?.calibrateServerTime(result.value.serverTimeMs)
            }
        }
    }

    suspend fun headExtensionPackage(
        accessToken: String,
        kind: String,
        packageId: String,
        version: String,
    ): Boolean {
        val url = extensionPackageUrl(kind, packageId, version)
        val req = protectedBuilder(url, accessToken).head().build()
        return client.newCall(req).await().use { response ->
            observeServerTime(response)
            response.isSuccessful
        }
    }

    suspend fun getExtensionPackage(
        accessToken: String,
        kind: String,
        packageId: String,
        version: String,
    ): CoreHttpResult<ByteArray> {
        val url = extensionPackageUrl(kind, packageId, version)
        val req = protectedBuilder(url, accessToken).get().build()
        return client.newCall(req).await().use { response ->
            observeServerTime(response)
            if (response.isSuccessful) {
                CoreHttpResult.Success(response.body.bytes())
            } else {
                CoreHttpResult.Failure(response.code, parseErrorEnvelope(response.body.string()))
            }
        }
    }

    suspend fun putExtensionPackage(
        accessToken: String,
        kind: String,
        packageId: String,
        version: String,
        bytes: ByteArray,
        mimeType: String,
        sha256: String? = null,
    ): CoreHttpResult<V4ExtensionPackageMeta> {
        val url = extensionPackageUrl(kind, packageId, version)
        val req = protectedBuilder(url, accessToken)
            .apply { if (!sha256.isNullOrBlank()) header("X-Epigraph-Asset-Sha256", sha256) }
            .put(bytes.toRequestBody(mimeType.toMediaType()))
            .build()
        return executeJson(req)
    }

    private fun extensionPackageUrl(kind: String, packageId: String, version: String): HttpUrl =
        baseUrl.newBuilder()
            .addPathSegment("v4")
            .addPathSegment("extensions")
            .addPathSegment("packages")
            .addPathSegment(kind)
            .addPathSegment(packageId)
            .addPathSegment(version)
            .build()

    private fun endpoint(path: String): HttpUrl =
        baseUrl.newBuilder().addPathSegments(path).build()

    private fun protectedBuilder(url: HttpUrl, accessToken: String): Request.Builder =
        Request.Builder()
            .url(url)
            .header("Authorization", "Bearer $accessToken")
            .header("X-Epigraph-Client-Version", clientVersion)
            .header("X-Epigraph-Client-Protocol-Version", "4")

    private suspend inline fun <reified T> executeJson(request: Request): CoreHttpResult<T> =
        client.newCall(request).await().use { response ->
            observeServerTime(response)
            val bodyText = response.body.string()
            if (response.isSuccessful) {
                CoreHttpResult.Success(
                    value = json.decodeFromString<T>(bodyText),
                    etag = response.header("ETag"),
                )
            } else {
                CoreHttpResult.Failure(response.code, parseErrorEnvelope(bodyText))
            }
        }

    private fun observeServerTime(response: okhttp3.Response) {
        val serverTime = response.header("X-Epigraph-Server-Time-Ms")?.toLongOrNull() ?: return
        hlcClock?.calibrateServerTime(serverTime)
    }

    private fun parseErrorEnvelope(raw: String): CoreErrorEnvelope? =
        runCatching { json.decodeFromString<CoreErrorEnvelope>(raw) }.getOrNull()

    private fun gzipBytes(input: ByteArray): ByteArray {
        val sink = Buffer()
        GzipSink(sink).buffer().use { gz ->
            gz.write(input)
        }
        return sink.readByteArray()
    }

    companion object {
        private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val DEFAULT_JSON: Json = Json {
            ignoreUnknownKeys = true
            explicitNulls = false
            encodeDefaults = true
        }
    }
}
