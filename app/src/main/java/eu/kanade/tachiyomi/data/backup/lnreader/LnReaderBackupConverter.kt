package eu.kanade.tachiyomi.data.backup.lnreader

import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.source.NovelSource
import eu.kanade.tachiyomi.data.backup.models.Backup
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupChapter
import eu.kanade.tachiyomi.data.backup.models.BackupHistory
import eu.kanade.tachiyomi.data.backup.models.BackupManga
import eu.kanade.tachiyomi.data.backup.models.BackupNovelRepository
import eu.kanade.tachiyomi.data.backup.models.BackupSource
import eu.kanade.tachiyomi.source.model.SManga
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import yokai.domain.category.CategoryLibrary
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.net.URI
import java.net.URLEncoder
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import kotlin.math.roundToInt

/**
 * Converts an LNReader backup into Epigraph's native [Backup], so the regular restore keeps the
 * novels in Books & novels, merges them with titles already in the library (no duplicates) and
 * records the changes for sync like any other restore. Mirrors the desktop importer in
 * `desktop/src/lib/backup/lnreaderBackup.ts`.
 *
 * Plugin code shipped inside the backup is never installed: plugins come only from trusted
 * repositories, and novels whose plugin is missing are restored and wait for it.
 */
class LnReaderBackupConverter(
    /** Language code of each plugin id as installed here or listed by a repository. */
    private val knownPluginLangs: Map<String, String> = emptyMap(),
    private val now: () -> Long = System::currentTimeMillis,
    private val zone: ZoneId = ZoneId.systemDefault(),
) {
    /**
     * @param workDir private directory for the temporary copy of the nested data archive.
     * @param coverSink receives the cover images found in the backup, keyed by the cover URL the
     * restored title uses. Null skips the covers, e.g. when only validating the file.
     */
    fun convert(backupFile: File, workDir: File, coverSink: ((String, ByteArray) -> Unit)? = null): Backup =
        ZipFile(backupFile).use { outer ->
            val dataEntry = outer.getEntry(DATA_ZIP) ?: return parse(outer, outer, coverSink)
            val dataFile = File.createTempFile("lnreader-data", ".zip", workDir)
            try {
                outer.getInputStream(dataEntry).use { input ->
                    dataFile.outputStream().use { copyAtMost(input, it, MAX_DATA_ZIP_BYTES) }
                }
                ZipFile(dataFile).use { data -> parse(outer, data, coverSink) }
            } finally {
                dataFile.delete()
            }
        }

    private fun parse(outer: ZipFile, data: ZipFile, coverSink: ((String, ByteArray) -> Unit)?): Backup {
        val settings = readJson(data, SETTING_FILE) as? JsonObject ?: JsonObject(emptyMap())
        val plugins = readPluginMetadata(data, settings)
        val novelFiles = data.entries().asSequence()
            .filter { !it.isDirectory && it.name.startsWith("$NOVEL_DIR/") && it.name.endsWith(".json") }
            .sortedBy { it.name }
            .toList()
        require(novelFiles.isNotEmpty()) { "This LNReader backup has no saved novels" }

        val novels = LinkedHashMap<Pair<Long, String>, ParsedNovel>()
        novelFiles.forEachIndexed { index, entry ->
            val raw = runCatching { json.parseToJsonElement(readText(data, entry.name)) }.getOrNull() as? JsonObject
                ?: return@forEachIndexed
            parseNovel(raw, index, plugins)?.let { novels.putIfAbsent(it.manga.source to it.manga.url, it) }
        }
        require(novels.isNotEmpty()) { "This LNReader backup has no saved library novels" }

        if (coverSink != null) restoreCovers(outer, data, novels.values, coverSink)
        val categories = parseCategories(data, novels.values)

        val sources = novels.values
            .distinctBy { it.manga.source }
            .map { BackupSource(name = plugins[it.pluginId]?.name ?: it.pluginId, sourceId = it.manga.source, isNovel = true) }
        // Like the desktop, the repositories of the installed plugins and of the saved novels'
        // plugins come along, so a missing plugin can be installed right after the restore.
        val usedPluginIds = novels.values.map { it.pluginId }.toSet()
        val repositories = plugins.values
            .filter { it.installed || it.id in usedPluginIds }
            .mapNotNull { it.repositoryUrl }
            .distinct()
            .map { BackupNovelRepository(url = it, name = repositoryName(it)) }
        return Backup(
            backupManga = novels.values.map { it.manga },
            backupCategories = categories,
            backupSources = sources,
            novelRepositories = repositories,
        )
    }

    private fun parseNovel(raw: JsonObject, index: Int, plugins: Map<String, PluginMetadata>): ParsedNovel? {
        if ("inLibrary" in raw && !raw["inLibrary"].isTruthy()) return null
        val pluginId = raw.text("pluginId") ?: return null
        val path = raw.text("path") ?: return null
        val plugin = plugins[pluginId]
        // The source id must be the one the plugin gets when installed here, or the restored
        // novel would not open with it; a repository listing knows that better than the backup.
        val lang = knownPluginLangs[pluginId]
            ?: plugin?.lang?.let(NovelPluginManager::langFromLnReaderLang)
            ?: DEFAULT_LANG

        val chapters = (raw["chapters"] as? JsonArray).orEmpty()
            .mapIndexedNotNull { chapterIndex, element ->
                val chapter = element as? JsonObject ?: return@mapIndexedNotNull null
                val chapterPath = chapter.text("path") ?: return@mapIndexedNotNull null
                ParsedChapter(chapter, chapterPath, chapter.number("position") ?: chapterIndex.toDouble(), chapterIndex)
            }
            .distinctBy { it.path }
            .sortedWith(compareBy({ it.order }, { it.index }))
        val history = mutableListOf<BackupHistory>()
        val backupChapters = chapters.mapIndexed { position, parsed ->
            val chapter = parsed.raw
            val read = chapter["unread"].isFalsey()
            val progress = if (read) 0 else (chapterProgress(chapter["progress"]) * 100).roundToInt().coerceIn(0, 100)
            val releasedAt = parseDate(chapter["releaseTime"]) ?: 0L
            parseDate(chapter["readTime"])?.let { history += BackupHistory(url = parsed.path, lastRead = it) }
            BackupChapter(
                url = parsed.path,
                name = chapter.text("name") ?: chapter.text("title") ?: "Chapter ${parsed.index + 1}",
                read = read,
                bookmark = chapter["bookmark"].isTruthy(),
                // Novel chapters store the scroll percentage, as the novel reader does.
                lastPageRead = progress,
                pagesLeft = if (progress > 0) 100 - progress else 0,
                dateFetch = parseDate(chapter["updatedTime"]) ?: releasedAt,
                dateUpload = releasedAt,
                chapterNumber = chapter.number("chapterNumber")?.toFloat() ?: -1f,
                // Sources list the newest chapter first; LNReader positions count from the first.
                sourceOrder = chapters.lastIndex - position,
            )
        }

        val manga = BackupManga(
            source = NovelSource.sourceIdFor(pluginId, lang),
            url = path,
            title = raw.text("name") ?: raw.text("title") ?: titleFromPath(path) ?: "Novel ${index + 1}",
            artist = raw.text("artist"),
            author = raw.text("author"),
            description = raw.text("summary"),
            genre = raw.text("genres")?.split(',')?.map(String::trim)?.filter(String::isNotEmpty).orEmpty(),
            status = statusOf(raw.text("status")),
            thumbnailUrl = raw.text("cover")?.takeIf(::isUsableCoverUrl),
            dateAdded = now(),
            chapters = backupChapters,
            favorite = true,
            history = history,
        )
        return ParsedNovel(manga, pluginId, rawId = raw.text("id"), coverPath = raw.text("cover"))
    }

    /**
     * Covers downloaded by LNReader live inside the backup. They are written to the cover cache
     * under the title's cover URL, so they show offline and survive until the source refreshes it.
     */
    private fun restoreCovers(
        outer: ZipFile,
        data: ZipFile,
        novels: Collection<ParsedNovel>,
        coverSink: (String, ByteArray) -> Unit,
    ) {
        // Lower rank wins, like the desktop: the downloaded file, then LNReader's novel files,
        // then the Covers folder of newer backups.
        val wanted = HashMap<String, MutableList<Pair<ParsedNovel, Int>>>()
        fun want(key: String, novel: ParsedNovel, rank: Int) {
            wanted.getOrPut(key) { mutableListOf() } += novel to rank
        }
        novels.forEach { novel ->
            novel.coverPath?.let(::normalizeAssetPath)?.takeIf(String::isNotEmpty)?.let { path ->
                want("$DOWNLOAD_ZIP:$path", novel, 0)
                path.substringAfter("/Novels/", "").takeIf(String::isNotEmpty)?.let { want("$DOWNLOAD_ZIP:Novels/$it", novel, 0) }
                val relative = if (path.startsWith("Novels/")) path.removePrefix("Novels/") else path.substringAfter("/Novels/", "")
                relative.takeIf(String::isNotEmpty)?.let { want("$NOVEL_FILES_ZIP:$it", novel, 1) }
            }
            novel.rawId?.let { want("$COVERS_DIR/$it", novel, 2) }
        }
        val best = HashMap<ParsedNovel, Int>()
        fun offer(key: String, bytes: () -> ByteArray?) {
            val candidates = wanted[key]?.filter { (novel, rank) -> rank < (best[novel] ?: Int.MAX_VALUE) } ?: return
            if (candidates.isEmpty()) return
            val image = runCatching { bytes() }.getOrNull()?.takeIf(::looksLikeImage) ?: return
            candidates.forEach { (novel, rank) ->
                val url = novel.manga.thumbnailUrl ?: localCoverUrl(novel)
                if (runCatching { coverSink(url, image) }.isSuccess) {
                    best[novel] = rank
                    novel.manga.thumbnailUrl = url
                }
            }
        }

        for (zip in listOf(data, outer).distinct()) {
            zip.entries().asSequence()
                .filter { !it.isDirectory && it.name.startsWith("$COVERS_DIR/") }
                .forEach { entry -> offer(entry.name) { zip.getInputStream(entry).use { readAtMost(it, MAX_COVER_BYTES) } } }
        }
        for (nested in listOf(DOWNLOAD_ZIP, NOVEL_FILES_ZIP)) {
            val (zip, entry) = listOf(data, outer).distinct().firstNotNullOfOrNull { zip -> zip.getEntry(nested)?.let { zip to it } }
                ?: continue
            // Streamed so a backup with many downloaded chapters is never held in memory. An
            // archive this reader cannot stream only costs the covers; the source restores them.
            runCatching {
                ZipInputStream(zip.getInputStream(entry)).use { stream ->
                    while (true) {
                        val item = stream.nextEntry ?: break
                        if (!item.isDirectory) offer("$nested:${normalizeAssetPath(item.name)}") { readAtMost(stream, MAX_COVER_BYTES) }
                    }
                }
            }
        }
    }

    private fun parseCategories(data: ZipFile, novels: Collection<ParsedNovel>): List<BackupCategory> {
        val raw = readJson(data, CATEGORY_FILE) as? JsonArray ?: return emptyList()
        val novelsByRawId = novels.filter { it.rawId != null }.groupBy { it.rawId!! }
        val categories = raw.mapNotNull { element ->
            val category = element as? JsonObject ?: return@mapNotNull null
            val id = category.text("id") ?: return@mapNotNull null
            val name = category.text("name") ?: return@mapNotNull null
            val members = (category["novelIds"] as? JsonArray).orEmpty()
                .mapNotNull { it.textOrNull() }
                // An id shared by two backup records cannot say which one is in the folder.
                .mapNotNull { novelsByRawId[it]?.singleOrNull() }
                .distinct()
            // LNReader seeds two system categories: 1 is its default (here: no folder) and 2
            // holds local EPUB imports. Neither is a folder the user created.
            if (id == LNREADER_DEFAULT_CATEGORY_ID) return@mapNotNull null
            if (id == LNREADER_LOCAL_CATEGORY_ID && members.isEmpty()) return@mapNotNull null
            Triple(category.number("sort") ?: 0.0, name, members)
        }.sortedBy { it.first }

        return categories.mapIndexed { order, (_, name, members) ->
            members.forEach { it.manga.categories += order }
            BackupCategory(name = name, order = order, library = CategoryLibrary.BOOKS.name)
        }
    }

    private fun readPluginMetadata(data: ZipFile, settings: JsonObject): Map<String, PluginMetadata> {
        fun list(element: JsonElement?, installed: Boolean): List<PluginMetadata> {
            val array = when (element) {
                is JsonArray -> element
                is JsonPrimitive -> element.textOrNull()?.let { runCatching { json.parseToJsonElement(it) }.getOrNull() } as? JsonArray
                else -> null
            }
            return array.orEmpty().mapNotNull { item ->
                val obj = item as? JsonObject ?: return@mapNotNull null
                val id = obj.text("id") ?: return@mapNotNull null
                PluginMetadata(id, obj.text("name") ?: id, obj.text("lang"), repositoryUrl(obj.text("url")), installed)
            }
        }
        // Plugins.json describes what was installed, then the installed and available lists.
        return (
            list(settings["AVAILABLE_PLUGINS"], installed = false) +
                list(settings["INSTALL_PLUGINS"], installed = true) +
                list(readJson(data, PLUGINS_FILE), installed = true)
            )
            .associateBy { it.id }
    }

    private fun readJson(zip: ZipFile, name: String): JsonElement? =
        zip.getEntry(name)?.let { runCatching { json.parseToJsonElement(readText(zip, name)) }.getOrNull() }

    private fun readText(zip: ZipFile, name: String): String =
        zip.getInputStream(zip.getEntry(name)).use { readAtMost(it, MAX_JSON_BYTES) }.decodeToString()

    private fun parseDate(value: JsonElement?): Long? {
        val primitive = value as? JsonPrimitive ?: return null
        primitive.longOrNull?.let { return if (it > 100_000_000_000L) it else it * 1000 }
        val raw = primitive.textOrNull() ?: return null
        return runCatching { Instant.parse(raw).toEpochMilli() }
            .recoverCatching { OffsetDateTime.parse(raw).toInstant().toEpochMilli() }
            // LNReader writes SQLite local times such as "2024-05-01 21:03:11".
            .recoverCatching { LocalDateTime.parse(raw.replace(' ', 'T')).atZone(zone).toInstant().toEpochMilli() }
            .recoverCatching { LocalDate.parse(raw).atStartOfDay(zone).toInstant().toEpochMilli() }
            .getOrNull()
    }

    private class PluginMetadata(
        val id: String,
        val name: String,
        val lang: String?,
        val repositoryUrl: String?,
        val installed: Boolean,
    )

    private class ParsedChapter(val raw: JsonObject, val path: String, val order: Double, val index: Int)

    private class ParsedNovel(val manga: BackupManga, val pluginId: String, val rawId: String?, val coverPath: String?)

    companion object {
        private const val SETTING_FILE = "Setting.json"
        private const val CATEGORY_FILE = "Category.json"
        private const val PLUGINS_FILE = "Plugins.json"
        private const val VERSION_FILE = "Version.json"
        private const val NOVEL_DIR = "NovelAndChapters"
        private const val COVERS_DIR = "Covers"
        private const val DATA_ZIP = "data.zip"
        private const val DOWNLOAD_ZIP = "download.zip"
        private const val NOVEL_FILES_ZIP = "novel-files.zip"
        private const val LNREADER_DEFAULT_CATEGORY_ID = "1"
        private const val LNREADER_LOCAL_CATEGORY_ID = "2"
        private const val DEFAULT_LANG = "en"
        private const val MAX_DATA_ZIP_BYTES = 512L * 1024 * 1024
        private const val MAX_JSON_BYTES = 64 * 1024 * 1024
        private const val MAX_COVER_BYTES = 8 * 1024 * 1024
        private const val MAX_INLINE_COVER_CHARS = 256 * 1024

        /** Cover URL of a title whose cover LNReader kept only as a local file. */
        private const val LOCAL_COVER_URL = "https://lnreader-backup.invalid/cover/"

        private val json = Json { ignoreUnknownKeys = true }

        /** True for an LNReader backup: the outer archive with data.zip, or the data archive itself. */
        fun isLnReaderBackup(zip: ZipFile): Boolean =
            zip.getEntry(DATA_ZIP) != null ||
                zip.getEntry(VERSION_FILE) != null &&
                zip.entries().asSequence().any { it.name.startsWith("$NOVEL_DIR/") && it.name.endsWith(".json") }

        /**
         * The repository index of an LNReader plugin, from the address of its script on GitHub
         * (`https://raw.githubusercontent.com/<owner>/lnreader-plugins/<branch>/.js/...`).
         */
        internal fun repositoryUrl(artifactUrl: String?): String? {
            val uri = artifactUrl?.let { runCatching { URI(it) }.getOrNull() } ?: return null
            if (!uri.scheme.equals("https", ignoreCase = true) ||
                !uri.host.equals("raw.githubusercontent.com", ignoreCase = true)
            ) {
                return null
            }
            val segments = uri.path.orEmpty().split('/').filter(String::isNotEmpty)
            val owner = segments.getOrNull(0) ?: return null
            val repository = segments.getOrNull(1)?.takeIf { it.equals("lnreader-plugins", ignoreCase = true) } ?: return null
            val buildDirectory = segments.withIndex().firstOrNull { it.index >= 2 && it.value == ".js" }?.index ?: return null
            if (buildDirectory <= 2) return null
            val branch = segments.subList(2, buildDirectory).joinToString("/")
            return "https://raw.githubusercontent.com/$owner/$repository/$branch/.dist/plugins.min.json"
        }

        private fun repositoryName(repositoryUrl: String): String {
            val owner = runCatching { URI(repositoryUrl).path.split('/').firstOrNull(String::isNotEmpty) }.getOrNull()
                ?: return "LNReader plugins"
            return if (owner.equals("lnreader", ignoreCase = true)) "LNReader plugins" else "$owner plugins"
        }

        private fun localCoverUrl(novel: ParsedNovel): String =
            LOCAL_COVER_URL + URLEncoder.encode(novel.pluginId, "UTF-8") + "/" + URLEncoder.encode(novel.manga.url, "UTF-8")

        private fun isUsableCoverUrl(url: String): Boolean =
            url.startsWith("https://", ignoreCase = true) || url.startsWith("http://", ignoreCase = true) ||
                url.startsWith("data:image/", ignoreCase = true) && url.length <= MAX_INLINE_COVER_CHARS

        private fun normalizeAssetPath(path: String): String =
            path.removePrefix("file://").replace('\\', '/').trimStart('/').substringBefore('?').substringBefore('#')

        private fun titleFromPath(path: String): String? =
            path.substringBefore('?').substringBefore('#').split('/').lastOrNull { it.isNotBlank() }
                ?.replace(Regex("[-_]+"), " ")?.trim()
                ?.split(' ')?.joinToString(" ") { word -> word.replaceFirstChar { it.titlecase() } }
                ?.takeIf(String::isNotBlank)

        private fun statusOf(status: String?): Int = when (status) {
            "Ongoing" -> SManga.ONGOING
            "Completed" -> SManga.COMPLETED
            "Licensed" -> SManga.LICENSED
            "Publishing Finished" -> SManga.PUBLISHING_FINISHED
            "Cancelled" -> SManga.CANCELLED
            "On Hiatus" -> SManga.ON_HIATUS
            else -> SManga.UNKNOWN
        }

        private fun chapterProgress(value: JsonElement?): Double {
            val primitive = value as? JsonPrimitive ?: return 0.0
            val numeric = primitive.doubleOrNull
                ?: primitive.textOrNull()?.replace(Regex("^[^\\d.-]+"), "")?.toDoubleOrNull()
                ?: return 0.0
            return if (numeric.isFinite() && numeric > 0) (numeric / 100).coerceIn(0.0, 1.0) else 0.0
        }

        private fun looksLikeImage(bytes: ByteArray): Boolean {
            fun at(i: Int) = bytes[i].toInt() and 0xff
            return bytes.size >= 4 && (
                at(0) == 0xff && at(1) == 0xd8 && at(2) == 0xff ||
                    at(0) == 0x89 && at(1) == 0x50 && at(2) == 0x4e && at(3) == 0x47 ||
                    at(0) == 0x47 && at(1) == 0x49 && at(2) == 0x46 ||
                    bytes.size >= 12 && at(0) == 0x52 && at(1) == 0x49 && at(8) == 0x57 && at(9) == 0x45
                )
        }

        private fun JsonElement?.isTruthy(): Boolean {
            val primitive = this as? JsonPrimitive ?: return false
            return primitive.booleanOrNull == true || primitive.content == "1"
        }

        private fun JsonElement?.isFalsey(): Boolean {
            val primitive = this as? JsonPrimitive ?: return false
            return primitive.booleanOrNull == false || primitive.content == "0"
        }

        private fun JsonElement.textOrNull(): String? =
            (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.trim()?.takeIf(String::isNotEmpty)

        private fun JsonObject.text(key: String): String? = this[key]?.textOrNull()

        private fun JsonObject.number(key: String): Double? =
            (this[key] as? JsonPrimitive)?.takeUnless { it.isString }?.doubleOrNull

        private fun readAtMost(input: InputStream, maxBytes: Int): ByteArray {
            val output = java.io.ByteArrayOutputStream()
            copyAtMost(input, output, maxBytes.toLong())
            return output.toByteArray()
        }

        private fun copyAtMost(input: InputStream, output: OutputStream, maxBytes: Long) {
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0L
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                total += count
                require(total <= maxBytes) { "The LNReader backup is too large" }
                output.write(buffer, 0, count)
            }
        }
    }
}
