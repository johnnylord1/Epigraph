package epigraph.sync.core.assets

import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import java.io.Closeable
import java.io.InputStream
import java.net.URLEncoder
import java.nio.charset.StandardCharsets

/** Immutable SHA-256 identity used by the Epigraph Core asset store. */
@JvmInline
value class CoreAssetId private constructor(val value: String) {
    val etag: String get() = "\"$value\""

    companion object {
        fun parse(raw: String): CoreAssetId {
            require(raw.length == 64 && raw.all { it in '0'..'9' || it.lowercaseChar() in 'a'..'f' }) {
                "Asset SHA-256 must contain exactly 64 hexadecimal characters"
            }
            return CoreAssetId(raw.lowercase())
        }
    }
}

class CoreAssetSession(
    val bearerToken: String,
    val clientVersion: String,
    val protocolVersion: Int,
) {
    init {
        require(bearerToken.isNotBlank())
        require(clientVersion.isNotBlank())
        require(protocolVersion > 0)
    }

    override fun toString(): String =
        "CoreAssetSession(bearerToken=<redacted>, clientVersion=$clientVersion, protocolVersion=$protocolVersion)"
}

enum class CoreAssetMethod { HEAD, GET, PUT }

/**
 * Dependency-neutral HTTP request matching syncd's `/v1/assets/:sha256` routes.
 * The bearer token is ephemeral and this object must never be persisted or logged.
 */
data class CoreAssetHttpRequest(
    val method: CoreAssetMethod,
    val assetId: CoreAssetId,
    val scopeId: String,
    val session: CoreAssetSession,
    val rangeStart: Long? = null,
    val contentLength: Long? = null,
) {
    init {
        require(
            scopeId == "books:global" ||
                scopeId.removePrefix("novels:profile:").takeIf { it != scopeId }?.isNotBlank() == true ||
                scopeId.removePrefix("comics:profile:").takeIf { it != scopeId }?.isNotBlank() == true,
        )
        require(rangeStart == null || (method == CoreAssetMethod.GET && rangeStart >= 0))
        require(contentLength == null || (method == CoreAssetMethod.PUT && contentLength >= 0))
    }

    val pathAndQuery: String
        get() = "/v1/assets/${assetId.value}?scopeId=${encodeQuery(scopeId)}"

    fun headers(): Map<String, String> = buildMap {
        put("Authorization", "Bearer ${session.bearerToken}")
        put(EpigraphCoreWireProtocol.CLIENT_VERSION_HEADER, session.clientVersion)
        put(EpigraphCoreWireProtocol.CLIENT_PROTOCOL_HEADER, session.protocolVersion.toString())
        put(EpigraphCoreWireProtocol.LEGACY_CLIENT_VERSION_HEADER, session.clientVersion)
        put(EpigraphCoreWireProtocol.LEGACY_CLIENT_PROTOCOL_HEADER, session.protocolVersion.toString())
        rangeStart?.let { put("Range", "bytes=$it-") }
        contentLength?.let { put("Content-Length", it.toString()) }
    }

    private fun encodeQuery(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name()).replace("+", "%20")
}

/** A response body owned by the caller and always closed by the transfer engine. */
interface CoreAssetResponseBody : Closeable {
    fun read(buffer: ByteArray, offset: Int, length: Int): Int
}

class InputStreamAssetResponseBody(private val input: InputStream) : CoreAssetResponseBody {
    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = input.read(buffer, offset, length)
    override fun close() = input.close()
}

data class CoreAssetHttpResponse(
    val statusCode: Int,
    val headers: Map<String, String> = emptyMap(),
    val body: CoreAssetResponseBody? = null,
) : Closeable {
    fun header(name: String): String? = headers.entries.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value
    override fun close() = body?.close() ?: Unit
}

fun interface CoreAssetUploadBody {
    /** Returns a fresh stream; the HTTP adapter owns and closes it after the whole-body PUT. */
    fun openStream(): InputStream
}

/** Implement with the app's pinned-TLS Core client; tests can use an in-memory fake. */
interface CoreAssetHttpClient {
    suspend fun execute(request: CoreAssetHttpRequest, uploadBody: CoreAssetUploadBody? = null): CoreAssetHttpResponse
}
