package epigraph.sync.v4

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import tachiyomi.data.Chapters
import tachiyomi.data.V4_entity_map
import yokai.data.Database
import yokai.data.DatabaseHandler

/** Projects portable comics into the library tables used by the reader and backup restore. */
internal class V4ComicDomainBridge(private val handler: DatabaseHandler) : V4DomainBridge {
    override suspend fun exportLocalSnapshot(
        serverId: String,
        profileId: String,
        clock: V4HlcClock,
    ): List<V4OutgoingItem> = handler.await(inTransaction = true) {
        exportAndRetract(serverId, profileId, clock, buildComicDrafts(scope = null))
    }

    /** One build feeds both the stamped export and the digests, so a pass reads the library once. */
    override suspend fun exportAndDigest(serverId: String, profileId: String, clock: V4HlcClock): V4ExportPass =
        handler.await(inTransaction = true) {
            val build = buildComicDrafts(scope = null)
            val outgoing = exportAndRetract(serverId, profileId, clock, build)
            V4ExportPass(outgoing, build.drafts.map { V4DigestedItem(it.key, V4LocalDigest.of(it), deleted = it.deleted) })
        }

    private fun Database.exportAndRetract(
        serverId: String,
        profileId: String,
        clock: V4HlcClock,
        build: ComicBuild,
    ): List<V4OutgoingItem> {
        val exported = build.drafts.stamp(clock)
        retractVanishedRelations(
            store = SqlDelightV4SyncStore(this),
            serverId = serverId,
            profileId = profileId,
            clock = clock,
            categoryIds = build.categoryIds,
            assignmentWorks = build.assignmentWorks,
            libraryWorks = build.libraryWorks,
            exportedWorks = exported.filter { it.entityType == WORK }.associate { it.entityKey to it.hlc },
        )
        return exported
    }

    /** Side-effect free: hashes the same drafts the export stamps, without clocks or tombstones. */
    override suspend fun digestSnapshot(serverId: String, profileId: String): List<V4DigestedItem> =
        handler.await(inTransaction = true) {
            buildComicDrafts(scope = null).drafts.map { V4DigestedItem(it.key, V4LocalDigest.of(it), deleted = it.deleted) }
        }

    /**
     * Digests only the works and folders that [records] name. Stored digests under those works that
     * no longer have a live row come back as tombstones, which covers cascades: a remote removal of
     * a work also drops its chapters, folders and tracking from the library.
     */
    override suspend fun digestAffected(
        serverId: String,
        profileId: String,
        records: List<V4WireRecord>,
    ): List<V4DigestedItem> {
        val comics = records.filter { it.domain == COMICS }
        if (comics.isEmpty()) return emptyList()
        return handler.await(inTransaction = true) {
            val scope = affectedScope(serverId, profileId, comics)
            val live = buildComicDrafts(scope).drafts
                .associate { it.key to V4DigestedItem(it.key, V4LocalDigest.of(it), deleted = it.deleted) }
            val absent = storedLiveKeys(serverId, profileId, scope)
                .filter { it !in live }
                .map { V4DigestedItem(it, digest = "", deleted = true) }
            live.values.toList() + absent
        }
    }

    /** The works and folders a delta can change, resolved to local work ids where this device has them. */
    private fun Database.affectedScope(serverId: String, profileId: String, records: List<V4WireRecord>): ComicScope {
        val workKeys = mutableSetOf<String>()
        val categoryKeys = mutableSetOf<String>()
        for (record in records) {
            val payload = record.payload as? JsonObject ?: JsonObject(emptyMap())
            when (record.entityType) {
                WORK, HISTORY -> workKeys += record.entityKey
                CATEGORY -> categoryKeys += record.entityKey
                CHAPTER, ASSIGNMENT, TRACKING ->
                    workKeys += payload.text("workKey") ?: record.entityKey.substringBeforeLast('|')
            }
        }
        if (categoryKeys.isNotEmpty()) {
            // A folder's removal or rename takes its assignments with it. The stored digests still list them.
            for (row in v4_syncQueries.selectV4LocalDigestsByType(serverId, profileId, COMICS, ASSIGNMENT).executeAsList()) {
                if (row.entity_key.substringAfterLast('|') in categoryKeys) {
                    workKeys += row.entity_key.substringBeforeLast('|')
                }
            }
        }
        val workIds = workKeys.mapNotNull { key ->
            v4_syncQueries.selectV4EntityMapByKey(serverId, profileId, WORK, key).executeAsOneOrNull()
                ?.local_id?.toLongOrNull()?.let { key to it }
        }.toMap()
        return ComicScope(workKeys = workKeys, workIds = workIds, categoryKeys = categoryKeys)
    }

    /** Live stored digest keys inside [scope], so the caller can tombstone the ones that no longer build. */
    private fun Database.storedLiveKeys(serverId: String, profileId: String, scope: ComicScope): Set<V4DigestKey> {
        val keys = HashSet<V4DigestKey>()
        for (workKey in scope.workKeys) {
            val prefix = "$workKey|"
            for (row in v4_syncQueries.selectV4LocalDigestsForWork(
                serverId = serverId,
                profileId = profileId,
                domain = COMICS,
                workKey = workKey,
                prefix = prefix,
            ).executeAsList()) {
                keys += V4DigestKey(COMICS, row.entity_type, row.entity_key)
            }
        }
        if (scope.categoryKeys.isNotEmpty()) {
            for (row in v4_syncQueries.selectV4LocalDigestsByType(serverId, profileId, COMICS, CATEGORY).executeAsList()) {
                if (row.entity_key in scope.categoryKeys) keys += V4DigestKey(COMICS, CATEGORY, row.entity_key)
            }
        }
        return keys
    }

    private class ComicBuild(
        val drafts: List<V4ItemDraft>,
        val categoryIds: Map<String, Long>,
        val assignmentWorks: Map<String, Long>,
        val libraryWorks: Map<String, Long>,
    )

    /**
     * The part of the library a delta names. [workIds] holds only the works this device has locally;
     * [workKeys] also covers works it does not, so their stored digests can still be tombstoned.
     */
    private class ComicScope(
        val workKeys: Set<String>,
        val workIds: Map<String, Long>,
        val categoryKeys: Set<String>,
    )

    /**
     * Pure read of the local comics library, or of the part [scope] names (null = whole library).
     * Stamps no clocks and enqueues nothing.
     */
    private fun Database.buildComicDrafts(scope: ComicScope?): ComicBuild {
        val workIds = scope?.workIds?.values?.toList()
        val works = if (workIds == null) {
            v4_syncQueries.selectV4ComicWorks(favoritesOnly = 1).executeAsList()
        } else {
            workIds.mapNotNull { v4_syncQueries.selectV4ComicWorkById(it).executeAsOneOrNull() }
        }
        val chapterRows = if (workIds == null) {
            v4_syncQueries.selectV4FavoriteChapters().executeAsList()
        } else {
            workIds.flatMap { v4_syncQueries.selectV4FavoriteChaptersForManga(it).executeAsList() }
        }
        val assignmentRows = if (workIds == null) {
            v4_syncQueries.selectV4FavoriteCategoryAssignments().executeAsList()
        } else {
            workIds.flatMap { v4_syncQueries.selectV4FavoriteCategoryAssignmentsForManga(it).executeAsList() }
        }
        val historyRows = if (workIds == null) {
            v4_syncQueries.selectV4FavoriteHistory().executeAsList()
        } else {
            workIds.flatMap { v4_syncQueries.selectV4FavoriteHistoryForManga(it).executeAsList() }
        }
        val trackRows = if (workIds == null) {
            manga_syncQueries.getAll().executeAsList()
        } else {
            workIds.flatMap { manga_syncQueries.getAllByMangaId(it).executeAsList() }
        }
        // Default and Completed are each app's own folders, so neither side exports them.
        val categories = categoriesQueries.findAllComics().executeAsList()
            .filterNot { it._id == 0L || isReservedCategory(it.name) }
        val workKeys = works.associate { it._id to V4PortableUrl.canonicalWorkKey(it.source.toString(), it.url) }
        // The desktop names a folder by its lowercase name, so a rename is a new key there too.
        val categoryKeys = categories.associate { it._id to categoryKey(it.name) }
        val assignmentWorks = mutableMapOf<String, Long>()
        val chapterKeys = mutableMapOf<Long, String>()
        val chaptersToWorks = mutableMapOf<Long, String>()

        val drafts = buildList<V4ItemDraft> {
            fun emit(type: String, key: String, payload: JsonObject) {
                add(V4ItemDraft(domain = COMICS, entityType = type, entityKey = key, payload = payload))
            }

            for (work in works) {
                emit(WORK, workKeys.getValue(work._id), buildJsonObject {
                    put("sourceId", work.source.toString())
                    put("url", work.url)
                    put("title", work.title)
                    put("favorite", work.favorite)
                    put("artist", work.artist)
                    put("author", work.author)
                    put("description", work.description)
                    put("genre", work.genre)
                    put("status", work.status)
                    put("thumbnailUrl", work.thumbnail_url)
                    put("initialized", work.initialized)
                    put("dateAdded", work.date_added)
                    put("chapterFlags", work.chapter_flags)
                    put("viewerFlags", work.viewer)
                })
            }
            for (category in categories.filter { scope == null || categoryKey(it.name) in scope.categoryKeys }) {
                emit(CATEGORY, categoryKeys.getValue(category._id), buildJsonObject {
                    put("name", category.name)
                    put("order", category.sort)
                    put("flags", category.flags)
                })
            }
            val portableChapters = linkedMapOf<String, Chapters>()
            for (chapter in chapterRows) {
                val workKey = workKeys[chapter.manga_id] ?: continue
                val key = V4PortableUrl.canonicalChapterKey(workKey, chapter.url)
                chapterKeys[chapter._id] = key
                chaptersToWorks[chapter._id] = workKey
                val known = portableChapters[key]
                portableChapters[key] = if (known == null) {
                    chapter
                } else {
                    known.copy(
                        read = known.read || chapter.read,
                        bookmark = known.bookmark || chapter.bookmark,
                        last_page_read = maxOf(known.last_page_read, chapter.last_page_read),
                    )
                }
            }
            for ((key, chapter) in portableChapters) {
                emit(CHAPTER, key, buildJsonObject {
                    put("workKey", workKeys.getValue(chapter.manga_id))
                    put("url", chapter.url)
                    put("name", chapter.name)
                    put("scanlator", chapter.scanlator)
                    put("isRead", chapter.read)
                    put("isBookmarked", chapter.bookmark)
                    put("lastPageRead", chapter.last_page_read)
                    put("chapterNumber", chapter.chapter_number)
                    put("sourceOrder", chapter.source_order)
                    put("dateFetch", chapter.date_fetch)
                    put("dateUpload", chapter.date_upload)
                })
            }
            for (assignment in assignmentRows) {
                val workKey = workKeys[assignment.manga_id] ?: continue
                val categoryKey = categoryKeys[assignment.category_id] ?: continue
                assignmentWorks["$workKey|$categoryKey"] = assignment.manga_id
                emit(ASSIGNMENT, "$workKey|$categoryKey", buildJsonObject {
                    put("workKey", workKey)
                    put("categoryKey", categoryKey)
                })
            }
            val latestByWork = historyRows
                .filter { it.history_chapter_id in chaptersToWorks }
                .sortedWith(compareByDescending<tachiyomi.data.History> { it.history_last_read }.thenByDescending { it.history_id })
                .distinctBy { chaptersToWorks[it.history_chapter_id] }
            for (history in latestByWork) {
                val workKey = chaptersToWorks.getValue(history.history_chapter_id)
                emit(HISTORY, workKey, buildJsonObject {
                    put("workKey", workKey)
                    put("chapterKey", chapterKeys.getValue(history.history_chapter_id))
                    put("lastReadAtMs", history.history_last_read)
                })
            }
            for (track in trackRows) {
                val workKey = workKeys[track.manga_id] ?: continue
                emit(TRACKING, "$workKey|${track.sync_id}", buildJsonObject {
                    put("workKey", workKey)
                    put("trackerId", track.sync_id)
                    put("remoteId", track.remote_id)
                    put("libraryId", track.library_id)
                    put("title", track.title)
                    put("lastChapterRead", track.last_chapter_read)
                    put("totalChapters", track.total_chapters)
                    put("status", track.status)
                    put("score", track.score)
                    put("remoteUrl", track.remote_url)
                    put("startDate", track.start_date)
                    put("finishDate", track.finish_date)
                })
            }
        }
        return ComicBuild(
            drafts = drafts,
            categoryIds = categoryKeys.entries.associate { (id, key) -> key to id },
            assignmentWorks = assignmentWorks,
            libraryWorks = workKeys.entries.associate { (id, key) -> key to id },
        )
    }

    /**
     * Sends a tombstone for each work, folder and folder assignment this device synced before
     * but no longer has, which is how a removal from the library, a folder delete, a rename or
     * a removal from a folder reaches the Core. Only rows this device projected or exported
     * count, so a record it never held stays alone. The tombstones go through the outbox, which
     * keeps them until the Core accepts them.
     */
    private fun Database.retractVanishedRelations(
        store: SqlDelightV4SyncStore,
        serverId: String,
        profileId: String,
        clock: V4HlcClock,
        categoryIds: Map<String, Long>,
        assignmentWorks: Map<String, Long>,
        libraryWorks: Map<String, Long>,
        exportedWorks: Map<String, V4Hlc>,
    ) {
        val all = v4_syncQueries.selectV4DomainEntityMap(serverId, profileId, COMICS).executeAsList()
            .filter { it.entity_type == WORK || it.entity_type == CATEGORY || it.entity_type == ASSIGNMENT }
        val rows = all.filter { it.deleted == 0L }
        val known = rows.associateBy { it.entity_type to it.entity_key }
        val retracted = all.filter { it.deleted != 0L }.mapTo(mutableSetOf()) { it.entity_type to it.entity_key }
        // Remember what this device exported. The zero clock never outranks a remote record.
        fun remember(type: String, key: String, localId: Long) {
            val current = known[type to key]
            if (current?.local_id == localId.toString() || type == WORK && current != null) return
            // A work added back after its removal synced must outrank that removal's echo,
            // which would otherwise take it out of the library again.
            val hlc = if (type == WORK && (type to key) in retracted) exportedWorks[key] ?: EXPORTED else EXPORTED
            store.upsertEntityMap(serverId, profileId, COMICS, type, key, localId.toString(), hlc, deleted = false)
        }
        libraryWorks.forEach { (key, id) -> remember(WORK, key, id) }
        categoryIds.forEach { (key, id) -> remember(CATEGORY, key, id) }
        assignmentWorks.forEach { (key, work) -> remember(ASSIGNMENT, key, work) }

        for (row in rows) {
            val key = row.entity_key
            if (row.local_id == null) continue
            val retract = when (row.entity_type) {
                // The desktop takes the work out of its library, whichever of its folders holds it.
                WORK -> key !in libraryWorks
                CATEGORY -> key !in categoryIds && !isReservedCategory(key)
                else -> {
                    val workKey = key.substringBeforeLast('|')
                    val folder = key.substringAfterLast('|')
                    // A work that left the library keeps its folders until that removal syncs.
                    key !in assignmentWorks && !isReservedCategory(folder) &&
                        (workKey in libraryWorks || folder !in categoryIds)
                }
            }
            if (!retract) continue
            val hlc = clock.next()
            // The desktop finds the folder to delete by this name.
            val payload = if (row.entity_type == CATEGORY) buildJsonObject { put("name", key) } else JsonObject(emptyMap())
            store.enqueueOutbox(serverId, profileId, COMICS, row.entity_type, key, deleted = true, hlc = hlc, payload = payload)
            store.upsertEntityMap(serverId, profileId, COMICS, row.entity_type, key, row.local_id, hlc, deleted = true)
        }
    }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        val comics = records.filter { it.domain == COMICS }
        if (comics.isEmpty()) return
        handler.await(inTransaction = true) {
            val projection = Projection(this, serverId, profileId, preload = comics.size >= 500)
            // Materialize dependencies before applying their relations. Within a type the
            // server order matters, including when a merge keeps the same outer HLC.
            for (record in comics.sortedWith(compareBy({ dependencyOrder(it.entityType) }, { it.serverSeq }))) {
                projection.apply(record)
            }
        }
    }

    private class Projection(
        private val database: Database,
        private val serverId: String,
        private val profileId: String,
        private val preload: Boolean,
    ) {
        private val store = SqlDelightV4SyncStore(database)
        private val bindings = mutableMapOf<Pair<String, String>, Binding?>()

        init {
            if (preload) {
                database.v4_syncQueries.selectV4DomainEntityMap(serverId, profileId, COMICS).executeAsList()
                    .associateTo(bindings) { (it.entity_type to it.entity_key) to it.toBinding() }
            }
        }

        private fun binding(type: String, key: String): Binding? {
            val identity = type to key
            if (preload || identity in bindings) return bindings[identity]
            return database.v4_syncQueries.selectV4EntityMapByKey(serverId, profileId, type, key)
                .executeAsOneOrNull()?.toBinding().also { bindings[identity] = it }
        }
        private val works by lazy {
            database.v4_syncQueries.selectV4ComicWorks(favoritesOnly = 0).executeAsList()
                .sortedWith(compareBy({ it.favorite }, { it._id }))
                .associateTo(mutableMapOf()) { V4PortableUrl.canonicalWorkKey(it.source.toString(), it.url) to it._id }
        }
        private val categories by lazy {
            database.categoriesQueries.findAllComics().executeAsList()
                .filterNot { it._id == 0L || isReservedCategory(it.name) }
                .associateTo(mutableMapOf()) { categoryKey(it.name) to it._id }
        }
        private val chaptersByWork = mutableMapOf<Long, MutableMap<String, Chapters>>()

        fun apply(record: V4WireRecord) {
            val identity = record.entityType to record.entityKey
            val previous = binding(record.entityType, record.entityKey)
            if (previous != null && record.hlc < previous.hlc) return
            val payload = record.payload as? JsonObject ?: JsonObject(emptyMap())
            val localId = when (record.entityType) {
                WORK -> applyWork(record, payload, previous?.localId, wasBound = previous != null && !previous.deleted)
                CATEGORY -> applyCategory(record, payload)
                CHAPTER -> applyChapter(record, payload, previous?.localId)
                ASSIGNMENT -> applyAssignment(record, payload)
                HISTORY -> applyHistory(record, payload, previous?.localId)
                TRACKING -> applyTracking(record, payload)
                else -> error("Unsupported V4 comics record type ${record.entityType}")
            } ?: previous?.localId
            store.upsertEntityMap(serverId, profileId, COMICS, record.entityType, record.entityKey, localId?.toString(), record.hlc, record.deleted)
            bindings[identity] = Binding(localId, record.hlc, record.deleted)
        }

        private fun applyWork(record: V4WireRecord, payload: JsonObject, bound: Long?, wasBound: Boolean): Long? {
            val key = record.entityKey
            val current = bound?.let { database.mangasQueries.findById(it).executeAsOneOrNull()?._id } ?: works[key]
            val query = database.mangasQueries
            if (record.deleted) {
                if (wasBound) current?.let(query::markNotFavorite)
                return current
            }
            val url = payload.text("url") ?: payload.text("workUrl")
            val source = payload.long("sourceId")
            if (url != null && source != null) {
                require(source != 0L && V4PortableUrl.canonicalWorkKey(source.toString(), url) == key)
            }
            if (current == null) {
                require(!url.isNullOrBlank() && source != null) { "Comics work is missing source or URL" }
                query.insert(
                    source = source, url = url, title = payload.text("title") ?: url,
                    artist = payload.text("artist"), author = payload.text("author"), description = payload.text("description"),
                    genre = payload.text("genre"), status = payload.long("status") ?: 0L,
                    thumbnailUrl = payload.text("thumbnailUrl"), favorite = payload.bool("favorite") ?: true,
                    lastUpdate = null, initialized = payload.bool("initialized") ?: false,
                    viewer = payload.long("viewerFlags") ?: 0L, hideTitle = false, chapterFlags = payload.long("chapterFlags") ?: 0L,
                    dateAdded = payload.long("dateAdded"), filteredScanlators = null, updateStrategy = 0,
                    coverLastModified = 0, nextUpdate = 0, fetchInterval = 0, memo = JsonObject(emptyMap()),
                )
                return query.selectLastInsertedRowId().executeAsOne().also { works[key] = it }
            }
            query.update(
                mangaId = current, source = null, url = null,
                artist = payload.text("artist"), author = payload.text("author"), description = payload.text("description"),
                genre = payload.text("genre"), title = payload.text("title"), status = payload.long("status"),
                thumbnailUrl = payload.text("thumbnailUrl"), favorite = payload.bool("favorite"),
                lastUpdate = null, initialized = payload.bool("initialized"),
                viewer = payload.long("viewerFlags"), hideTitle = null, chapterFlags = payload.long("chapterFlags"),
                dateAdded = payload.long("dateAdded"), filteredScanlators = null, updateStrategy = null,
                coverLastModified = null, nextUpdate = null, fetchInterval = null, memo = null,
            )
            return current
        }

        private fun applyCategory(record: V4WireRecord, payload: JsonObject): Long? {
            val key = record.entityKey
            if (isReservedCategory(key) || payload.text("name")?.let(::isReservedCategory) == true) {
                return null
            }
            // A folder's key is its name, so the bound row can be a folder renamed since then.
            // Deleting through it would remove the renamed folder when the old key's tombstone
            // comes back from the Core.
            val current = categories[key]
            val query = database.categoriesQueries
            if (record.deleted) {
                current?.let(query::delete)
                categories.values.removeAll { it == current }
                return null
            }
            val name = payload.text("name")
            if (current == null) {
                require(!name.isNullOrBlank()) { "Comics category is missing its name" }
                query.insert(name, payload.long("order") ?: 0, payload.long("flags") ?: 0, "")
                return query.selectLastInsertedRowId().executeAsOne().also { categories[key] = it }
            }
            query.update(name, payload.long("order"), payload.long("flags"), null, current)
            categories[key] = current
            return current
        }

        private fun applyChapter(record: V4WireRecord, payload: JsonObject, bound: Long?): Long? {
            val key = record.entityKey
            val workKey = payload.text("workKey") ?: key.substringBeforeLast('|')
            val workId = workId(workKey)
            if (workId == null && (record.deleted || workWasDeleted(workKey))) return null
            checkNotNull(workId) { "Comics chapter is missing its work" }
            val query = database.chaptersQueries
            // An existing binding is safe only while its chapter belongs to this work.
            val boundChapter = bound?.let {
                query.getChaptersById(it).executeAsOneOrNull()?.takeIf { it.manga_id == workId }
            }
            val current = boundChapter?._id ?: chaptersFor(workId, workKey)[key]?._id
            if (record.deleted) {
                // Leave the local catalog and download intact. Clear portable reader state.
                current?.let { updateChapter(it, JsonObject(emptyMap()), reset = true) }
                return current
            }
            val url = payload.text("url") ?: payload.text("chapterUrl")
            if (url != null) require(V4PortableUrl.canonicalChapterKey(workKey, url) == key)
            if (current != null) {
                updateChapter(current, payload, reset = false)
                return current
            }
            require(!url.isNullOrBlank()) { "Comics chapter is missing its URL" }
            query.insert(
                mangaId = workId, url = url, name = payload.text("name") ?: url,
                scanlator = payload.text("scanlator"), read = payload.bool("isRead") ?: false,
                bookmark = payload.bool("isBookmarked") ?: false, lastPageRead = payload.long("lastPageRead") ?: 0L,
                pagesLeft = 0L, chapterNumber = payload.number("chapterNumber") ?: -1.0,
                sourceOrder = payload.long("sourceOrder") ?: 0L, dateFetch = payload.long("dateFetch") ?: 0L,
                dateUpload = payload.long("dateUpload") ?: 0L, memo = JsonObject(emptyMap()),
            )
            return query.selectLastInsertedRowId().executeAsOne()
        }

        private fun updateChapter(id: Long, payload: JsonObject, reset: Boolean) {
            database.chaptersQueries.update(
                chapterId = id, mangaId = null, url = null, name = payload.text("name"), scanlator = payload.text("scanlator"),
                read = if (reset) false else payload.bool("isRead"), bookmark = if (reset) false else payload.bool("isBookmarked"),
                lastPageRead = if (reset) 0L else payload.long("lastPageRead"), pagesLeft = null,
                chapterNumber = payload.number("chapterNumber"), sourceOrder = payload.long("sourceOrder"),
                dateFetch = payload.long("dateFetch"), dateUpload = payload.long("dateUpload"), memo = null,
            )
        }

        private fun applyAssignment(record: V4WireRecord, payload: JsonObject): Long? {
            val workKey = payload.text("workKey") ?: record.entityKey.substringBeforeLast('|')
            val categoryKey = payload.text("categoryKey") ?: record.entityKey.substringAfterLast('|')
            val work = workId(workKey)
            if (isReservedCategory(categoryKey)) return work
            val categoryBinding = binding(CATEGORY, categoryKey)
            // Deleting the category removes its rows from mangas_categories. A snapshot
            // can still contain an assignment created before the category was deleted.
            if (categoryBinding?.deleted == true) return work
            if (work == null && workWasDeleted(workKey)) return null
            val category = categories[categoryKey]
            if (record.deleted) {
                if (work != null && category != null) {
                    database.aethon_syncQueries.deleteMangaCategoryAssignment(work, category)
                }
            } else {
                checkNotNull(work) { "Comics category assignment is missing its work" }
                checkNotNull(category) { "Comics category assignment is missing its category" }
                database.aethon_syncQueries.insertMangaCategoryAssignment(work, category)
            }
            return work
        }

        private fun applyHistory(record: V4WireRecord, payload: JsonObject, bound: Long?): Long? {
            val chapterKey = payload.text("chapterKey")
            val chapter = chapterKey?.let { key ->
                binding(CHAPTER, key)?.localId
                    ?: workId(record.entityKey)?.let { chaptersFor(it, record.entityKey)[key]?._id }
            } ?: bound
            if (chapter == null && workWasDeleted(record.entityKey)) return null
            if (record.deleted) {
                val work = workId(record.entityKey)
                if (work != null) {
                    database.historyQueries.getByMangaId(work).executeAsList().forEach {
                        database.v4_syncQueries.clearV4HistoryTimestamp(it.history_chapter_id)
                    }
                }
                return chapter
            }
            checkNotNull(chapter) { "Comics history is missing its chapter" }
            val lastRead = checkNotNull(payload.long("lastReadAtMs")) { "Comics history is missing its timestamp" }
            database.historyQueries.upsertSyncedLastRead(chapter, lastRead)
            return chapter
        }

        private fun applyTracking(record: V4WireRecord, payload: JsonObject): Long? {
            val workKey = payload.text("workKey") ?: record.entityKey.substringBeforeLast('|')
            val tracker = payload.long("trackerId") ?: record.entityKey.substringAfterLast('|').toLongOrNull()
            val work = workId(workKey)
            if (work == null && workWasDeleted(workKey)) return null
            val query = database.manga_syncQueries
            if (record.deleted) {
                if (work != null && tracker != null) query.deleteForManga(work, tracker)
                return work
            }
            checkNotNull(work) { "Comics tracking is missing its work" }
            checkNotNull(tracker) { "Comics tracking is missing its tracker" }
            val current = query.getAllByMangaId(work).executeAsList().firstOrNull { it.sync_id == tracker }
            if (current == null) {
                val remoteId = checkNotNull(payload.long("remoteId")) { "Comics tracking is missing its remote ID" }
                query.insert(
                    work, tracker, remoteId, payload.long("libraryId"), payload.text("title").orEmpty(),
                    payload.number("lastChapterRead") ?: 0.0, payload.long("totalChapters") ?: 0,
                    payload.long("status") ?: 0, payload.number("score") ?: 0.0, payload.text("remoteUrl").orEmpty(),
                    payload.long("startDate") ?: 0, payload.long("finishDate") ?: 0,
                )
            } else {
                query.update(
                    id = current._id, mangaId = null, syncId = null, remoteId = payload.long("remoteId"),
                    libraryId = payload.long("libraryId"), title = payload.text("title"), lastChapterRead = payload.number("lastChapterRead"),
                    totalChapters = payload.long("totalChapters"), status = payload.long("status"), score = payload.number("score"),
                    remoteUrl = payload.text("remoteUrl"), startDate = payload.long("startDate"), finishDate = payload.long("finishDate"),
                )
            }
            return work
        }

        private fun workId(key: String): Long? = binding(WORK, key)?.localId ?: works[key]

        private fun workWasDeleted(key: String): Boolean = binding(WORK, key)?.deleted == true

        private fun chaptersFor(workId: Long, workKey: String) = chaptersByWork.getOrPut(workId) {
            database.chaptersQueries.getBackupChaptersByMangaId(workId).executeAsList()
                .sortedWith(compareBy({ it.read }, { it.bookmark }, { it.last_page_read }, { it._id }))
                .associateByTo(mutableMapOf()) { V4PortableUrl.canonicalChapterKey(workKey, it.url) }
        }
    }

    private data class Binding(val localId: Long?, val hlc: V4Hlc, val deleted: Boolean)

    companion object {
        private const val COMICS = "comics"
        private const val WORK = "comic.work"
        private const val CHAPTER = "comic.chapter"
        private const val CATEGORY = "comic.category"
        private const val ASSIGNMENT = "comic.category_assignment"
        private const val HISTORY = "comic.history"
        private const val TRACKING = "comic.tracking"

        private val EXPORTED = V4Hlc(tsMs = 0L, counter = 0L, deviceId = "")

        private fun categoryKey(name: String): String = name.trim().lowercase()
        private fun isReservedCategory(key: String) = categoryKey(key).let { it == "completed" || it == "default" }
        private fun dependencyOrder(type: String): Int = when (type) {
            WORK, CATEGORY -> 0
            CHAPTER -> 1
            else -> 2
        }

        private fun V4_entity_map.toBinding() =
            Binding(local_id?.toLongOrNull(), V4Hlc(hlc_ts_ms, hlc_counter, hlc_device_id), deleted != 0L)
        private fun JsonObject.primitive(key: String) = this[key] as? JsonPrimitive
        private fun JsonObject.text(key: String) = primitive(key)?.contentOrNull
        private fun JsonObject.long(key: String) = primitive(key)?.longOrNull
        private fun JsonObject.number(key: String) = primitive(key)?.doubleOrNull?.takeIf(Double::isFinite)
        private fun JsonObject.bool(key: String) = primitive(key)?.booleanOrNull
    }
}
