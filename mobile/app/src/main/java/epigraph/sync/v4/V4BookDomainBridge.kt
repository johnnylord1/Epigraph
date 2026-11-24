package epigraph.sync.v4

import android.util.Log
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ReaderLocator
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import tachiyomi.data.Local_books
import yokai.data.Database
import yokai.data.DatabaseHandler
import java.io.File

internal data class V4BookCoverMetadata(val sha256: String, val byteSize: Long, val mimeType: String)

internal fun parseV4BookCoverMetadata(sha256: String?, byteSize: Long?, mimeType: String?): V4BookCoverMetadata? {
    if (sha256 == null || !Regex("[0-9a-f]{64}").matches(sha256)) return null
    if (byteSize == null || byteSize !in 1L..8_388_608L) return null
    if (mimeType == null || mimeType !in setOf("image/png", "image/webp", "image/jpeg")) return null
    return V4BookCoverMetadata(sha256, byteSize, mimeType)
}

/** Book metadata and reading state. Files remain in the content-addressed private storage. */
internal class V4BookDomainBridge(
    private val handler: DatabaseHandler,
    private val booksDirectory: File,
) : V4DomainBridge {
    private val json = V4CoreHttpClient.DEFAULT_JSON

    override suspend fun exportLocalSnapshot(serverId: String, profileId: String, clock: V4HlcClock): List<V4OutgoingItem> =
        handler.await(inTransaction = true) {
            val books = local_booksQueries.findAll().executeAsList()
            val folders = categoriesQueries.findAllBooks().executeAsList()
            val keys = folders.associate { it._id to it.name.trim().lowercase() }
            buildList {
                fun emit(type: String, key: String, payload: JsonObject) {
                    add(V4OutgoingItem(domain = "books", entityType = type, entityKey = key, hlc = clock.next(), payload = payload))
                }
                for (folder in folders) {
                    emit(CATEGORY, keys.getValue(folder._id), buildJsonObject {
                        put("name", folder.name)
                        put("order", folder.sort)
                    })
                }
                for (book in books) {
                    val key = book.sha256
                    emit(WORK, key, buildJsonObject {
                        put("title", book.display_name)
                        put("author", book.author)
                        put("description", book.description)
                        put("subtype", book.content_type.lowercase())
                        put("fileSha256", key)
                        put("byteSize", book.byte_size)
                        put("createdAtMs", book.imported_at)
                        put("updatedAtMs", book.updated_at)
                        put("chapterCount", book.chapter_count)
                        put("pageCount", book.page_count)
                        put("coverSha256", book.cover_asset_sha256)
                        put("coverByteSize", book.cover_asset_byte_size)
                        put("coverMimeType", book.cover_asset_mime_type)
                    })
                    val id = book.book_id
                    local_booksQueries.findProgress(id).executeAsOneOrNull()?.let { progress ->
                        emit(PROGRESS, key, buildJsonObject {
                            put("locator", json.parseToJsonElement(progress.locator_json))
                            put("progressPercent", progress.progression)
                            put("lastReadAtMs", progress.updated_at)
                        })
                    }
                    for (bookmark in local_booksQueries.findBookmarks(id).executeAsList()) {
                        emit(BOOKMARK, "$key|${bookmark.bookmark_id}", buildJsonObject {
                            put("locator", json.parseToJsonElement(bookmark.locator_json))
                            put("label", bookmark.label)
                            put("note", bookmark.note)
                            put("createdAtMs", bookmark.created_at)
                            put("updatedAtMs", bookmark.updated_at)
                        })
                    }
                    for (highlight in local_booksQueries.findHighlights(id).executeAsList()) {
                        emit(HIGHLIGHT, "$key|${highlight.highlight_id}", buildJsonObject {
                            put("startLocator", json.parseToJsonElement(highlight.start_locator_json))
                            put("endLocator", json.parseToJsonElement(highlight.end_locator_json))
                            put("selectedText", highlight.selected_text)
                            put("colorArgb", highlight.color_argb)
                            put("note", highlight.note)
                            put("createdAtMs", highlight.created_at)
                            put("updatedAtMs", highlight.updated_at)
                        })
                    }
                    for (folderId in local_booksQueries.findCategoryIds(id).executeAsList()) {
                        val folder = keys[folderId] ?: continue
                        emit(ASSIGNMENT, "$key|$folder", buildJsonObject { put("categoryKey", folder) })
                    }
                }
            }
        }

    override suspend fun applyRemoteRecords(serverId: String, profileId: String, records: List<V4WireRecord>) {
        val books = records.filter { it.domain == "books" }
        if (books.isEmpty()) return
        handler.await(inTransaction = true) {
            val store = SqlDelightV4SyncStore(this)
            val preservedUnboundBooks = mutableSetOf<String>()
            fun binding(type: String, key: String) =
                v4_syncQueries.selectV4EntityMapByKey(serverId, profileId, type, key).executeAsOneOrNull()

            for (record in books.sortedWith(compareBy({ it.entityType !in setOf(WORK, CATEGORY) }, { it.serverSeq }))) {
                val previous = binding(record.entityType, record.entityKey)
                if (previous != null && record.hlc < V4Hlc(previous.hlc_ts_ms, previous.hlc_counter, previous.hlc_device_id)) continue
                val payload = record.payload as? JsonObject ?: JsonObject(emptyMap())
                val key = record.entityKey
                val bookKey = key.substringBefore('|')
                if (record.entityType !in setOf(WORK, CATEGORY) && bookKey in preservedUnboundBooks) continue
                if (record.entityType == WORK && record.deleted && previous?.deleted != 0L &&
                    local_booksQueries.findBySha256(bookKey).executeAsOneOrNull() != null
                ) {
                    // An unbound Core tombstone may predate this device's local import. Preserve
                    // that publication and its child state until it has actually been V4-bound.
                    preservedUnboundBooks += bookKey
                }
                val localId = when (record.entityType) {
                    WORK -> applyWork(record, payload, previous?.deleted == 0L)
                    CATEGORY -> applyCategory(record, payload, previous?.local_id?.toLongOrNull())
                    else -> {
                        val book = local_booksQueries.findBySha256(bookKey).executeAsOneOrNull()
                        if (book == null) {
                            val alreadyDeleted = binding(WORK, bookKey)?.deleted == 1L
                            check(record.deleted || alreadyDeleted) { "V4 book record is missing its publication" }
                            null
                        } else if (record.deleted && binding(WORK, bookKey)?.deleted == 1L) {
                            book.book_id
                        } else {
                            val folderKey = key.substringAfter('|')
                            val folder = if (record.entityType == ASSIGNMENT) binding(CATEGORY, folderKey) else null
                            if (folder?.deleted != 1L) {
                                val folderId = folder?.local_id?.toLongOrNull() ?: if (record.entityType == ASSIGNMENT) {
                                    categoriesQueries.findAllBooks().executeAsList()
                                        .firstOrNull { it.name.trim().lowercase() == folderKey }?._id
                                } else null
                                applyBookChild(record, payload, book, folderId)
                            }
                            book.book_id
                        }
                    }
                }
                store.upsertEntityMap(
                    serverId, profileId, "books", record.entityType, key, localId, record.hlc, record.deleted,
                )
            }
        }
    }

    private fun Database.applyWork(record: V4WireRecord, payload: JsonObject, wasBound: Boolean): String? {
        val hash = record.entityKey
        require(HASH.matches(hash) && (payload.text("fileSha256") ?: hash) == hash)
        val query = local_booksQueries
        val prior = query.findBySha256(hash).executeAsOneOrNull()
        if (record.deleted) {
            if (wasBound) prior?.let { query.deleteById(it.book_id) }
            return prior?.book_id
        }
        val subtype = payload.text("subtype")?.lowercase() ?: prior?.content_type?.lowercase()
        require(subtype == "epub" || subtype == "pdf") { "Invalid V4 book subtype" }
        val id = prior?.book_id ?: "$subtype:sha256:$hash"
        val title = checkNotNull(payload.text("title") ?: prior?.display_name) { "V4 book is missing its title" }
        val modified = payload.long("updatedAtMs") ?: record.updatedAtMs
        val mime = if (subtype == "epub") "application/epub+zip" else "application/pdf"
        val bytes = payload.long("byteSize")?.coerceAtLeast(0) ?: prior?.byte_size ?: 0L
        val rawCoverSha = payload.text("coverSha256")
        val rawCoverBytes = payload.long("coverByteSize")
        val rawCoverMime = payload.text("coverMimeType")
        val coverFieldsPresent = rawCoverSha != null || rawCoverBytes != null || rawCoverMime != null
        val cover = parseV4BookCoverMetadata(rawCoverSha, rawCoverBytes, rawCoverMime)
        if (coverFieldsPresent && cover == null) {
            Log.w(TAG, "Ignoring incomplete or invalid V4 cover metadata for book $hash")
        }
        val coverSha = cover?.sha256
        val coverBytes = cover?.byteSize
        val coverMime = cover?.mimeType
        val coverPath = prior?.takeIf { coverSha != null && coverSha == it.cover_asset_sha256 }?.cover_path
        if (prior == null) {
            query.insert(
                bookId = id, contentType = subtype.uppercase(), sha256 = hash, displayName = title,
                author = payload.text("author"), description = payload.text("description"), coverPath = null,
                coverAssetSha256 = coverSha, coverAssetByteSize = coverBytes, coverAssetMimeType = coverMime,
                privatePath = File(File(booksDirectory, subtype), "$hash.$subtype").absolutePath,
                mimeType = mime, byteSize = bytes,
                chapterCount = payload.long("chapterCount"), pageCount = payload.long("pageCount"),
                importedAt = payload.long("createdAtMs") ?: modified, updatedAt = modified,
            )
        } else {
            query.updateMetadata(
                title,
                if ("author" in payload) payload.text("author") else prior.author,
                if ("description" in payload) payload.text("description") else prior.description,
                if (cover != null) coverPath else prior.cover_path,
                modified, id,
            )
            if (cover != null) query.updateCover(coverPath, coverSha, coverBytes, coverMime, modified, id)
            if ("chapterCount" in payload || "pageCount" in payload) {
                query.updateStructure(payload.long("chapterCount") ?: prior.chapter_count, payload.long("pageCount") ?: prior.page_count, modified, id)
            }
        }
        if (bytes > 0 && aethon_syncQueries.selectAssetManifest(hash).executeAsOneOrNull() == null) {
            aethon_syncQueries.insertAssetManifest(
                sha256 = hash, contentType = subtype.uppercase(), byteSize = bytes, mimeType = mime,
                localUri = null, remoteAvailable = true, state = "PENDING_DOWNLOAD", updatedAt = modified,
            )
        }
        return id
    }

    private fun Database.applyCategory(record: V4WireRecord, payload: JsonObject, bound: Long?): String? {
        val folders = categoriesQueries.findAllBooks().executeAsList()
        val current = folders.firstOrNull { it._id == bound }
            ?: folders.firstOrNull { it.name.trim().lowercase() == record.entityKey }
        if (record.deleted) {
            if (current != null) {
                for (book in aethon_syncQueries.selectBookIdsByCategory(current._id).executeAsList()) {
                    local_booksQueries.deleteCategory(book, current._id)
                }
                if (aethon_syncQueries.selectMangaIdsByCategory(current._id).executeAsList().isEmpty()) {
                    categoriesQueries.delete(current._id)
                }
            }
            return current?._id?.toString()
        }
        val id = if (current == null) {
            categoriesQueries.insert(checkNotNull(payload.text("name")), payload.long("order") ?: 0, 0, "")
            categoriesQueries.selectLastInsertedRowId().executeAsOne().also {
                aethon_syncQueries.upsertCategoryScope(it, "BOOK")
            }
        } else {
            categoriesQueries.update(payload.text("name"), payload.long("order"), null, null, current._id)
            current._id
        }
        return id.toString()
    }

    private fun Database.applyBookChild(record: V4WireRecord, payload: JsonObject, book: Local_books, category: Long?) {
        val query = local_booksQueries
        val id = book.book_id
        val child = record.entityKey.substringAfter('|')
        val updated = payload.long("updatedAtMs") ?: record.updatedAtMs
        val created = payload.long("createdAtMs") ?: updated
        when (record.entityType) {
            PROGRESS -> if (record.deleted) {
                query.deleteProgress(id)
            } else {
                val progress = (payload["progressPercent"] as? JsonPrimitive)?.doubleOrNull ?: 0.0
                require(progress.isFinite() && progress in 0.0..1.0)
                query.upsertConfirmedProgress(id, locator(payload, "locator", book), progress, payload.long("lastReadAtMs") ?: updated)
            }
            BOOKMARK -> if (record.deleted) {
                query.deleteBookmark(child)
            } else {
                query.upsertBookmark(child, id, locator(payload, "locator", book), payload.text("label"), payload.text("note"), created, updated)
            }
            HIGHLIGHT -> if (record.deleted) {
                query.deleteHighlight(child)
            } else {
                query.upsertHighlight(child, id, locator(payload, "startLocator", book), locator(payload, "endLocator", book),
                    checkNotNull(payload.text("selectedText")), payload.long("colorArgb") ?: 0L, payload.text("note"), created, updated)
            }
            ASSIGNMENT -> if (record.deleted) {
                category?.let { query.deleteCategory(id, it) }
            } else {
                query.insertCategory(id, checkNotNull(category) { "V4 book assignment is missing its folder" })
            }
            else -> error("Unsupported V4 books record type ${record.entityType}")
        }
    }

    private fun locator(payload: JsonObject, field: String, book: Local_books): String {
        val raw = checkNotNull(payload[field]) { "V4 book record is missing $field" }
        val decoded = json.decodeFromJsonElement(ReaderLocator.serializer(), raw)
        val id = EpigraphEntityId(book.book_id)
        require(decoded.contentType.name == book.content_type)
        val local = when (decoded) {
            is ReaderLocator.Pdf -> decoded.copy(entityId = id)
            is ReaderLocator.Epub -> decoded.copy(entityId = id)
            else -> error("V4 position is not a book locator")
        }
        return json.encodeToString(ReaderLocator.serializer(), local)
    }

    private companion object {
        const val TAG = "V4BookDomainBridge"
        val HASH = Regex("[0-9a-f]{64}")
        const val WORK = "book.work"
        const val PROGRESS = "book.progress"
        const val BOOKMARK = "book.bookmark"
        const val HIGHLIGHT = "book.highlight"
        const val CATEGORY = "book.category"
        const val ASSIGNMENT = "book.category_assignment"

        fun JsonObject.text(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
        fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.longOrNull
    }
}
