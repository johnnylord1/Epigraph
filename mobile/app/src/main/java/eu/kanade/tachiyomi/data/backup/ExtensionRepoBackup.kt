package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupExtensionRepo
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.StringPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import java.io.ByteArrayOutputStream
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.protobuf.ProtoBuf

/**
 * The extension repositories of a backup, whichever app wrote it:
 *
 * - Epigraph writes them in field 900.
 * - Mihon writes them in field 106, which Epigraph uses for local books ([ForeignBackupFields]).
 * - Tachiyomi 0.15, J2K and older forks keep them in the `extension_repos` preference.
 */
object ExtensionRepoBackup {
    /** Preferences that carry repositories; they are converted, never restored as preferences. */
    const val LEGACY_REPOS_KEY = "extension_repos"
    private const val LEGACY_METADATA_KEY = "extension_repo_metadata"
    val LEGACY_KEYS = setOf(LEGACY_REPOS_KEY, LEGACY_METADATA_KEY)

    private val INDEX_FILES = listOf("index.min.json", "index.json", "index.pb", "repo.json")
    private val GITHUB_HOSTS = setOf("github.com", "www.github.com")

    /**
     * The repository base URL the extension list reads `index.min.json` and `repo.json` from, or
     * null when [url] cannot be one. Older apps stored the base URL, newer ones an index file, and
     * some a `github.com/<owner>/<repo>/raw/<branch>` link; all of them map to the same base URL.
     */
    fun baseUrl(url: String): String? {
        var value = url.trim().substringBefore('#').substringBefore('?').trimEnd('/')
        if (!value.startsWith("https://", ignoreCase = true)) return null
        INDEX_FILES.firstOrNull { value.endsWith("/$it", ignoreCase = true) }
            ?.let { value = value.dropLast(it.length + 1) }
        val segments = value.substring("https://".length).split('/')
        if (segments.first().isBlank()) return null
        if (segments.first().lowercase() in GITHUB_HOSTS && segments.size >= 5 && segments[3] == "raw") {
            val ref = segments.drop(4).let { if (it.size > 2 && it[0] == "refs" && it[1] == "heads") it.drop(2) else it }
            value = "https://raw.githubusercontent.com/${segments[1]}/${segments[2]}/${ref.joinToString("/")}"
        }
        return value
    }

    /** The repositories a Tachiyomi 0.15 or J2K backup kept in its app preferences. */
    fun fromLegacyPreferences(preferences: List<BackupPreference>): List<BackupExtensionRepo> {
        val urls = (preferences.firstOrNull { it.key == LEGACY_REPOS_KEY }?.value as? StringSetPreferenceValue)
            ?.value
            ?.sorted()
            ?: return emptyList()
        val metadata = (preferences.firstOrNull { it.key == LEGACY_METADATA_KEY }?.value as? StringPreferenceValue)
            ?.let { runCatching { Json.parseToJsonElement(it.value) as? JsonObject }.getOrNull() }
        return urls.map { url ->
            val details = metadata?.get(url) as? JsonObject
            BackupExtensionRepo(
                baseUrl = url,
                name = (details?.get("name") as? JsonPrimitive)?.contentOrNull.orEmpty(),
                website = (details?.get("website") as? JsonPrimitive)?.contentOrNull.orEmpty(),
            )
        }
    }

    /** [repos] without the ones that point to the same base URL as an earlier entry. */
    fun distinct(repos: List<BackupExtensionRepo>): List<BackupExtensionRepo> =
        repos.distinctBy { baseUrl(it.baseUrl) ?: it.baseUrl }
}

/**
 * Fields other apps write at numbers Epigraph uses for something else. They are taken out of the
 * raw payload before it is decoded, so another fork's backup restores instead of failing.
 */
internal object ForeignBackupFields {
    /** Epigraph's local books; Mihon's extension repositories. */
    private const val FIELD_106 = 106

    /** `importedAt`, a field every Epigraph local book has and a repository never does. */
    private const val LOCAL_BOOK_IMPORTED_AT = 9

    class Extracted(val payload: ByteArray, val extensionRepos: List<BackupExtensionRepo>)

    fun extract(payload: ByteArray): Extracted {
        val fields = runCatching { ProtoWire.fields(payload, 0, payload.size) }.getOrNull()
            ?: return Extracted(payload, emptyList())
        val foreign = fields.filter { field ->
            field.number == FIELD_106 && field.wireType == ProtoWire.LENGTH_DELIMITED && !field.isLocalBook(payload)
        }
        if (foreign.isEmpty()) return Extracted(payload, emptyList())

        val repos = foreign.mapNotNull { field ->
            runCatching {
                ProtoBuf.decodeFromByteArray(
                    BackupExtensionRepo.serializer(),
                    payload.copyOfRange(field.valueStart, field.end),
                )
            }.getOrNull()?.takeIf { it.baseUrl.isNotBlank() }
        }
        val rest = ByteArrayOutputStream(payload.size)
        var copied = 0
        foreign.forEach { field ->
            rest.write(payload, copied, field.start - copied)
            copied = field.end
        }
        rest.write(payload, copied, payload.size - copied)
        return Extracted(rest.toByteArray(), repos)
    }

    private fun ProtoWire.Field.isLocalBook(payload: ByteArray): Boolean {
        val inner = runCatching { ProtoWire.fields(payload, valueStart, end) }.getOrNull() ?: return true
        return inner.any { it.number == LOCAL_BOOK_IMPORTED_AT && it.wireType == ProtoWire.VARINT }
    }
}

/** The top level of a protobuf message, read without decoding the values. */
internal object ProtoWire {
    const val VARINT = 0
    private const val FIXED64 = 1
    const val LENGTH_DELIMITED = 2
    private const val FIXED32 = 5

    /** One field: its key starts at [start], its value at [valueStart], and it ends before [end]. */
    class Field(val number: Int, val wireType: Int, val start: Int, val valueStart: Int, val end: Int)

    fun fields(bytes: ByteArray, from: Int, to: Int): List<Field> {
        val fields = mutableListOf<Field>()
        var index = from
        while (index < to) {
            val start = index
            val key = readVarint(bytes, index, to)
            index = key.next
            val number = (key.value ushr 3).toInt()
            val wireType = (key.value and 7).toInt()
            require(number > 0) { "Invalid field number" }
            val valueStart: Int
            when (wireType) {
                VARINT -> {
                    valueStart = index
                    index = readVarint(bytes, index, to).next
                }
                FIXED64 -> {
                    valueStart = index
                    index += 8
                }
                LENGTH_DELIMITED -> {
                    val length = readVarint(bytes, index, to)
                    require(length.value in 0..(to - length.next).toLong()) { "Invalid length" }
                    valueStart = length.next
                    index = valueStart + length.value.toInt()
                }
                FIXED32 -> {
                    valueStart = index
                    index += 4
                }
                else -> throw IllegalArgumentException("Unsupported wire type $wireType")
            }
            require(index <= to) { "Truncated field" }
            fields += Field(number, wireType, start, valueStart, index)
        }
        return fields
    }

    private class Varint(val value: Long, val next: Int)

    private fun readVarint(bytes: ByteArray, from: Int, to: Int): Varint {
        var result = 0L
        var shift = 0
        var index = from
        while (index < to && shift < 64) {
            val byte = bytes[index++].toInt() and 0xff
            result = result or ((byte and 0x7f).toLong() shl shift)
            if (byte and 0x80 == 0) return Varint(result, index)
            shift += 7
        }
        throw IllegalArgumentException("Invalid varint")
    }
}
