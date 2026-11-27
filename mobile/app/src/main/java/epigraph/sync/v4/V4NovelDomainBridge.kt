package epigraph.sync.v4

import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.novel.source.NovelSource
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import tachiyomi.data.Mangas
import yokai.data.Database
import yokai.data.DatabaseHandler
import kotlin.math.roundToLong

/** Projects LNReader catalog and reader state directly into Android's novel tables. */
internal class V4NovelDomainBridge(
    private val handler: DatabaseHandler,
    private val pluginLanguages: () -> Map<String, String>,
) : V4DomainBridge {
    override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock): List<V4OutgoingItem> =
        handler.await(inTransaction = true) { buildNovelDrafts().stamp(clock) }

    override suspend fun digestAffected(serverId: String, profileId: String, records: List<V4WireRecord>): List<V4DigestedItem> =
        if (records.none { it.domain == DOMAIN }) emptyList() else digestSnapshot(serverId, profileId)

    /** Side-effect free: hashes the same drafts the export stamps. */
    override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> =
        handler.await(inTransaction = true) {
            buildNovelDrafts().map { V4DigestedItem(it.key, V4LocalDigest.of(it), deleted = it.deleted) }
        }

    /** Pure read of the local novel library. Stamps no clocks and enqueues nothing. */
    private fun Database.buildNovelDrafts(): List<V4ItemDraft> {
            val languages = pluginLanguages()
            val works = localWorks(languages, favoritesOnly = true)
            val byId = works.associateBy { it.work._id }
            val folderRows = categoriesQueries.findAllBooks().executeAsList()
            val folderKeys = folderRows.associate { it._id to it.name.trim().lowercase() }
            val assignments = v4_syncQueries.selectV4FavoriteCategoryAssignments().executeAsList()
                .filter { it.manga_id in byId && it.category_id in folderKeys }
            val usedFolderIds = assignments.map { it.category_id }.toSet()
            val history = v4_syncQueries.selectV4FavoriteHistory().executeAsList().associateBy { it.history_chapter_id }

            return buildList<V4ItemDraft> {
                fun emit(type: String, key: String, payload: JsonObject) {
                    add(V4ItemDraft(domain = DOMAIN, entityType = type, entityKey = key, payload = payload))
                }
                for (folder in folderRows.filter { it._id in usedFolderIds }) {
                    emit(CATEGORY, folderKeys.getValue(folder._id), buildJsonObject {
                        put("name", folder.name)
                        put("order", folder.sort)
                    })
                }
                for (entry in works) {
                    val work = entry.work
                    val key = entry.key
                    emit(WORK, key, buildJsonObject {
                        put("pluginId", entry.plugin)
                        put("sourceLang", languages[entry.plugin] ?: "en")
                        put("url", work.url)
                        put("title", work.title)
                        put("author", work.author)
                        put("description", work.description)
                        put("genre", work.genre)
                        put("coverUrl", work.thumbnail_url)
                        put("favorite", true)
                        put("dateAdded", work.date_added)
                    })
                    val historyEntries = mutableListOf<JsonObject>()
                    for (chapter in chaptersQueries.getBackupChaptersByMangaId(work._id).executeAsList()) {
                        val chapterKey = V4PortableUrl.canonicalChapterKey(key, chapter.url)
                        emit(CHAPTER, chapterKey, buildJsonObject {
                            put("workKey", key)
                            put("url", chapter.url)
                            put("name", chapter.name)
                            put("chapterNumber", chapter.chapter_number)
                            put("sourceOrder", chapter.source_order)
                            put("isRead", chapter.read)
                            put("isBookmarked", chapter.bookmark)
                            put("progressPercent", (chapter.last_page_read / 100.0).coerceIn(0.0, 1.0))
                            put("dateUpload", chapter.date_upload)
                        })
                        history[chapter._id]?.let { visit ->
                            historyEntries += buildJsonObject {
                                put("chapterKey", chapterKey)
                                put("lastReadAtMs", visit.history_last_read)
                            }
                        }
                    }
                    val recent = historyEntries.maxByOrNull { it.long("lastReadAtMs") ?: 0 }
                    if (recent != null) {
                        emit(HISTORY, key, JsonObject(recent + ("historyEntries" to JsonArray(historyEntries))))
                    }
                }
                for (assignment in assignments) {
                    val workKey = byId.getValue(assignment.manga_id).key
                    val categoryKey = folderKeys.getValue(assignment.category_id)
                    emit(ASSIGNMENT, "$workKey|$categoryKey", buildJsonObject {
                        put("workKey", workKey)
                        put("categoryKey", categoryKey)
                    })
                }
                for (track in manga_syncQueries.getAll().executeAsList()) {
                    val entry = byId[track.manga_id] ?: continue
                    emit(TRACKING, "${entry.key}|${track.sync_id}", buildJsonObject {
                        put("workKey", entry.key)
                        put("trackerId", track.sync_id)
                        put("remoteId", track.remote_id)
                        put("libraryId", track.library_id)
                        put("title", track.title)
                        put("remoteUrl", track.remote_url)
                        put("lastChapterRead", track.last_chapter_read)
                        put("totalChapters", track.total_chapters)
                        put("score", track.score)
                        put("status", track.status)
                        put("startDate", track.start_date)
                        put("finishDate", track.finish_date)
                    })
                }
            }
    }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        val novels = records.filter { it.domain == DOMAIN }
        if (novels.isEmpty()) return
        handler.await(inTransaction = true) {
            val languages = pluginLanguages()
            val store = SqlDelightV4SyncStore(this)
            val local = localWorks(languages, favoritesOnly = false).associateTo(mutableMapOf()) { it.key to it.work._id }
            val localChapters = mutableMapOf<Long, MutableMap<String, Long>>()
            fun binding(type: String, key: String) =
                v4_syncQueries.selectV4EntityMapByKey(serverId, profileId, type, key).executeAsOneOrNull()

            fun chapters(key: String, work: Long) = localChapters.getOrPut(work) {
                chaptersQueries.getBackupChaptersByMangaId(work).executeAsList()
                    .sortedWith(compareBy({ it.read }, { it.bookmark }, { it.last_page_read }))
                    .associateTo(mutableMapOf()) { V4PortableUrl.canonicalChapterKey(key, it.url) to it._id }
            }

            for (record in novels.sortedWith(compareBy({ dependencyOrder(it.entityType) }, { it.serverSeq }))) {
                val type = record.entityType
                val key = record.entityKey
                val fields = record.payload as? JsonObject ?: JsonObject(emptyMap())
                val previous = binding(type, key)
                if (previous != null && record.hlc < V4Hlc(previous.hlc_ts_ms, previous.hlc_counter, previous.hlc_device_id)) continue
                val workKey = when (type) {
                    WORK, HISTORY -> key
                    CATEGORY -> ""
                    BOOKMARK -> fields.text("workKey") ?: key.substringBefore('|')
                    else -> fields.text("workKey") ?: key.substringBeforeLast('|')
                }
                val work = local[workKey] ?: binding(WORK, workKey)?.local_id?.toLongOrNull()
                val localId = when (type) {
                    WORK -> applyWork(record, fields, work, languages, wasBound = previous != null && previous.deleted == 0L)?.also { local[key] = it }
                    CATEGORY -> applyFolder(record, fields, previous?.local_id?.toLongOrNull())
                    else -> if (work == null) {
                        check(record.deleted || binding(WORK, workKey)?.deleted == 1L) { "Novel record is missing its work" }
                        null
                    } else {
                        when (type) {
                            CHAPTER -> applyChapter(record, fields, work, workKey, chapters(workKey, work))
                            BOOKMARK -> {
                                val chapterKey = fields.text("chapterKey") ?: key.substringBeforeLast('|')
                                val chapter = chapters(workKey, work)[chapterKey]
                                if (chapter != null) updateChapter(chapter, bookmark = !record.deleted)
                                chapter
                            }
                            HISTORY -> {
                                if (record.deleted) {
                                    historyQueries.getByMangaId(work).executeAsList().forEach {
                                        v4_syncQueries.clearV4HistoryTimestamp(it.history_chapter_id)
                                    }
                                } else {
                                    val visits = (fields["historyEntries"] as? JsonArray)?.filterIsInstance<JsonObject>() ?: listOf(fields)
                                    for (visit in visits) {
                                        val chapter = chapters(workKey, work)[visit.text("chapterKey")] ?: continue
                                        val whenRead = visit.long("lastReadAtMs") ?: continue
                                        historyQueries.upsertSyncedLastRead(chapter, whenRead)
                                    }
                                }
                                work
                            }
                            ASSIGNMENT -> {
                                val folder = binding(CATEGORY, fields.text("categoryKey") ?: key.substringAfterLast('|'))
                                if (folder != null && folder.deleted == 0L) {
                                    val category = checkNotNull(folder.local_id?.toLongOrNull())
                                    if (record.deleted) aethon_syncQueries.deleteMangaCategoryAssignment(work, category)
                                    else aethon_syncQueries.insertMangaCategoryAssignment(work, category)
                                }
                                work
                            }
                            TRACKING -> {
                                applyTracking(record, fields, work)
                                work
                            }
                            else -> error("Unsupported V4 novels record type $type")
                        }
                    }
                }
                store.upsertEntityMap(serverId, profileId, DOMAIN, type, key, localId?.toString(), record.hlc, record.deleted)
            }
        }
    }

    private fun Database.localWorks(languages: Map<String, String>, favoritesOnly: Boolean): List<NovelWork> {
        val installed = languages.entries.associate { (plugin, lang) -> NovelSource.sourceIdFor(plugin, lang) to plugin }
        val bindings = aethon_syncQueries.selectBoundNovelWorkBindings().executeAsList()
            .distinctBy { it.local_reference }.associate { it.local_reference?.toLongOrNull() to it.plugin_id }
        val rows = if (favoritesOnly) mangasQueries.findFavorites().executeAsList() else mangasQueries.findAll().executeAsList()
        return rows.mapNotNull { manga ->
            val plugin = bindings[manga._id] ?: installed[manga.source] ?: return@mapNotNull null
            NovelWork(manga, plugin, V4PortableUrl.canonicalWorkKey(plugin, manga.url))
        }
    }

    private fun Database.applyWork(
        record: V4WireRecord,
        fields: JsonObject,
        prior: Long?,
        languages: Map<String, String>,
        wasBound: Boolean,
    ): Long? {
        if (record.deleted) {
            if (wasBound) prior?.let(mangasQueries::markNotFavorite)
            return prior
        }
        val plugin = fields.text("pluginId") ?: record.entityKey.substringBefore(':')
        val url = fields.text("url") ?: fields.text("path")
        require(!url.isNullOrBlank() && V4PortableUrl.canonicalWorkKey(plugin, url) == record.entityKey)
        val sourceId = NovelSource.sourceIdFor(plugin, languages[plugin] ?: fields.text("sourceLang") ?: "en")
        val timestamp = record.updatedAtMs
        val favorite = fields.flag("favorite") ?: true
        val id = if (prior == null) {
            mangasQueries.insert(
                sourceId, url, null, fields.text("author"), fields.text("description"), fields.text("genre"),
                fields.text("title") ?: url, 0, fields.text("coverUrl"), favorite, null,
                true, 0, false, 0, fields.long("dateAdded") ?: timestamp, null, 0, 0, 0, 0, JsonObject(emptyMap()),
            )
            mangasQueries.selectLastInsertedRowId().executeAsOne()
        } else {
            mangasQueries.update(
                mangaId = prior, source = null, url = null, artist = null, author = fields.text("author"),
                description = fields.text("description"), genre = fields.text("genre"), title = fields.text("title"),
                status = null, thumbnailUrl = fields.text("coverUrl"), favorite = fields.flag("favorite"),
                lastUpdate = null, initialized = null, viewer = null, hideTitle = null, chapterFlags = null,
                dateAdded = fields.long("dateAdded"), filteredScanlators = null, updateStrategy = null,
                coverLastModified = null, nextUpdate = null, fetchInterval = null, memo = null,
            )
            prior
        }
        if (aethon_syncQueries.selectIdentityByLocalReference("NOVEL", id.toString()).executeAsOneOrNull() == null) {
            val ref = PortableWorkRef.Novel(plugin, ProviderOwnedKey(url))
            val portable = PortableIdentityV3.workId(ref)
            aethon_syncQueries.upsertIdentity(portable, "NOVEL", id.toString(), timestamp, timestamp)
            aethon_syncQueries.upsertPortableWorkBinding(
                portable, "LNREADER", null, plugin, url, plugin, id.toString(),
                "BOUND", null, fields.text("title"), plugin, 0, timestamp,
            )
        }
        return id
    }

    private fun Database.applyChapter(
        record: V4WireRecord,
        fields: JsonObject,
        work: Long,
        workKey: String,
        local: MutableMap<String, Long>,
    ): Long? {
        val prior = local[record.entityKey]
        if (record.deleted) {
            prior?.let { updateChapter(it, read = false, bookmark = false, progress = 0L) }
            return prior
        }
        val reading = fields.flag("isRead")
        val bookmark = fields.flag("isBookmarked")
        val progress = fields.number("progressPercent")?.let { (it.coerceIn(0.0, 1.0) * 100).roundToLong() }
        if (prior != null) {
            updateChapter(prior, reading, bookmark, progress)
            return prior
        }
        val url = checkNotNull(fields.text("url") ?: fields.text("path"))
        require(V4PortableUrl.canonicalChapterKey(workKey, url) == record.entityKey)
        chaptersQueries.insert(
            work, url, fields.text("name") ?: url, null, reading ?: false, bookmark ?: false,
            progress ?: 0, pagesLeft(progress) ?: 0, fields.number("chapterNumber") ?: -1.0,
            fields.long("sourceOrder") ?: 0, record.updatedAtMs, fields.long("dateUpload") ?: 0, JsonObject(emptyMap()),
        )
        return chaptersQueries.selectLastInsertedRowId().executeAsOne().also { local[record.entityKey] = it }
    }

    private fun Database.updateChapter(id: Long, read: Boolean? = null, bookmark: Boolean? = null, progress: Long? = null) {
        chaptersQueries.update(
            chapterId = id, mangaId = null, url = null, name = null, scanlator = null,
            read = read, bookmark = bookmark, lastPageRead = progress, pagesLeft = pagesLeft(progress),
            chapterNumber = null, sourceOrder = null, dateFetch = null, dateUpload = null, memo = null,
        )
    }

    private fun pagesLeft(progress: Long?) = progress?.let { if (it == 0L) 0L else 100 - it }

    private fun Database.applyFolder(record: V4WireRecord, fields: JsonObject, prior: Long?): Long? {
        val existing = categoriesQueries.findAllBooks().executeAsList().firstOrNull {
            it._id == prior || it.name.trim().lowercase() == record.entityKey
        }?._id
        if (record.deleted) {
            if (existing != null &&
                aethon_syncQueries.selectBookIdsByCategory(existing).executeAsList().isEmpty() &&
                aethon_syncQueries.selectMangaIdsByCategory(existing).executeAsList().isEmpty()
            ) {
                // Keep shared categories intact while any novel, comic, or book still uses them.
                categoriesQueries.delete(existing)
            }
            return existing
        }
        if (existing != null) {
            categoriesQueries.update(fields.text("name"), fields.long("order"), null, null, existing)
            return existing
        }
        categoriesQueries.insert(checkNotNull(fields.text("name")), fields.long("order") ?: 0, 0, "")
        return categoriesQueries.selectLastInsertedRowId().executeAsOne().also { aethon_syncQueries.upsertCategoryScope(it, "NOVEL") }
    }

    private fun Database.applyTracking(record: V4WireRecord, fields: JsonObject, work: Long) {
        val tracker = fields.long("trackerId") ?: record.entityKey.substringAfterLast('|').toLongOrNull() ?: return
        if (record.deleted) {
            manga_syncQueries.deleteForManga(work, tracker)
            return
        }
        manga_syncQueries.insert(
            work, tracker, checkNotNull(fields.long("remoteId")), fields.long("libraryId"), fields.text("title").orEmpty(),
            fields.number("lastChapterRead") ?: 0.0, fields.long("totalChapters") ?: 0, fields.long("status") ?: 0,
            fields.number("score") ?: 0.0, fields.text("remoteUrl").orEmpty(), fields.long("startDate") ?: 0, fields.long("finishDate") ?: 0,
        )
    }

    private data class NovelWork(val work: Mangas, val plugin: String, val key: String)

    private companion object {
        const val DOMAIN = "novels"
        const val WORK = "novel.work"
        const val CHAPTER = "novel.chapter"
        const val BOOKMARK = "novel.bookmark"
        const val HISTORY = "novel.history"
        const val CATEGORY = "novel.category"
        const val ASSIGNMENT = "novel.category_assignment"
        const val TRACKING = "novel.tracking"

        fun dependencyOrder(type: String) = when (type) {
            WORK, CATEGORY -> 0
            CHAPTER -> 1
            else -> 2
        }

        fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
        fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.longOrNull
        fun JsonObject.flag(key: String) = (this[key] as? JsonPrimitive)?.booleanOrNull
        fun JsonObject.number(key: String) = (this[key] as? JsonPrimitive)?.doubleOrNull?.takeIf(Double::isFinite)
    }
}
