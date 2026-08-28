package epigraph.sync.core.protocol

import epigraph.contract.ComicDependency
import epigraph.contract.NovelDependency
import epigraph.contract.PortableWorkRef
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** The only request shape accepted by the Core's Suwayomi GraphQL proxy. */
@Serializable
data class SuwayomiGraphqlRequest(
    val query: String,
    val variables: JsonObject = buildJsonObject { },
    val operationName: String? = null,
) {
    init {
        require(query.isNotBlank()) { "GraphQL query must not be blank" }
        require(query == query.trim()) { "GraphQL query must not have surrounding whitespace" }
        require(query.length <= MAX_QUERY_LENGTH) { "GraphQL query is too long" }
        operationName?.let {
            require(it.isNotBlank() && it == it.trim()) {
                "GraphQL operation name must be canonical"
            }
            require(it.length <= MAX_OPERATION_NAME_LENGTH) {
                "GraphQL operation name is too long"
            }
        }
    }

}

private const val MAX_QUERY_LENGTH = 1_000_000
private const val MAX_OPERATION_NAME_LENGTH = 256

/** Raw GraphQL envelope; field schemas remain owned by the installed Suwayomi version. */
@Serializable
data class SuwayomiGraphqlResponse(
    val data: JsonObject? = null,
    val errors: JsonArray? = null,
) {
    val hasErrors: Boolean
        get() = !errors.isNullOrEmpty()
}

/** A typed, allowlisted write owned by the desktop Core. */
@Serializable
enum class SuwayomiMutationOperation {
    @kotlinx.serialization.SerialName("UpdateManga")
    UPDATE_MANGA,

    @kotlinx.serialization.SerialName("UpdateMangaCategories")
    UPDATE_MANGA_CATEGORIES,

    @kotlinx.serialization.SerialName("UpdateChaptersProgress")
    UPDATE_CHAPTERS_PROGRESS,

    @kotlinx.serialization.SerialName("UpdateCategory")
    UPDATE_CATEGORY,

    @kotlinx.serialization.SerialName("DeleteCategory")
    DELETE_CATEGORY,

    @kotlinx.serialization.SerialName("UpdateCategoryOrder")
    UPDATE_CATEGORY_ORDER,
}

@Serializable
data class SuwayomiCommandRequest(
    val operation: SuwayomiMutationOperation,
    val variables: JsonObject,
)

@Serializable
data class SuwayomiCommandResponse(
    val schemaVersion: Int,
    val scopeId: String,
    val operation: SuwayomiMutationOperation,
    val appliedAtMs: Long,
    val data: JsonObject,
)

/** Fixed source reads whose upstream Suwayomi API is mutation-shaped. */
@Serializable
enum class SuwayomiContentOperation {
    @kotlinx.serialization.SerialName("FetchManga")
    FETCH_MANGA,

    @kotlinx.serialization.SerialName("FetchChapters")
    FETCH_CHAPTERS,

    @kotlinx.serialization.SerialName("FetchChapterPages")
    FETCH_CHAPTER_PAGES,
}

@Serializable
data class SuwayomiContentRequest(
    val operation: SuwayomiContentOperation,
    val id: Long,
) {
    init {
        require(id in 1..Int.MAX_VALUE.toLong()) { "content id must be a positive Suwayomi integer" }
    }
}

@Serializable
data class SuwayomiContentResponse(
    val schemaVersion: Int,
    val scopeId: String,
    val operation: SuwayomiContentOperation,
    val fetchedAtMs: Long,
    val data: JsonObject,
)

/** Fixed, read-only catalog operations exposed by the profile-scoped Core bridge. */
enum class SuwayomiCatalogOperation(val wireName: String) {
    LIBRARY("library"),
    CATEGORIES("categories"),
    CHAPTERS("chapters"),
}

@Serializable
data class SuwayomiCatalogPage(
    val offset: Long,
    val pageSize: Long,
    val hasNextPage: Boolean,
    val totalCount: Long? = null,
) {
    init {
        require(offset >= 0) { "catalog page offset must not be negative" }
        require(pageSize in 1L..250L) { "catalog page size is outside the Core limit" }
    }
}

@Serializable
data class SuwayomiCatalogResponse(
    val schemaVersion: Int,
    val scopeId: String,
    val operation: String,
    val generatedAtMs: Long,
    val page: SuwayomiCatalogPage,
    val data: JsonObject,
) {
    init {
        require(schemaVersion >= 1) { "unsupported catalog schema version" }
        require(scopeId.isNotBlank()) { "catalog scope must not be blank" }
        require(operation.isNotBlank()) { "catalog operation must not be blank" }
        require(generatedAtMs >= 0) { "catalog timestamp must not be negative" }
    }
}

/** Installed desktop extensions exposed by the authenticated, profile-scoped Core boundary. */
@Serializable
data class CoreExtensionInventory(
    val schemaVersion: Int,
    val serverId: String,
    val profileId: String,
    val runtimeFingerprint: String,
    val generatedAtMs: Long,
    val extensions: List<CoreExtensionDescriptor>,
) {
    init {
        require(schemaVersion >= 1) { "unsupported extension inventory schema version" }
        require(serverId.isNotBlank()) { "extension inventory serverId must not be blank" }
        require(profileId.isNotBlank()) { "extension inventory profileId must not be blank" }
        require(runtimeFingerprint.isNotBlank()) { "runtime fingerprint must not be blank" }
        require(generatedAtMs >= 0) { "extension inventory timestamp must not be negative" }
    }
}

@Serializable
data class CoreExtensionDescriptor(
    val packageName: String,
    val displayName: String,
    val versionCode: String,
    val versionName: String,
    val storeIndexUrl: String? = null,
    val legacyRepositoryIndexUrl: String? = null,
    val sources: List<CoreExtensionSource>,
) {
    init {
        require(packageName.isNotBlank() && packageName == packageName.trim()) {
            "extension packageName must be canonical"
        }
        require(displayName.isNotBlank()) { "extension displayName must not be blank" }
        require(versionCode.isNotBlank()) { "extension versionCode must not be blank" }
        require(versionName.isNotBlank()) { "extension versionName must not be blank" }
        require(storeIndexUrl == null || storeIndexUrl.startsWith("https://")) {
            "extension storeIndexUrl must use HTTPS"
        }
        require(legacyRepositoryIndexUrl == null || legacyRepositoryIndexUrl.startsWith("https://")) {
            "extension legacyRepositoryIndexUrl must use HTTPS"
        }
    }
}

@Serializable
data class CoreExtensionSource(
    @Serializable(with = CanonicalSourceIdSerializer::class)
    val id: String,
    val name: String,
    val lang: String,
) {
    init {
        require(id.toLongOrNull()?.let { it != 0L && it.toString() == id } == true) {
            "extension source id must be canonical signed-64-bit decimal"
        }
        require(name.isNotBlank()) { "extension source name must not be blank" }
        require(lang.isNotBlank()) { "extension source language must not be blank" }
    }
}

/** Reads Legacy numeric IDs but always writes the V3 lossless decimal string representation. */
object CanonicalSourceIdSerializer : KSerializer<String> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("CanonicalSourceId", PrimitiveKind.STRING)

    override fun deserialize(decoder: Decoder): String {
        val value = if (decoder is JsonDecoder) {
            decoder.decodeJsonElement().jsonPrimitive.content
        } else {
            decoder.decodeString()
        }
        require(value.toLongOrNull()?.let { it != 0L && it.toString() == value } == true) {
            "extension source id must be canonical signed-64-bit decimal"
        }
        return value
    }

    override fun serialize(encoder: Encoder, value: String) {
        require(value.toLongOrNull()?.let { it != 0L && it.toString() == value } == true) {
            "extension source id must be canonical signed-64-bit decimal"
        }
        encoder.encodeString(value)
    }
}

@Serializable
data class CorePortableManifestPage(
    val offset: Long,
    val pageSize: Long,
    val hasNextPage: Boolean,
    val totalCount: Long,
    val omittedCount: Long = 0,
) {
    init {
        require(offset >= 0) { "portable manifest offset must not be negative" }
        require(pageSize in 1L..250L) { "portable manifest page size is outside the Core limit" }
        require(totalCount >= 0) { "portable manifest total count must not be negative" }
        require(omittedCount >= 0) { "portable manifest omitted count must not be negative" }
    }
}

@Serializable
data class CorePortableComicWork(
    val portableId: String,
    val reference: PortableWorkRef.Comic,
    val dependencyPackageName: String? = null,
    val titleHint: String? = null,
    val providerLabelHint: String? = null,
) {
    init {
        require(portableId.startsWith("comic:") && portableId.length <= 128) {
            "portable comic ID is invalid"
        }
        dependencyPackageName?.let {
            require(it.isNotBlank() && it == it.trim()) { "dependency package name must be canonical" }
        }
    }
}

@Serializable
data class CorePortableManifest(
    val schemaVersion: Int,
    val scopeId: String,
    val runtimeFingerprint: String,
    val generatedAtMs: Long,
    val snapshotId: String,
    val snapshotFingerprint: String,
    val snapshotExpiresAtMs: Long,
    val page: CorePortableManifestPage,
    val comicDependencies: List<ComicDependency>,
    val works: List<CorePortableComicWork>,
) {
    init {
        require(schemaVersion == 3) { "unsupported portable manifest schema version" }
        require(scopeId.startsWith("comics:profile:")) { "portable manifest scope is invalid" }
        require(runtimeFingerprint.isNotBlank()) { "portable manifest runtime fingerprint is missing" }
        require(generatedAtMs >= 0) { "portable manifest timestamp must not be negative" }
        require(snapshotId.isNotBlank() && snapshotId.length <= 128) {
            "portable manifest snapshot ID is invalid"
        }
        require(snapshotFingerprint.startsWith("sha256:") && snapshotFingerprint.length == 71) {
            "portable manifest snapshot fingerprint is invalid"
        }
        require(snapshotExpiresAtMs > generatedAtMs) { "portable manifest snapshot expiry is invalid" }
    }
}

@Serializable
data class CorePortableNovelWork(
    val portableId: String,
    val reference: PortableWorkRef.Novel,
    val dependencyPluginId: String,
    val titleHint: String? = null,
    val providerLabelHint: String? = null,
) {
    init {
        require(portableId.startsWith("novel:") && portableId.length <= 128) {
            "portable novel ID is invalid"
        }
        require(dependencyPluginId.isNotBlank() && dependencyPluginId == dependencyPluginId.trim()) {
            "dependency plugin ID must be canonical"
        }
    }
}

@Serializable
data class CorePortableNovelManifest(
    val schemaVersion: Int,
    val scopeId: String,
    val manifestFingerprint: String,
    val generatedAtMs: Long,
    val snapshotId: String,
    val snapshotFingerprint: String,
    val snapshotExpiresAtMs: Long,
    val page: CorePortableManifestPage,
    val novelDependencies: List<NovelDependency>,
    val works: List<CorePortableNovelWork>,
) {
    init {
        require(schemaVersion == 3) { "unsupported portable novel manifest schema version" }
        require(scopeId.startsWith("novels:profile:")) { "portable novel manifest scope is invalid" }
        require(manifestFingerprint.startsWith("sha256:") && manifestFingerprint.length == 71) {
            "portable novel manifest fingerprint is invalid"
        }
        require(generatedAtMs >= 0) { "portable novel manifest timestamp must not be negative" }
        require(snapshotId.isNotBlank() && snapshotId.length <= 128) {
            "portable novel manifest snapshot ID is invalid"
        }
        require(snapshotFingerprint == manifestFingerprint) {
            "portable novel manifest fingerprints do not match"
        }
        require(snapshotExpiresAtMs > generatedAtMs) { "portable novel manifest snapshot expiry is invalid" }
    }
}

/** Opaque local reference resolved through the authenticated Core, never as a public URL. */
object SuwayomiCoreThumbnailReference {
    const val SCHEME = "aethon-core"

    fun forManga(serverId: String, profileId: String, mangaId: Long): String {
        require(serverId.isNotBlank()) { "serverId must not be blank" }
        require(profileId.isNotBlank()) { "profileId must not be blank" }
        require(mangaId > 0) { "mangaId must be positive" }
        return "$SCHEME://suwayomi/${encodePathSegment(serverId)}/${encodePathSegment(profileId)}/manga/$mangaId"
    }

    /** Legacy reference retained for records created before Core server identities were exposed. */
    fun forManga(profileId: String, mangaId: Long): String {
        require(profileId.isNotBlank()) { "profileId must not be blank" }
        require(mangaId > 0) { "mangaId must be positive" }
        return "$SCHEME://suwayomi/${encodePathSegment(profileId)}/manga/$mangaId"
    }

    fun parse(value: String): Parsed? {
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (!uri.scheme.equals(SCHEME, ignoreCase = true) || uri.host != "suwayomi") return null
        if (uri.query != null || uri.fragment != null) return null
        val segments = uri.rawPath?.split('/') ?: return null
        if (segments.firstOrNull()?.isNotEmpty() != false) return null
        val serverId: String?
        val profileId: String
        val mangaId: Long
        when {
            segments.size == 4 && segments[2] == "manga" -> {
                serverId = null
                profileId = decodePathSegment(segments[1]) ?: return null
                mangaId = segments[3].toLongOrNull() ?: return null
            }
            segments.size == 5 && segments[3] == "manga" -> {
                serverId = decodePathSegment(segments[1]) ?: return null
                profileId = decodePathSegment(segments[2]) ?: return null
                mangaId = segments[4].toLongOrNull() ?: return null
            }
            else -> return null
        }
        if (serverId?.isBlank() == true || profileId.isBlank() || mangaId <= 0) return null
        return Parsed(serverId, profileId, mangaId)
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private fun decodePathSegment(value: String): String? =
        runCatching { URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrNull()

    data class Parsed(val serverId: String?, val profileId: String, val mangaId: Long)
}

/** Stable logical references used by the internal mobile Core source. */
object SuwayomiCoreContentReference {
    private const val HOST = "suwayomi"

    fun forManga(serverId: String, profileId: String, mangaId: Long): String =
        build(serverId, profileId, "manga", mangaId.toString())

    fun forManga(profileId: String, mangaId: Long): String =
        build(null, profileId, "manga", mangaId.toString())

    fun forChapter(serverId: String, profileId: String, chapterId: Long): String =
        build(serverId, profileId, "chapter", chapterId.toString())

    fun forChapter(profileId: String, chapterId: Long): String =
        build(null, profileId, "chapter", chapterId.toString())

    fun forPage(serverId: String, profileId: String, upstreamPath: String): String {
        val canonicalPath = canonicalUpstreamPath(upstreamPath)
        return build(serverId, profileId, "page", canonicalPath)
    }

    fun forPage(profileId: String, upstreamPath: String): String {
        val canonicalPath = canonicalUpstreamPath(upstreamPath)
        return build(null, profileId, "page", canonicalPath)
    }

    fun parseManga(value: String): Manga? = parse(value, "manga")?.let { parsed ->
        parsed.payload.toLongOrNull()?.takeIf { it > 0 }?.let {
            Manga(parsed.serverId, parsed.profileId, it)
        }
    }

    fun parseChapter(value: String): Chapter? = parse(value, "chapter")?.let { parsed ->
        parsed.payload.toLongOrNull()?.takeIf { it > 0 }?.let {
            Chapter(parsed.serverId, parsed.profileId, it)
        }
    }

    fun parsePage(value: String): Page? = parse(value, "page")?.let { parsed ->
        runCatching { canonicalUpstreamPath(parsed.payload) }.getOrNull()
            ?.let { Page(parsed.serverId, parsed.profileId, it) }
    }

    private fun build(serverId: String?, profileId: String, kind: String, payload: String): String {
        require(serverId?.isNotBlank() != false) { "serverId must not be blank" }
        require(profileId.isNotBlank()) { "profileId must not be blank" }
        val identity = serverId?.let { "${encodePathSegment(it)}/${encodePathSegment(profileId)}" }
            ?: encodePathSegment(profileId)
        return "${SuwayomiCoreThumbnailReference.SCHEME}://$HOST/$identity/$kind/${encodePathSegment(payload)}"
    }

    private fun parse(value: String, expectedKind: String): Parsed? {
        val uri = runCatching { URI(value) }.getOrNull() ?: return null
        if (!uri.scheme.equals(SuwayomiCoreThumbnailReference.SCHEME, true) || uri.host != HOST) {
            return null
        }
        if (uri.query != null || uri.fragment != null) return null
        val segments = uri.rawPath?.split('/') ?: return null
        if (segments.firstOrNull()?.isNotEmpty() != false) return null
        val serverId: String?
        val profileId: String
        val payload: String
        when {
            segments.size == 4 && segments[2] == expectedKind -> {
                serverId = null
                profileId = decodePathSegment(segments[1]) ?: return null
                payload = decodePathSegment(segments[3]) ?: return null
            }
            segments.size == 5 && segments[3] == expectedKind -> {
                serverId = decodePathSegment(segments[1]) ?: return null
                profileId = decodePathSegment(segments[2]) ?: return null
                payload = decodePathSegment(segments[4]) ?: return null
            }
            else -> return null
        }
        if (serverId?.isBlank() == true || profileId.isBlank() || payload.isBlank()) return null
        return Parsed(serverId, profileId, payload)
    }

    private fun canonicalUpstreamPath(value: String): String {
        require(value.isNotBlank() && value.length <= 8_192) { "invalid Suwayomi resource path" }
        val uri = URI(value)
        require(!uri.isAbsolute && uri.host == null && uri.fragment == null) {
            "Suwayomi resource must be a relative path"
        }
        require(uri.rawPath.startsWith('/') && !uri.rawPath.contains('\\')) {
            "Suwayomi resource path must be rooted"
        }
        require(uri.rawPath.split('/').none { it == ".." || it == "." }) {
            "Suwayomi resource path contains an unsafe segment"
        }
        return buildString {
            append(uri.rawPath)
            uri.rawQuery?.let { append('?').append(it) }
        }
    }

    private fun encodePathSegment(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private fun decodePathSegment(value: String): String? =
        runCatching { URLDecoder.decode(value, Charsets.UTF_8.name()) }.getOrNull()

    private data class Parsed(val serverId: String?, val profileId: String, val payload: String)
    data class Manga(val serverId: String?, val profileId: String, val mangaId: Long)
    data class Chapter(val serverId: String?, val profileId: String, val chapterId: Long)
    data class Page(val serverId: String?, val profileId: String, val upstreamPath: String)
}
