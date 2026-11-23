package epigraph.library

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit
import java.util.zip.CRC32
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.ResponseBody
import okio.ByteString.Companion.decodeBase64
import okio.ByteString.Companion.toByteString

/**
 * Shared library import link codec (`epigraph-share-v1`), mirroring
 * `src/lib/library/shareLink.ts` and `src-tauri/src/library_share.rs` in Epigraph Desktop.
 */
data class ShareManifestSource(
    val sourceId: Long,
    val name: String,
    val lang: String? = null,
    val pkgName: String? = null,
    val repoUrl: String? = null,
)

data class ShareManifestWork(
    /** `null` when the work is local and cannot be imported remotely. */
    val sourceId: Long?,
    /** Source-relative manga URL (e.g. `/manga/solo-leveling`), empty for local works. */
    val url: String,
    val title: String,
    val webUrl: String? = null,
    val coverUrl: String? = null,
    val kind: String? = null,
)

data class ShareManifest(
    val version: Int = 1,
    val sources: List<ShareManifestSource>,
    val works: List<ShareManifestWork>,
)

sealed interface ShareLinkToken {
    val token: String

    data class Inline(override val token: String) : ShareLinkToken
    data class Hosted(
        override val token: String,
        val host: String,
        val url: String,
    ) : ShareLinkToken
}

object LibraryShareLink {
    const val SHARE_PAGE_URL = "https://johnnylord1.github.io/Epigraph/share/"
    const val APP_SCHEME = "epigraph"
    const val APP_HOST = "import"
    const val PNG_CHUNK_KEYWORD = "epigraph-share"
    const val INLINE_TOKEN_PREFERRED_MAX = 800
    const val INLINE_TOKEN_HARD_MAX = 16384
    private const val MAX_DECOMPRESSED_BYTES = 1024 * 1024
    private const val MAX_MANIFEST_WORKS = 2000
    private const val MAX_MANIFEST_SOURCES = 500
    private const val MAX_PNG_BYTES = 16 * 1024 * 1024
    private const val MAX_REPLY_BYTES = 16 * 1024
    private const val FREEIMAGE_PUBLIC_API_KEY = "6d207e02198a847aa98d0a2a901485a5"

    private val pngSignature = byteArrayOf(0x89.toByte(), 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    private val whitespace = Regex("\\s+")
    private val inlineTokenRegex = Regex("^d\\.([A-Za-z0-9_-]{8,16384})$")
    private val embeddedTokenRegex = Regex("^d\\.([A-Za-z0-9_-]{8,1400000})$")
    private val simpleHostTokenRegex = Regex("^([lcikpa])\\.([A-Za-z0-9_-]{1,64})$")
    private val uguuHostTokenRegex = Regex("^u\\.([A-Za-z0-9]{1,16})\\.([A-Za-z0-9_-]{1,64})$")
    private val pngRootPathRegex = Regex("^/([A-Za-z0-9_-]{1,64})\\.png$")
    private val pomfPathRegex = Regex("^/f/([A-Za-z0-9_-]{1,64})\\.png$")
    private val safeSubdomainRegex = Regex("^[A-Za-z0-9]{1,16}$")

    private val json = Json { ignoreUnknownKeys = true }

    fun sanitizePublicRepoUrl(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        return try {
            val uri = URI(value)
            if (!uri.scheme.equals("https", ignoreCase = true)) return null
            if (!uri.userInfo.isNullOrEmpty()) return null
            val host = uri.host?.lowercase().orEmpty()
            if (
                host.isEmpty() ||
                host == "localhost" ||
                host == "0.0.0.0" ||
                host.endsWith(".local") ||
                host.startsWith("127.") ||
                host.startsWith("10.") ||
                host.startsWith("192.168.") ||
                host == "::1" ||
                host.startsWith("[") ||
                Regex("^172\\.(1[6-9]|2\\d|3[01])\\.").containsMatchIn(host)
            ) {
                return null
            }
            uri.toASCIIString()
        } catch (_: Exception) {
            null
        }
    }

    fun formatRepoLabel(repoUrl: String?): String? {
        val safe = sanitizePublicRepoUrl(repoUrl) ?: return null
        return try {
            val uri = URI(safe)
            when (uri.host?.lowercase()) {
                "raw.githubusercontent.com", "github.com" ->
                    uri.path.orEmpty().split('/').firstOrNull { it.isNotBlank() } ?: uri.host
                else -> uri.host?.removePrefix("www.")
            }
        } catch (_: Exception) {
            null
        }
    }

    fun sanitizePublicWebUrl(raw: String?): String? {
        val value = raw?.trim().orEmpty()
        if (value.isEmpty()) return null
        return try {
            val uri = URI(value)
            val scheme = uri.scheme?.lowercase()
            if (scheme != "http" && scheme != "https") return null
            if (!uri.userInfo.isNullOrEmpty()) return null
            if (uri.host.isNullOrBlank()) return null
            uri.toASCIIString()
        } catch (_: Exception) {
            null
        }
    }

    private fun cleanText(value: String?, maxLen: Int): String =
        value.orEmpty().replace(whitespace, " ").trim().take(maxLen)

    private fun normalizeKind(raw: String?): String? = when (raw?.trim()?.lowercase()) {
        "b", "book" -> "book"
        "c", "comic" -> "comic"
        else -> null
    }

    data class WorkInput(
        val title: String,
        val sourceId: Long?,
        val url: String?,
        val sourceName: String? = null,
        val sourceLang: String? = null,
        val pkgName: String? = null,
        val repoUrl: String? = null,
        val webUrl: String? = null,
        val coverUrl: String? = null,
        val kind: String? = null,
    )

    fun buildManifest(inputs: List<WorkInput>): ShareManifest {
        val sources = mutableListOf<ShareManifestSource>()
        val sourceIndexById = mutableMapOf<Long, Int>()
        val works = mutableListOf<ShareManifestWork>()

        for (input in inputs.take(MAX_MANIFEST_WORKS)) {
            val title = cleanText(input.title, 300)
            if (title.isEmpty()) continue
            val sourceId = input.sourceId
            val url = input.url?.trim().orEmpty().take(1024)
            val isRemote = sourceId != null && sourceId != 0L && url.isNotEmpty()
            val webUrl = sanitizePublicWebUrl(input.webUrl)
            val coverUrl = sanitizePublicRepoUrl(input.coverUrl)
            val kind = normalizeKind(input.kind)
            if (isRemote) {
                val existingIndex = sourceIndexById[sourceId]
                if (existingIndex == null) {
                    if (sources.size < MAX_MANIFEST_SOURCES) {
                        sourceIndexById[sourceId] = sources.size
                        sources += ShareManifestSource(
                            sourceId = sourceId,
                            name = cleanText(input.sourceName, 120).ifEmpty { "Source $sourceId" },
                            lang = cleanText(input.sourceLang, 16).ifEmpty { null },
                            pkgName = cleanText(input.pkgName, 160).ifEmpty { null },
                            repoUrl = sanitizePublicRepoUrl(input.repoUrl),
                        )
                    }
                } else {
                    val cur = sources[existingIndex]
                    val nextPkg = cur.pkgName ?: cleanText(input.pkgName, 160).ifEmpty { null }
                    val nextRepo = cur.repoUrl ?: sanitizePublicRepoUrl(input.repoUrl)
                    if (nextPkg != cur.pkgName || nextRepo != cur.repoUrl) {
                        sources[existingIndex] = cur.copy(pkgName = nextPkg, repoUrl = nextRepo)
                    }
                }
                works += ShareManifestWork(sourceId = sourceId, url = url, title = title, webUrl = webUrl, coverUrl = coverUrl, kind = kind)
            } else {
                works += ShareManifestWork(sourceId = null, url = "", title = title, webUrl = webUrl, coverUrl = coverUrl, kind = kind)
            }
        }

        return ShareManifest(version = 1, sources = sources, works = works)
    }

    fun encodeManifest(manifest: ShareManifest): String {
        val sourceIndex = mutableMapOf<Long, Int>()
        val wireSources = buildJsonArray {
            manifest.sources.take(MAX_MANIFEST_SOURCES).forEachIndexed { index, source ->
                sourceIndex[source.sourceId] = index
                val lang = source.lang?.trim()?.ifEmpty { null }
                val pkg = source.pkgName?.trim()?.ifEmpty { null }
                val repo = sanitizePublicRepoUrl(source.repoUrl)
                add(
                    buildJsonArray {
                        add(JsonPrimitive(source.sourceId.toString()))
                        add(JsonPrimitive(source.name))
                        if (lang != null || pkg != null || repo != null) {
                            add(lang?.let(::JsonPrimitive) ?: JsonNull)
                        }
                        if (pkg != null || repo != null) {
                            add(pkg?.let(::JsonPrimitive) ?: JsonNull)
                        }
                        if (repo != null) {
                            add(JsonPrimitive(repo))
                        }
                    },
                )
            }
        }
        val wireWorks = buildJsonArray {
            manifest.works.take(MAX_MANIFEST_WORKS).forEach { work ->
                val idx = if (work.sourceId != null && work.url.isNotEmpty()) {
                    sourceIndex[work.sourceId] ?: -1
                } else {
                    -1
                }
                val webUrl = sanitizePublicWebUrl(work.webUrl)
                val coverUrl = sanitizePublicRepoUrl(work.coverUrl)
                val wireKind = when (normalizeKind(work.kind)) {
                    "book" -> "b"
                    "comic" -> "c"
                    else -> null
                }
                add(
                    buildJsonArray {
                        add(JsonPrimitive(idx))
                        add(JsonPrimitive(if (idx >= 0) work.url else ""))
                        add(JsonPrimitive(work.title))
                        if (webUrl != null || coverUrl != null || wireKind != null) {
                            add(webUrl?.let(::JsonPrimitive) ?: JsonNull)
                        }
                        if (coverUrl != null || wireKind != null) {
                            add(coverUrl?.let(::JsonPrimitive) ?: JsonNull)
                        }
                        if (wireKind != null) {
                            add(JsonPrimitive(wireKind))
                        }
                    },
                )
            }
        }
        val payload = buildJsonObject {
            put("v", JsonPrimitive(1))
            put("s", wireSources)
            put("w", wireWorks)
        }.toString()

        val compressed = ByteArrayOutputStream().use { out ->
            GZIPOutputStream(out).use { gzip ->
                gzip.write(payload.toByteArray(StandardCharsets.UTF_8))
            }
            out.toByteArray()
        }
        val encoded = compressed.toByteString().base64Url().trimEnd('=')
        return "d.$encoded"
    }

    fun decodeManifest(token: String): ShareManifest? {
        val match = embeddedTokenRegex.matchEntire(token.trim()) ?: return null
        val b64 = match.groupValues[1]
        val padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4)
        val compressed = padded.replace('-', '+').replace('_', '/').decodeBase64()?.toByteArray() ?: return null
        if (compressed.isEmpty()) return null

        val inflated = try {
            GZIPInputStream(ByteArrayInputStream(compressed)).use { gzip ->
                val out = ByteArrayOutputStream()
                val buf = ByteArray(8192)
                var total = 0
                while (true) {
                    val read = gzip.read(buf)
                    if (read <= 0) break
                    total += read
                    if (total > MAX_DECOMPRESSED_BYTES) return null
                    out.write(buf, 0, read)
                }
                out.toString(StandardCharsets.UTF_8.name())
            }
        } catch (_: Exception) {
            return null
        }

        val root = try {
            json.parseToJsonElement(inflated) as? JsonObject
        } catch (_: Exception) {
            return null
        } ?: return null

        if (root["v"]?.jsonPrimitive?.intOrNull != 1) return null
        val rawSources = root["s"] as? JsonArray ?: return null
        val rawWorks = root["w"] as? JsonArray ?: return null

        val sources = mutableListOf<ShareManifestSource>()
        for (item in rawSources.take(MAX_MANIFEST_SOURCES)) {
            val arr = item as? JsonArray ?: return null
            val sourceId = arr.getOrNull(0)?.jsonPrimitive?.contentOrNull?.trim()?.toLongOrNull() ?: return null
            val name = cleanText(arr.getOrNull(1)?.jsonPrimitive?.contentOrNull, 120)
            if (name.isEmpty()) return null
            sources += ShareManifestSource(
                sourceId = sourceId,
                name = name,
                lang = cleanText(arr.getOrNull(2)?.jsonPrimitive?.contentOrNull, 16).ifEmpty { null },
                pkgName = cleanText(arr.getOrNull(3)?.jsonPrimitive?.contentOrNull, 160).ifEmpty { null },
                repoUrl = sanitizePublicRepoUrl(arr.getOrNull(4)?.jsonPrimitive?.contentOrNull),
            )
        }

        val works = mutableListOf<ShareManifestWork>()
        for (item in rawWorks.take(MAX_MANIFEST_WORKS)) {
            val arr = item as? JsonArray ?: return null
            val sourceIdx = arr.getOrNull(0)?.jsonPrimitive?.intOrNull ?: -1
            val url = arr.getOrNull(1)?.jsonPrimitive?.contentOrNull?.trim().orEmpty().take(1024)
            val title = cleanText(arr.getOrNull(2)?.jsonPrimitive?.contentOrNull, 300)
            if (title.isEmpty()) continue
            val webUrl = sanitizePublicWebUrl(arr.getOrNull(3)?.jsonPrimitive?.contentOrNull)
            val coverUrl = sanitizePublicRepoUrl(arr.getOrNull(4)?.jsonPrimitive?.contentOrNull)
            val kind = normalizeKind(arr.getOrNull(5)?.jsonPrimitive?.contentOrNull)
            if (sourceIdx in sources.indices && url.isNotEmpty()) {
                works += ShareManifestWork(sourceId = sources[sourceIdx].sourceId, url = url, title = title, webUrl = webUrl, coverUrl = coverUrl, kind = kind)
            } else {
                works += ShareManifestWork(sourceId = null, url = "", title = title, webUrl = webUrl, coverUrl = coverUrl, kind = kind)
            }
        }

        if (works.isEmpty()) return null
        return ShareManifest(version = 1, sources = sources, works = works)
    }

    fun hostedUrlToShareToken(rawUrl: String?): String? {
        if (rawUrl.isNullOrBlank()) return null
        return try {
            val uri = URI(rawUrl.trim())
            if (
                !uri.scheme.equals("https", ignoreCase = true) ||
                uri.port != -1 ||
                !uri.userInfo.isNullOrEmpty() ||
                !uri.query.isNullOrEmpty() ||
                !uri.fragment.isNullOrEmpty()
            ) {
                return null
            }
            val host = uri.host?.lowercase().orEmpty()
            if (host == "pomf2.lain.la") {
                val pomfMatch = pomfPathRegex.matchEntire(uri.path.orEmpty()) ?: return null
                return "p.${pomfMatch.groupValues[1]}"
            }
            val match = pngRootPathRegex.matchEntire(uri.path.orEmpty()) ?: return null
            val id = match.groupValues[1]
            when {
                host == "iili.io" -> "i.$id"
                host == "kappa.lol" -> "k.$id"
                host == "x0.at" -> "a.$id"
                host == "litter.catbox.moe" -> "l.$id"
                host == "files.catbox.moe" -> "c.$id"
                host.endsWith(".uguu.se") -> {
                    val sub = host.removeSuffix(".uguu.se")
                    if (safeSubdomainRegex.matches(sub)) "u.$sub.$id" else null
                }
                else -> null
            }
        } catch (_: Exception) {
            null
        }
    }

    fun shareTokenToHostedUrl(token: String): Pair<String, String>? {
        val trimmed = token.trim()
        simpleHostTokenRegex.matchEntire(trimmed)?.let { m ->
            val id = m.groupValues[2]
            return when (m.groupValues[1]) {
                "i" -> "freeimage" to "https://iili.io/$id.png"
                "k" -> "kappa" to "https://kappa.lol/$id.png"
                "p" -> "pomf2" to "https://pomf2.lain.la/f/$id.png"
                "a" -> "x0at" to "https://x0.at/$id.png"
                "l" -> "litterbox" to "https://litter.catbox.moe/$id.png"
                "c" -> "catbox" to "https://files.catbox.moe/$id.png"
                else -> null
            }
        }
        uguuHostTokenRegex.matchEntire(trimmed)?.let { m ->
            return "uguu" to "https://${m.groupValues[1]}.uguu.se/${m.groupValues[2]}.png"
        }
        return null
    }

    fun parseIncomingImportLink(raw: String?): ShareLinkToken? {
        val input = raw?.trim().orEmpty()
        if (input.isEmpty()) return null
        var token = input

        if (input.startsWith("$APP_SCHEME://", ignoreCase = true)) {
            val uri = runCatching { URI(input) }.getOrNull() ?: return null
            if (!uri.host.equals(APP_HOST, ignoreCase = true)) return null
            val queryToken = uri.rawQuery.orEmpty().split('&')
                .firstOrNull { it.startsWith("p=") }
                ?.substring(2)
                ?.let { runCatching { java.net.URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            token = (queryToken ?: uri.fragment.orEmpty().substringBefore('&')).trim()
        } else if (input.startsWith("https://", ignoreCase = true)) {
            val uri = runCatching { URI(input) }.getOrNull() ?: return null
            val expected = URI(SHARE_PAGE_URL)
            if (
                !uri.host.equals(expected.host, ignoreCase = true) ||
                !uri.path.orEmpty().startsWith(expected.path.orEmpty())
            ) {
                return null
            }
            val queryToken = uri.rawQuery.orEmpty().split('&')
                .firstOrNull { it.startsWith("p=") }
                ?.substring(2)
                ?.let { runCatching { java.net.URLDecoder.decode(it, "UTF-8") }.getOrNull() }
            token = (uri.fragment?.substringBefore('&')?.takeIf { it.isNotBlank() } ?: queryToken.orEmpty()).trim()
        } else {
            token = token.substringBefore('&').trim()
        }

        if (inlineTokenRegex.matches(token)) {
            return ShareLinkToken.Inline(token)
        }
        val hosted = shareTokenToHostedUrl(token)
        if (hosted != null) {
            return ShareLinkToken.Hosted(token = token, host = hosted.first, url = hosted.second)
        }
        return null
    }

    fun buildShareWebUrl(token: String, hostedImageUrl: String? = null, viewOnly: Boolean = false): String {
        val params = mutableListOf(token)
        val imgToken = if (token.startsWith("d.")) hostedUrlToShareToken(hostedImageUrl) else null
        if (imgToken != null) params += "img=$imgToken"
        if (viewOnly) params += "view=1"
        return "$SHARE_PAGE_URL#${params.joinToString("&")}"
    }

    fun chooseShareLinkToken(inlineToken: String?, hostedImageUrl: String? = null): String? {
        if (inlineToken == null || !embeddedTokenRegex.matches(inlineToken)) return null
        if (inlineToken.length <= INLINE_TOKEN_PREFERRED_MAX) return inlineToken
        hostedUrlToShareToken(hostedImageUrl)?.let { return it }
        if (inlineToken.length <= INLINE_TOKEN_HARD_MAX) return inlineToken
        return null
    }

    // ── PNG tEXt chunk embedding & reading ───────────────────────────────────

    private fun hasPngSignature(bytes: ByteArray): Boolean {
        if (bytes.size < 33) return false
        for (i in pngSignature.indices) {
            if (bytes[i] != pngSignature[i]) return false
        }
        return true
    }

    fun embedShareTokenInPng(pngBytes: ByteArray, inlineToken: String): ByteArray {
        if (!hasPngSignature(pngBytes) || !embeddedTokenRegex.matches(inlineToken)) return pngBytes
        val buf = ByteBuffer.wrap(pngBytes).order(ByteOrder.BIG_ENDIAN)
        var offset = 8
        var iendOffset = -1
        while (offset + 12 <= pngBytes.size) {
            val length = buf.getInt(offset)
            if (length < 0) return pngBytes
            val type = String(pngBytes, offset + 4, 4, StandardCharsets.US_ASCII)
            val next = offset + 12 + length
            if (next > pngBytes.size || next < offset) return pngBytes
            if (type == "IEND") {
                iendOffset = offset
                break
            }
            offset = next
        }
        if (iendOffset < 0) return pngBytes

        val typeBytes = "tEXt".toByteArray(StandardCharsets.US_ASCII)
        val keywordBytes = PNG_CHUNK_KEYWORD.toByteArray(StandardCharsets.US_ASCII)
        val valueBytes = inlineToken.toByteArray(StandardCharsets.US_ASCII)
        val data = ByteArray(keywordBytes.size + 1 + valueBytes.size)
        System.arraycopy(keywordBytes, 0, data, 0, keywordBytes.size)
        data[keywordBytes.size] = 0
        System.arraycopy(valueBytes, 0, data, keywordBytes.size + 1, valueBytes.size)

        val crc = CRC32().apply {
            update(typeBytes)
            update(data)
        }.value.toInt()

        val out = ByteArrayOutputStream(pngBytes.size + 12 + data.size)
        out.write(pngBytes, 0, iendOffset)
        out.write(ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(data.size).array())
        out.write(typeBytes)
        out.write(data)
        out.write(ByteBuffer.allocate(4).order(ByteOrder.BIG_ENDIAN).putInt(crc).array())
        out.write(pngBytes, iendOffset, pngBytes.size - iendOffset)
        return out.toByteArray()
    }

    fun extractShareTokenFromPng(pngBytes: ByteArray): String? {
        if (!hasPngSignature(pngBytes)) return null
        val buf = ByteBuffer.wrap(pngBytes).order(ByteOrder.BIG_ENDIAN)
        var offset = 8
        while (offset + 12 <= pngBytes.size) {
            val length = buf.getInt(offset)
            if (length < 0) return null
            val type = String(pngBytes, offset + 4, 4, StandardCharsets.US_ASCII)
            val dataStart = offset + 8
            val dataEnd = dataStart + length
            val next = dataEnd + 4
            if (next > pngBytes.size || next < offset) return null
            if (type == "tEXt") {
                var sep = -1
                for (i in dataStart until dataEnd) {
                    if (pngBytes[i] == 0.toByte()) {
                        sep = i
                        break
                    }
                }
                if (sep > dataStart) {
                    val keyword = String(pngBytes, dataStart, sep - dataStart, StandardCharsets.US_ASCII)
                    if (keyword == PNG_CHUNK_KEYWORD) {
                        val token = String(pngBytes, sep + 1, dataEnd - sep - 1, StandardCharsets.US_ASCII).trim()
                        return token.takeIf { embeddedTokenRegex.matches(it) }
                    }
                }
            }
            if (type == "IEND") break
            offset = next
        }
        return null
    }

    private fun shareHttpClient(): OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    /** Uploads a PNG card with fallback Freeimage -> Kappa -> Pomf2 -> X0At -> Uguu -> Catbox -> Litterbox. */
    suspend fun uploadCardPng(pngBytes: ByteArray): String? = withContext(Dispatchers.IO) {
        if (pngBytes.size > MAX_PNG_BYTES || !hasPngSignature(pngBytes)) return@withContext null
        val client = shareHttpClient()
        for (host in listOf("freeimage", "kappa", "pomf2", "x0at", "uguu", "catbox", "litterbox")) {
            val uploaded = runCatching { tryUploadToHost(client, host, pngBytes) }.getOrNull()
            if (uploaded != null) return@withContext uploaded
        }
        null
    }

    private fun tryUploadToHost(client: OkHttpClient, host: String, pngBytes: ByteArray): String? {
        val imageBody = pngBytes.toRequestBody("image/png".toMediaType())
        val (endpoint, form) = when (host) {
            "freeimage" -> "https://freeimage.host/api/1/upload" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("key", FREEIMAGE_PUBLIC_API_KEY)
                    .addFormDataPart("action", "upload")
                    .addFormDataPart("format", "json")
                    .addFormDataPart("source", "epigraph-library.png", imageBody)
                    .build()
            "kappa" -> "https://kappa.lol/api/upload" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("file", "epigraph-library.png", imageBody)
                    .build()
            "pomf2" -> "https://pomf2.lain.la/upload.php" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("files[]", "epigraph-library.png", imageBody)
                    .build()
            "x0at" -> "https://x0.at/" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("file", "epigraph-library.png", imageBody)
                    .build()
            "litterbox" -> "https://litterbox.catbox.moe/resources/internals/api.php" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("reqtype", "fileupload")
                    .addFormDataPart("time", "72h")
                    .addFormDataPart("fileToUpload", "epigraph-library.png", imageBody)
                    .build()
            "uguu" -> "https://uguu.se/upload" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("files[]", "epigraph-library.png", imageBody)
                    .build()
            else -> "https://catbox.moe/user/api.php" to
                MultipartBody.Builder().setType(MultipartBody.FORM)
                    .addFormDataPart("reqtype", "fileupload")
                    .addFormDataPart("fileToUpload", "epigraph-library.png", imageBody)
                    .build()
        }

        val req = Request.Builder()
            .url(endpoint)
            .header("User-Agent", "Epigraph/LibraryShare")
            .post(form)
            .build()
        val reply = client.newCall(req).execute().use { resp ->
            if (!resp.isSuccessful) return null
            val bodyBytes = readLimitedBody(resp.body, MAX_REPLY_BYTES) ?: return null
            bodyBytes.toString(StandardCharsets.UTF_8)
        }

        val candidateUrl = when (host) {
            "uguu", "pomf2" -> {
                val obj = runCatching { json.parseToJsonElement(reply).jsonObject }.getOrNull() ?: return null
                if (obj["success"]?.jsonPrimitive?.booleanOrNull != true) return null
                obj["files"]?.jsonArray?.firstOrNull()?.jsonObject?.get("url")?.jsonPrimitive?.contentOrNull
                    ?: return null
            }
            "kappa" -> {
                val obj = runCatching { json.parseToJsonElement(reply).jsonObject }.getOrNull() ?: return null
                val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return null
                val ext = obj["ext"]?.jsonPrimitive?.contentOrNull ?: return null
                if (ext != ".png") return null
                "https://kappa.lol/$id.png"
            }
            "freeimage" -> {
                val obj = runCatching { json.parseToJsonElement(reply).jsonObject }.getOrNull() ?: return null
                if (obj["status_code"]?.jsonPrimitive?.intOrNull != 200) return null
                val img = obj["image"]?.jsonObject ?: return null
                img["url"]?.jsonPrimitive?.contentOrNull ?: run {
                    val id = img["id_encoded"]?.jsonPrimitive?.contentOrNull ?: return null
                    val ext = img["extension_name"]?.jsonPrimitive?.contentOrNull ?: return null
                    if (ext != "png") return null
                    "https://iili.io/$id.png"
                }
            }
            else -> reply.trim()
        }
        // Validate against our allowlist via hostedUrlToShareToken.
        val token = hostedUrlToShareToken(candidateUrl) ?: return null
        val verifiedUrl = shareTokenToHostedUrl(token)?.second ?: return null
        val headReq = Request.Builder()
            .url(verifiedUrl)
            .header("User-Agent", "Epigraph/LibraryShare")
            .head()
            .build()
        return client.newCall(headReq).execute().use { resp ->
            val contentType = resp.header("Content-Type")?.substringBefore(';')?.trim()
            val contentLength = resp.header("Content-Length")?.trim()?.toLongOrNull()
            val nonEmpty = contentLength == null || contentLength > 0L
            if (resp.isSuccessful && contentType == "image/png" && nonEmpty) verifiedUrl else null
        }
    }

    /** Downloads a hosted share PNG from an allowlisted host and extracts its inline token. */
    suspend fun fetchHostedShareToken(token: ShareLinkToken.Hosted): String? = withContext(Dispatchers.IO) {
        val client = shareHttpClient()
        val req = Request.Builder()
            .url(token.url)
            .header("User-Agent", "Epigraph/LibraryShare")
            .get()
            .build()
        runCatching {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return@use null
                val contentType = resp.header("Content-Type")?.substringBefore(';')?.trim()
                if (contentType != "image/png") return@use null
                val bytes = readLimitedBody(resp.body, MAX_PNG_BYTES) ?: return@use null
                extractShareTokenFromPng(bytes)
            }
        }.getOrNull()
    }

    private fun readLimitedBody(body: ResponseBody, maxBytes: Int): ByteArray? {
        if (body.contentLength() > maxBytes) return null
        val source = body.source()
        return if (source.request(maxBytes.toLong() + 1)) null else source.readByteArray()
    }

    /** Resolves any incoming share link (`epigraph://import?...` or `https://.../share/#...`) into a manifest. */
    suspend fun resolveIncomingManifest(rawLink: String?): ShareManifest? {
        val parsed = parseIncomingImportLink(rawLink) ?: return null
        val inlineToken = when (parsed) {
            is ShareLinkToken.Inline -> parsed.token
            is ShareLinkToken.Hosted -> fetchHostedShareToken(parsed) ?: return null
        }
        return decodeManifest(inlineToken)
    }
}
