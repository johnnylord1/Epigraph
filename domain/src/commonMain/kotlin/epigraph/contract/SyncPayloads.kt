package epigraph.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class CategoryScope {
    @SerialName("all")
    ALL,

    @SerialName("manga")
    MANGA,

    @SerialName("novel")
    NOVEL,

    @SerialName("book")
    BOOK,
}

@Serializable
data class ChapterStatePatch(
    val chapterId: String,
    val portableWorkRef: PortableWorkRef.Comic? = null,
    val portableChapterRef: PortableChapterRef.Comic? = null,
    val read: Boolean? = null,
    val bookmarked: Boolean? = null,
    val lastPageRead: Int? = null,
    val lastReadAtEpochMillis: Long? = null,
    val explicitProgressReset: Boolean = false,
) {
    init {
        validateProtocolIdentifier(chapterId, "chapter ID")
        require((portableWorkRef == null) == (portableChapterRef == null)) {
            "portable work and chapter references must be supplied together"
        }
        require(portableChapterRef == null || portableChapterRef.work == portableWorkRef) {
            "portable chapter must belong to the supplied portable work"
        }
        require(read != null || bookmarked != null || lastPageRead != null || lastReadAtEpochMillis != null) {
            "chapter state patch must change at least one field"
        }
        require(lastPageRead == null || lastPageRead >= 0) { "last page read must not be negative" }
        require(lastReadAtEpochMillis == null || lastReadAtEpochMillis >= 0) {
            "last read timestamp must not be negative"
        }
        require(!explicitProgressReset || lastPageRead != null) {
            "explicit progress reset requires a last page value"
        }
    }
}

@Serializable
enum class TrackingField {
    @SerialName("remote_id")
    REMOTE_ID,

    @SerialName("status")
    STATUS,

    @SerialName("progress")
    PROGRESS,

    @SerialName("score")
    SCORE,

    @SerialName("started_at")
    STARTED_AT,

    @SerialName("finished_at")
    FINISHED_AT,

    @SerialName("repeat_count")
    REPEAT_COUNT,

    @SerialName("private")
    PRIVATE,

    // Additive (tracker sync v1). Only emitted once syncd advertises the tracking entity types;
    // see docs/audit/TRACKER_SYNC_CONTRACT.md.
    @SerialName("library_id")
    LIBRARY_ID,

    @SerialName("title")
    TITLE,

    @SerialName("remote_url")
    REMOTE_URL,

    @SerialName("total_chapters")
    TOTAL_CHAPTERS,
}

/**
 * One non-secret tracker field update. Authentication material is intentionally not representable.
 * A null [value] is an explicit clear, while an absent field is represented by omitting the patch.
 */
@Serializable
data class TrackingFieldPatch(
    val field: TrackingField,
    val value: String? = null,
) {
    init {
        value?.let {
            require(it.length <= MAX_TRACKING_VALUE_LENGTH) { "tracking field value is too long" }
            require(it.none(Char::isISOControl)) { "tracking field value must not contain control characters" }
        }
    }
}

@Serializable
data class RepositoryDescriptor(
    val ecosystem: String,
    val displayName: String,
    val canonicalUrl: String,
    val enabled: Boolean,
) {
    init {
        validateProtocolIdentifier(ecosystem, "repository ecosystem")
        validateDisplayText(displayName, "repository display name")
        require(canonicalUrl == SourceUrlNormalizer.normalize(canonicalUrl)) {
            "repository URL must already be canonical"
        }
    }
}

@Serializable
data class ComicExtensionDescriptor(
    val repositoryId: EpigraphEntityId,
    val packageName: String,
    val displayName: String,
    val versionCode: Long,
    val versionName: String,
    val artifactSha256: String,
    val desiredInstalled: Boolean,
) {
    init {
        require(PACKAGE_NAME.matches(packageName)) { "extension package name is invalid" }
        validateDisplayText(displayName, "extension display name")
        require(versionCode >= 0) { "extension version code must not be negative" }
        validateProtocolIdentifier(versionName, "extension version name")
        validateSha256(artifactSha256, "extension artifact hash")
    }
}

@Serializable
data class NovelPluginDescriptor(
    val repositoryId: EpigraphEntityId,
    val pluginId: String,
    val displayName: String,
    val version: String,
    val manifestVersion: Int,
    val artifactSha256: String,
    val desiredInstalled: Boolean,
    /** LNReader plugins expose one source each; the Core keys a plugin by repository, plugin and source. */
    val sourceId: String? = null,
    /** Language exactly as the repository index declares it. */
    val lang: String? = null,
    val artifactByteLength: Long? = null,
) {
    init {
        validateProtocolIdentifier(pluginId, "novel plugin ID")
        validateDisplayText(displayName, "novel plugin display name")
        validateProtocolIdentifier(version, "novel plugin version")
        require(manifestVersion > 0) { "novel plugin manifest version must be positive" }
        validateSha256(artifactSha256, "novel plugin artifact hash")
        sourceId?.let { validateProtocolIdentifier(it, "novel plugin source ID") }
        lang?.let { validateDisplayText(it, "novel plugin language") }
        artifactByteLength?.let { require(it > 0) { "novel plugin artifact length must be positive" } }
    }
}

@Serializable
enum class AssetRole {
    @SerialName("publication")
    PUBLICATION,

    @SerialName("cover")
    COVER,

    @SerialName("chapter")
    CHAPTER,

    @SerialName("attachment")
    ATTACHMENT,
}

@Serializable
data class AssetDescriptor(
    val sha256: String,
    val sizeBytes: Long,
    val mediaType: String,
) {
    init {
        validateSha256(sha256, "asset hash")
        require(sizeBytes >= 0) { "asset size must not be negative" }
        require(MEDIA_TYPE.matches(mediaType)) { "asset media type is invalid" }
    }
}

@Serializable
enum class IdentityMigrationReason {
    @SerialName("canonicalized")
    CANONICALIZED,

    @SerialName("source_rebound")
    SOURCE_REBOUND,

    @SerialName("duplicate_merged")
    DUPLICATE_MERGED,

    @SerialName("user_confirmed")
    USER_CONFIRMED,
}

internal fun validateSha256(value: String, label: String) {
    require(SHA_256.matches(value)) { "$label must be a lowercase SHA-256 value" }
}

private fun validateDisplayText(value: String, label: String) {
    require(value.isNotBlank()) { "$label must not be blank" }
    require(value == value.trim()) { "$label must not have surrounding whitespace" }
    require(value.length <= MAX_DISPLAY_TEXT_LENGTH) { "$label is too long" }
    require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
}

private const val MAX_TRACKING_VALUE_LENGTH = 4096
private const val MAX_DISPLAY_TEXT_LENGTH = 512
private val SHA_256 = Regex("[0-9a-f]{64}")
private val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")
private val MEDIA_TYPE = Regex("[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+")
