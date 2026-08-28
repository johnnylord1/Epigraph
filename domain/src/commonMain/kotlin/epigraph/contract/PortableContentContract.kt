package epigraph.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.security.MessageDigest

@Serializable
enum class PortableEcosystem {
    @SerialName("suwayomi")
    SUWAYOMI,

    @SerialName("lnreader")
    LNREADER,
}

/** Provider-owned keys are opaque and must survive the protocol byte-for-byte. */
@JvmInline
@Serializable
value class ProviderOwnedKey(val value: String) {
    init {
        require(value.isNotEmpty()) { "provider-owned key must not be empty" }
        require(value.length <= MAX_PROVIDER_KEY_LENGTH) { "provider-owned key is too long" }
        require(value.none(Char::isISOControl)) { "provider-owned key must not contain control characters" }
        require(!providerOwnedKeyMayContainSecret(value)) {
            "provider-owned key may contain private credentials"
        }
    }

    override fun toString(): String = value
}

@JvmInline
@Serializable
value class DecimalSourceId(val value: String) {
    init {
        require(CANONICAL_SIGNED_DECIMAL.matches(value)) {
            "source ID must be a canonical signed decimal string"
        }
        require(value.toLongOrNull() != null) { "source ID exceeds the signed 64-bit range" }
    }

    fun toLong(): Long = value.toLongOrNull()
        ?: throw IllegalArgumentException("source ID exceeds the signed 64-bit range")

    override fun toString(): String = value
}

@Serializable
sealed interface PortableWorkRef {
    val ecosystem: PortableEcosystem

    @Serializable
    @SerialName("comic")
    data class Comic(
        val sourceId: DecimalSourceId,
        val mangaKey: ProviderOwnedKey,
    ) : PortableWorkRef {
        override val ecosystem: PortableEcosystem = PortableEcosystem.SUWAYOMI
    }

    @Serializable
    @SerialName("novel")
    data class Novel(
        val pluginId: String,
        val novelKey: ProviderOwnedKey,
    ) : PortableWorkRef {
        override val ecosystem: PortableEcosystem = PortableEcosystem.LNREADER

        init {
            validatePortableIdentifier(pluginId, "plugin ID")
        }
    }
}

@Serializable
sealed interface PortableChapterRef {
    val work: PortableWorkRef

    @Serializable
    @SerialName("comic")
    data class Comic(
        override val work: PortableWorkRef.Comic,
        val chapterKey: ProviderOwnedKey,
    ) : PortableChapterRef

    @Serializable
    @SerialName("novel")
    data class Novel(
        override val work: PortableWorkRef.Novel,
        val chapterKey: ProviderOwnedKey,
    ) : PortableChapterRef
}

/** Stable envelope IDs derived only from provider-owned V3 references. */
object PortableIdentityV3 {
    fun workId(ref: PortableWorkRef): String = when (ref) {
        is PortableWorkRef.Comic -> "comic:${digest("comic", ref.sourceId.value, ref.mangaKey.value)}"
        is PortableWorkRef.Novel -> "novel:${digest("novel", ref.pluginId, ref.novelKey.value)}"
    }

    fun chapterId(ref: PortableChapterRef): String = when (ref) {
        is PortableChapterRef.Comic -> "comic-chapter:${digest(
            "comic-chapter",
            ref.work.sourceId.value,
            ref.work.mangaKey.value,
            ref.chapterKey.value,
        )}"
        is PortableChapterRef.Novel -> "novel-chapter:${digest(
            "novel-chapter",
            ref.work.pluginId,
            ref.work.novelKey.value,
            ref.chapterKey.value,
        )}"
    }

    private fun digest(vararg components: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        components.forEachIndexed { index, value ->
            if (index > 0) digest.update(0)
            digest.update(value.toByteArray(Charsets.UTF_8))
        }
        return digest.digest().joinToString(separator = "") { byte -> "%02x".format(byte) }
    }
}

@Serializable
data class ExtensionStoreReference(
    val storeIndexUrl: String,
    val observedManifestSha256: String? = null,
    val displayNameHint: String? = null,
) {
    init {
        validatePublicIndexUrl(storeIndexUrl, "extension store")
        observedManifestSha256?.let { validateSha256(it, "extension store manifest hash") }
        displayNameHint?.let { validateHint(it, "extension store display name") }
    }
}

@Serializable
data class ComicDependency(
    val pkgName: String,
    val requiredSourceIds: Set<DecimalSourceId>,
    val observedVersionCode: String? = null,
    val extensionStore: ExtensionStoreReference? = null,
) {
    init {
        require(PACKAGE_NAME.matches(pkgName)) { "extension package name is invalid" }
        require(requiredSourceIds.isNotEmpty()) { "comic dependency must require at least one source" }
        observedVersionCode?.let { validatePortableIdentifier(it, "observed extension version code") }
    }
}

@Serializable
data class RepositoryReference(
    val indexUrl: String,
    val observedManifestSha256: String? = null,
    val displayNameHint: String? = null,
) {
    init {
        validatePublicIndexUrl(indexUrl, "plugin repository")
        observedManifestSha256?.let { validateSha256(it, "plugin repository manifest hash") }
        displayNameHint?.let { validateHint(it, "plugin repository display name") }
    }
}

@Serializable
data class NovelDependency(
    val pluginId: String,
    val observedVersion: String? = null,
    val repository: RepositoryReference? = null,
    val observedArtifactSha256: String? = null,
) {
    init {
        validatePortableIdentifier(pluginId, "plugin ID")
        observedVersion?.let { validatePortableIdentifier(it, "observed plugin version") }
        observedArtifactSha256?.let { validateSha256(it, "observed plugin artifact hash") }
    }
}

@Serializable
sealed interface ProviderDependency {
    val ecosystem: PortableEcosystem

    @Serializable
    @SerialName("comic")
    data class Comic(val dependency: ComicDependency) : ProviderDependency {
        override val ecosystem: PortableEcosystem = PortableEcosystem.SUWAYOMI
    }

    @Serializable
    @SerialName("novel")
    data class Novel(val dependency: NovelDependency) : ProviderDependency {
        override val ecosystem: PortableEcosystem = PortableEcosystem.LNREADER
    }
}

@Serializable
enum class PortableResolutionState {
    PENDING_DEPENDENCY,
    PENDING_PROVIDER,
    RESOLVING,
    READY,
    BOUND,
    RETRYABLE_FAILURE,
    REQUIRES_USER_ACTION,
    LEGACY_UNBOUND,
    CONFLICT,
}

@Serializable
enum class PortableResolutionReason {
    EXTENSION_NOT_FOUND,
    EXTENSION_STORE_MISSING,
    EXTENSION_STORE_APPROVAL_REQUIRED,
    EXTENSION_NOT_LOADED,
    PLUGIN_NOT_FOUND,
    PLUGIN_REPOSITORY_MISSING,
    PLUGIN_REPOSITORY_APPROVAL_REQUIRED,
    SOURCE_NOT_FOUND,
    SOURCE_NOT_LOADED,
    SOURCE_OFFLINE,
    SOURCE_AUTH_REQUIRED,
    SOURCE_CONFIGURATION_REQUIRED,
    WORK_NOT_FOUND,
    WORK_RESOLUTION_UNSUPPORTED,
    WORK_RESOLUTION_FAILED,
    CHAPTER_NOT_FOUND,
    CHAPTER_RESOLUTION_FAILED,
}

@Serializable
data class PortableResolution(
    val state: PortableResolutionState,
    val reason: PortableResolutionReason? = null,
) {
    init {
        require(state != PortableResolutionState.BOUND || reason == null) {
            "bound resolutions cannot retain a failure reason"
        }
    }
}

interface PortableContentProvider {
    val ecosystem: PortableEcosystem

    suspend fun inspectDependencies(
        dependencies: List<ProviderDependency>,
    ): DependencyResolutionResult

    suspend fun resolveWork(ref: PortableWorkRef): WorkResolution

    suspend fun resolveChapter(ref: PortableChapterRef): ChapterResolution
}

data class DependencyResolutionResult(
    val resolutions: Map<ProviderDependency, PortableResolution>,
)

data class WorkResolution(
    val ref: PortableWorkRef,
    val resolution: PortableResolution,
    val localId: String? = null,
)

data class ChapterResolution(
    val ref: PortableChapterRef,
    val resolution: PortableResolution,
    val localId: String? = null,
)

private fun validatePortableIdentifier(value: String, label: String) {
    require(value.isNotBlank()) { "$label must not be blank" }
    require(value == value.trim()) { "$label must not have surrounding whitespace" }
    require(value.length <= MAX_PORTABLE_IDENTIFIER_LENGTH) { "$label is too long" }
    require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
}

private fun validateHint(value: String, label: String) {
    require(value.isNotBlank()) { "$label must not be blank" }
    require(value == value.trim()) { "$label must not have surrounding whitespace" }
    require(value.length <= MAX_HINT_LENGTH) { "$label is too long" }
    require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
}

private fun validatePublicIndexUrl(value: String, label: String) {
    require(value == SourceUrlNormalizer.normalizePublicHttpsIndex(value)) {
        "$label URL must be a canonical public HTTPS index"
    }
}

private fun providerOwnedKeyMayContainSecret(value: String): Boolean {
    val beforeFragment = value.substringBefore('#')
    val authority = beforeFragment.substringAfter("://", missingDelimiterValue = "")
        .substringBefore('/')
        .substringBefore('?')
    if (authority.isNotEmpty() && '@' in authority) return true
    val query = beforeFragment.substringAfter('?', missingDelimiterValue = "")
    if (query.isEmpty()) return false
    return query.split('&').any { component ->
        val name = component.substringBefore('=').asciiPercentDecode().lowercase()
        name in SENSITIVE_PROVIDER_QUERY_NAMES
    }
}

private fun String.asciiPercentDecode(): String = buildString(length) {
    var index = 0
    while (index < this@asciiPercentDecode.length) {
        if (this@asciiPercentDecode[index] == '%' && index + 2 < this@asciiPercentDecode.length) {
            val decoded = this@asciiPercentDecode.substring(index + 1, index + 3).toIntOrNull(16)
            if (decoded != null && decoded in 0..127) {
                append(decoded.toChar())
                index += 3
                continue
            }
        }
        append(this@asciiPercentDecode[index])
        index++
    }
}

private const val MAX_PROVIDER_KEY_LENGTH = 4096
private const val MAX_PORTABLE_IDENTIFIER_LENGTH = 512
private const val MAX_HINT_LENGTH = 512
private val CANONICAL_SIGNED_DECIMAL = Regex("0|-?[1-9][0-9]*")
private val PACKAGE_NAME = Regex("[A-Za-z][A-Za-z0-9_]*(?:\\.[A-Za-z][A-Za-z0-9_]*)+")
private val SENSITIVE_PROVIDER_QUERY_NAMES = setOf(
    "token",
    "access_token",
    "accesstoken",
    "auth",
    "authorization",
    "api_key",
    "apikey",
    "key",
    "signature",
    "sig",
    "session",
    "sessionid",
    "cookie",
    "password",
    "passwd",
    "secret",
)
