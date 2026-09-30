package epigraph.sync.core.http

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreChangesResponse
import epigraph.sync.core.protocol.CoreErrorEnvelope
import epigraph.sync.core.protocol.CoreErrorDetail
import epigraph.sync.core.protocol.CoreExtensionInventory
import epigraph.sync.core.protocol.CorePortableManifest
import epigraph.sync.core.protocol.CorePortableNovelManifest
import epigraph.sync.core.protocol.CoreMutationsRequest
import epigraph.sync.core.protocol.CoreMutationsResponse
import epigraph.sync.core.protocol.CoreSnapshot
import epigraph.sync.core.protocol.CoreSessionResponse
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.protocol.SuwayomiGraphqlRequest
import epigraph.sync.core.protocol.SuwayomiGraphqlResponse
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCommandRequest
import epigraph.sync.core.protocol.SuwayomiCommandResponse
import epigraph.sync.core.protocol.SuwayomiContentRequest
import epigraph.sync.core.protocol.SuwayomiContentResponse
import eu.kanade.tachiyomi.network.await
import java.net.URI
import kotlinx.serialization.json.Json
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.EventListener
import okhttp3.HttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import okio.Buffer

/**
 * Result of an HTTP exchange with epigraph-syncd.
 *
 * A HTTP 200 mutation response remains [Success] even when individual mutation results are
 * rejected. Callers must inspect [CoreMutationsResponse.results] and acknowledge only entries
 * whose status is `applied`.
 */
sealed interface CoreHttpResult<out T> {
    data class Success<T>(val value: T) : CoreHttpResult<T>

    data class Failure(
        val statusCode: Int,
        val errorEnvelope: CoreErrorEnvelope?,
    ) : CoreHttpResult<Nothing> {
        val isReplayWindowExpired: Boolean
            get() = errorEnvelope?.error?.code == "REPLAY_WINDOW_EXPIRED"

        val isRangeNotSatisfiable: Boolean
            get() = statusCode == 416
    }
}

/**
 * Small authenticated client for the stable JSON portion of the epigraph-syncd v1 API.
 *
 * TLS pinning and OkHttp policy are configured by the caller. This class accepts only an HTTPS
 * origin, adds the exact syncd negotiation headers, and receives the bearer token per protected
 * call so it cannot retain or persist credentials.
 */
class EpigraphCoreHttpClient internal constructor(
    client: OkHttpClient,
    private val baseUrl: HttpUrl,
    private val clientVersion: String,
    private val json: Json,
    preserveInterceptorsForTests: Boolean,
    private val maxJsonResponseBytes: Long = DEFAULT_MAX_JSON_RESPONSE_BYTES,
) {
    constructor(
        client: OkHttpClient,
        baseUrl: HttpUrl,
        clientVersion: String,
        json: Json = DEFAULT_JSON,
    ) : this(client, baseUrl, clientVersion, json, false)

    // Never forward pairing tokens to a redirected origin.
    private val client = client.newBuilder()
        .apply {
            if (!preserveInterceptorsForTests) {
                // Protected calls carry the bearer token and may return private library data.
                // Chucker/application loggers from the manga network stack are never inherited.
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
        .build()

    init {
        require(baseUrl.isHttps) { "Epigraph Core base URL must use HTTPS" }
        require(baseUrl.username.isEmpty() && baseUrl.password.isEmpty()) {
            "Epigraph Core base URL must not contain credentials"
        }
        require(baseUrl.encodedPath == "/" && baseUrl.query == null && baseUrl.fragment == null) {
            "Epigraph Core base URL must be an origin without path, query, or fragment"
        }
        require(clientVersion.isNotBlank() && clientVersion == clientVersion.trim()) {
            "clientVersion must be non-blank and canonical"
        }
        require(maxJsonResponseBytes > 0) { "maxJsonResponseBytes must be positive" }
    }

    suspend fun capabilities(): CoreHttpResult<CoreCapabilities> =
        execute(
            requestBuilder("v1/capabilities")
                .get()
                .build(),
        )

    suspend fun session(accessToken: String): CoreHttpResult<CoreSessionResponse> =
        execute(
            protectedRequestBuilder(endpoint("v1/session"), accessToken)
                .get()
                .build(),
        )

    suspend fun snapshot(
        accessToken: String,
        scopeId: String,
    ): CoreHttpResult<CoreSnapshot> {
        require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        val url = endpoint("v1/snapshot")
            .newBuilder()
            .addQueryParameter("scopeId", scopeId)
            .build()
        return execute(
            protectedRequestBuilder(url, accessToken)
                .get()
                .build(),
        )
    }

    suspend fun changes(
        accessToken: String,
        sinceVersion: Long,
        scopeId: String? = null,
    ): CoreHttpResult<CoreChangesResponse> {
        require(sinceVersion >= 0) { "sinceVersion must not be negative" }
        require(scopeId == null || scopeId.isNotBlank()) { "scopeId must not be blank" }
        val urlBuilder = endpoint("v1/changes")
            .newBuilder()
            .addQueryParameter("sinceVersion", sinceVersion.toString())
        scopeId?.let { urlBuilder.addQueryParameter("scopeId", it) }
        return execute(
            protectedRequestBuilder(urlBuilder.build(), accessToken)
                .get()
                .build(),
        )
    }

    suspend fun syncStatus(
        accessToken: String,
        scopeId: String,
    ): CoreHttpResult<CoreSyncStatus> {
        require(scopeId.isNotBlank()) { "scopeId must not be blank" }
        val url = endpoint("v1/sync/status")
            .newBuilder()
            .addQueryParameter("scopeId", scopeId)
            .build()
        return execute(
            protectedRequestBuilder(url, accessToken)
                .get()
                .build(),
        )
    }

    suspend fun mutations(
        accessToken: String,
        request: CoreMutationsRequest,
    ): CoreHttpResult<CoreMutationsResponse> {
        require(request.requestId.isNotBlank()) { "requestId must not be blank" }
        require(request.mutations.isNotEmpty()) { "mutations must not be empty" }
        val body = json.encodeToString(CoreMutationsRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        return execute(
            protectedRequestBuilder(endpoint("v1/mutations"), accessToken)
                .post(body)
                .build(),
        )
    }

    /**
     * Sends an official Suwayomi GraphQL document through the authenticated Core proxy.
     *
     * Comics remain owned by the hosted Suwayomi profile. This method deliberately does not
     * expose a configurable upstream URL: the profile-scoped route is the only supported path.
     */
    suspend fun suwayomiGraphql(
        accessToken: String,
        profileId: String,
        request: SuwayomiGraphqlRequest,
    ): CoreHttpResult<SuwayomiGraphqlResponse> {
        val canonicalProfileId = canonicalProfileId(profileId)
        val url = endpoint("v1/suwayomi/api/graphql")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        val body = json.encodeToString(SuwayomiGraphqlRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .header("Content-Type", JSON_MEDIA_TYPE.toString())
                .post(body)
                .build(),
        )
    }

    /** Sends an allowlisted comics write to the desktop Core command boundary. */
    suspend fun suwayomiCommand(
        accessToken: String,
        profileId: String,
        request: SuwayomiCommandRequest,
    ): CoreHttpResult<SuwayomiCommandResponse> {
        val canonicalProfileId = canonicalProfileId(profileId)
        val url = endpoint("v1/suwayomi/commands")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        val body = json.encodeToString(SuwayomiCommandRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .header("Content-Type", JSON_MEDIA_TYPE.toString())
                .post(body)
                .build(),
        )
    }

    /** Executes one allowlisted source read through the Core content boundary. */
    suspend fun suwayomiContent(
        accessToken: String,
        profileId: String,
        request: SuwayomiContentRequest,
    ): CoreHttpResult<SuwayomiContentResponse> {
        val canonicalProfileId = canonicalProfileId(profileId)
        val url = endpoint("v1/suwayomi/content")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        val body = json.encodeToString(SuwayomiContentRequest.serializer(), request)
            .toRequestBody(JSON_MEDIA_TYPE)
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .header("Content-Type", JSON_MEDIA_TYPE.toString())
                .post(body)
                .build(),
        )
    }

    suspend fun suwayomiCatalog(
        accessToken: String,
        profileId: String,
        operation: SuwayomiCatalogOperation,
        pageSize: Long = DEFAULT_CATALOG_PAGE_SIZE,
        offset: Long = 0,
        mangaId: Long? = null,
    ): CoreHttpResult<SuwayomiCatalogResponse> {
        val canonicalProfileId = canonicalProfileId(profileId)
        require(pageSize in 1..MAX_CATALOG_PAGE_SIZE) {
            "pageSize must be between 1 and $MAX_CATALOG_PAGE_SIZE"
        }
        require(offset >= 0 && offset <= Int.MAX_VALUE) {
            "offset must be a non-negative Suwayomi integer"
        }
        when (operation) {
            SuwayomiCatalogOperation.CHAPTERS -> require(
                mangaId != null && mangaId > 0 && mangaId <= Int.MAX_VALUE,
            ) {
                "mangaId is required for the chapters operation"
            }
            SuwayomiCatalogOperation.LIBRARY,
            SuwayomiCatalogOperation.CATEGORIES,
            -> require(mangaId == null) {
                "mangaId is only valid for the chapters operation"
            }
        }
        val urlBuilder = endpoint("v1/suwayomi/catalog")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .addQueryParameter("operation", operation.wireName)
            .addQueryParameter("pageSize", pageSize.toString())
            .addQueryParameter("offset", offset.toString())
        mangaId?.let { urlBuilder.addQueryParameter("mangaId", it.toString()) }
        return execute(
            protectedRequestBuilder(urlBuilder.build(), accessToken)
                .get()
                .header("Accept", "application/json")
                .build(),
        )
    }

    suspend fun suwayomiThumbnail(
        accessToken: String,
        profileId: String,
        mangaId: Long,
    ): CoreHttpResult<ByteArray> {
        val canonicalProfileId = canonicalProfileId(profileId)
        require(mangaId > 0 && mangaId <= Int.MAX_VALUE) {
            "mangaId must be a positive Suwayomi integer"
        }
        val url = endpoint("v1/suwayomi/api/v1/manga/$mangaId/thumbnail")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        return executeBytes(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "image/*")
                .build(),
        )
    }

    /** Opens a Suwayomi-owned resource through the authenticated Core proxy. */
    suspend fun suwayomiResource(
        accessToken: String,
        profileId: String,
        upstreamPath: String,
    ): CoreHttpResult<okhttp3.Response> {
        val canonicalProfileId = canonicalProfileId(profileId)
        val uri = runCatching { URI(upstreamPath) }.getOrElse {
            throw IllegalArgumentException("Suwayomi resource path is invalid", it)
        }
        require(!uri.isAbsolute && uri.host == null && uri.fragment == null) {
            "Suwayomi resource must be a relative path"
        }
        val rawPath = requireNotNull(uri.rawPath).takeIf { it.startsWith('/') }
            ?: throw IllegalArgumentException("Suwayomi resource path must be rooted")
        require(rawPath.length <= 8_192 && !rawPath.contains('\\')) {
            "Suwayomi resource path is invalid"
        }
        require(rawPath.split('/').none { it == "." || it == ".." }) {
            "Suwayomi resource path contains an unsafe segment"
        }
        val url = baseUrl.newBuilder()
            .addPathSegments("v1/suwayomi")
            .addEncodedPathSegments(rawPath.trimStart('/'))
            .encodedQuery(uri.rawQuery)
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        val response = client.newCall(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "image/*")
                .get()
                .build(),
        ).await()
        if (response.isSuccessful) return CoreHttpResult.Success(response)

        return response.use {
            CoreHttpResult.Failure(
                statusCode = it.code,
                errorEnvelope = readUtf8Bounded(it.body, MAX_ERROR_RESPONSE_BYTES)?.let { body ->
                    runCatching { json.decodeFromString<CoreErrorEnvelope>(body) }.getOrNull()
                },
            )
        }
    }

    suspend fun suwayomiExtensions(
        accessToken: String,
        profileId: String,
    ): CoreHttpResult<CoreExtensionInventory> {
        val canonicalProfileId = canonicalProfileId(profileId)
        val url = endpoint("v1/suwayomi/extensions")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .build()
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .get()
                .build(),
        )
    }

    suspend fun portableManifest(
        accessToken: String,
        profileId: String,
        pageSize: Long = DEFAULT_CATALOG_PAGE_SIZE,
        offset: Long = 0,
        snapshotId: String? = null,
        snapshotFingerprint: String? = null,
    ): CoreHttpResult<CorePortableManifest> {
        val canonicalProfileId = canonicalProfileId(profileId)
        require(pageSize in 1..MAX_CATALOG_PAGE_SIZE) {
            "pageSize must be between 1 and $MAX_CATALOG_PAGE_SIZE"
        }
        require(offset in 0..Int.MAX_VALUE.toLong()) {
            "offset must be a non-negative Suwayomi integer"
        }
        require((snapshotId == null) == (snapshotFingerprint == null)) {
            "snapshot ID and fingerprint must be supplied together"
        }
        val urlBuilder = endpoint("v1/portable/manifest")
            .newBuilder()
            .addQueryParameter("scopeId", "comics:profile:$canonicalProfileId")
            .addQueryParameter("pageSize", pageSize.toString())
            .addQueryParameter("offset", offset.toString())
        snapshotId?.let { urlBuilder.addQueryParameter("snapshotId", it) }
        snapshotFingerprint?.let { urlBuilder.addQueryParameter("snapshotFingerprint", it) }
        val url = urlBuilder.build()
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .get()
                .build(),
        )
    }

    suspend fun portableNovelManifest(
        accessToken: String,
        profileId: String,
        pageSize: Long = DEFAULT_CATALOG_PAGE_SIZE,
        offset: Long = 0,
        snapshotId: String? = null,
        snapshotFingerprint: String? = null,
    ): CoreHttpResult<CorePortableNovelManifest> {
        val canonicalProfileId = canonicalProfileId(profileId)
        require(pageSize in 1..MAX_CATALOG_PAGE_SIZE) {
            "pageSize must be between 1 and $MAX_CATALOG_PAGE_SIZE"
        }
        require(offset in 0..Int.MAX_VALUE.toLong()) {
            "offset must be a non-negative integer"
        }
        require((snapshotId == null) == (snapshotFingerprint == null)) {
            "snapshot ID and fingerprint must be supplied together"
        }
        val urlBuilder = endpoint("v1/portable/novel-manifest")
            .newBuilder()
            .addQueryParameter("scopeId", "novels:profile:$canonicalProfileId")
            .addQueryParameter("pageSize", pageSize.toString())
            .addQueryParameter("offset", offset.toString())
        snapshotId?.let { urlBuilder.addQueryParameter("snapshotId", it) }
        snapshotFingerprint?.let { urlBuilder.addQueryParameter("snapshotFingerprint", it) }
        val url = urlBuilder.build()
        return execute(
            protectedRequestBuilder(url, accessToken)
                .header("Accept", "application/json")
                .get()
                .build(),
        )
    }

    private suspend inline fun <reified T> execute(request: Request): CoreHttpResult<T> {
        return client.newCall(request).await().use { response ->
            val responseBody = readUtf8Bounded(response.body, maxJsonResponseBytes)
                ?: return@use CoreHttpResult.Failure(413, null)
            if (response.isSuccessful) {
                runCatching { json.decodeFromString<T>(responseBody) }
                    .fold(
                        onSuccess = { CoreHttpResult.Success(it) },
                        onFailure = {
                            CoreHttpResult.Failure(
                                statusCode = 422,
                                errorEnvelope = CoreErrorEnvelope(
                                    CoreErrorDetail(
                                        code = CLIENT_RESPONSE_UNSUPPORTED,
                                        message = "The Core response schema is not supported by this client.",
                                        retryable = false,
                                    ),
                                ),
                            )
                        },
                    )
            } else {
                CoreHttpResult.Failure(
                    statusCode = response.code,
                    errorEnvelope = runCatching {
                        json.decodeFromString<CoreErrorEnvelope>(responseBody)
                    }.getOrNull(),
                )
            }
        }
    }

    private suspend fun executeBytes(request: Request): CoreHttpResult<ByteArray> {
        return client.newCall(request).await().use { response ->
            if (response.isSuccessful) {
                val body = response.body
                val buffer = Buffer()
                body.source().use { source ->
                    while (buffer.size <= MAX_THUMBNAIL_BYTES) {
                        val read = source.read(
                            buffer,
                            minOf(8_192L, MAX_THUMBNAIL_BYTES + 1L - buffer.size),
                        )
                        if (read == -1L) break
                    }
                }
                if (buffer.size > MAX_THUMBNAIL_BYTES) {
                    CoreHttpResult.Failure(413, null)
                } else {
                    CoreHttpResult.Success(buffer.readByteArray())
                }
            } else {
                val responseBody = readUtf8Bounded(response.body, MAX_ERROR_RESPONSE_BYTES)
                CoreHttpResult.Failure(
                    statusCode = response.code,
                    errorEnvelope = responseBody?.let { body ->
                        runCatching { json.decodeFromString<CoreErrorEnvelope>(body) }.getOrNull()
                    },
                )
            }
        }
    }

    private fun readUtf8Bounded(body: ResponseBody, maxBytes: Long): String? {
        val declaredLength = body.contentLength()
        if (declaredLength > maxBytes) return null
        val buffer = Buffer()
        body.source().use { source ->
            while (buffer.size <= maxBytes) {
                val read = source.read(buffer, minOf(8_192L, maxBytes + 1L - buffer.size))
                if (read == -1L) break
            }
        }
        return if (buffer.size > maxBytes) null else buffer.readUtf8()
    }

    private fun requestBuilder(path: String): Request.Builder = requestBuilder(endpoint(path))

    private fun requestBuilder(url: HttpUrl): Request.Builder = Request.Builder()
        .url(url)
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

    private fun protectedRequestBuilder(url: HttpUrl, accessToken: String): Request.Builder {
        require(accessToken.isNotBlank() && accessToken == accessToken.trim()) {
            "accessToken must be non-blank and canonical"
        }
        return requestBuilder(url)
            .header(EpigraphCoreWireProtocol.AUTHORIZATION_HEADER, "Bearer $accessToken")
    }

    private fun endpoint(path: String): HttpUrl = baseUrl.newBuilder()
        .addPathSegments(path)
        .build()

    private fun canonicalProfileId(value: String): String {
        require(value.isNotBlank() && value == value.trim()) {
            "profileId must be non-blank and canonical"
        }
        require(value.length <= 128 && value.none(Char::isISOControl)) {
            "profileId is invalid"
        }
        return value
    }

    private companion object {
        const val CLIENT_RESPONSE_UNSUPPORTED = "CLIENT_RESPONSE_UNSUPPORTED"
        const val DEFAULT_CATALOG_PAGE_SIZE = 100L
        const val MAX_CATALOG_PAGE_SIZE = 250L
        const val MAX_THUMBNAIL_BYTES = 16 * 1024 * 1024
        const val DEFAULT_MAX_JSON_RESPONSE_BYTES = 16L * 1024L * 1024L
        const val MAX_ERROR_RESPONSE_BYTES = 64L * 1024L
        val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()
        val DEFAULT_JSON = Json {
            // syncd evolves capabilities and records additively within a wire protocol version.
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
}
