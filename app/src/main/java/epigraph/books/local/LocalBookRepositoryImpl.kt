package epigraph.books.local

import epigraph.contract.ContentType
import epigraph.contract.BookEntrySnapshot
import epigraph.contract.ReaderLocator
import epigraph.books.importing.BookCoverMaterializer
import epigraph.books.importing.BookImportMetadataExtractor
import epigraph.books.reader.BookStructureInspector
import epigraph.sync.EpigraphBookMutationRouter
import epigraph.sync.BookBookmarkMutation
import epigraph.sync.BookHighlightMutation
import java.io.File
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.longOrNull
import yokai.data.DatabaseHandler

class LocalBookRepositoryImpl(
    private val handler: DatabaseHandler,
    private val mutations: EpigraphBookMutationRouter,
    private val json: Json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
    },
    private val privateStorageDirectory: File? = null,
    private val structureInspector: BookStructureInspector? = null,
) : LocalBookRepository {
    private val coverMaterializer: BookCoverMaterializer? = privateStorageDirectory?.let(::BookCoverMaterializer)
    override fun observeBooks(): Flow<List<LocalBook>> =
        handler.subscribeToList { local_booksQueries.findAll(::mapBook) }.withRemoteAvailability()

    override fun observeBooks(contentType: ContentType): Flow<List<LocalBook>> =
        handler.subscribeToList {
            local_booksQueries.findAllByType(contentType.name, ::mapBook)
        }.withRemoteAvailability()

    private fun Flow<List<LocalBook>>.withRemoteAvailability(): Flow<List<LocalBook>> =
        combine(handler.subscribeToList { aethon_syncQueries.selectRemoteAvailableBookShas() }) { books, remote ->
            val remoteShas = remote.toHashSet()
            books.map { book -> if (book.sha256 in remoteShas) book.copy(remoteAvailable = true) else book }
        }

    override suspend fun find(bookId: String): LocalBook? = handler.await(inTransaction = true) {
        val current = local_booksQueries.findById(bookId).executeAsOneOrNull() ?: return@await null
        // A reader inspection must never erase a richer TOC received from the confirmed Core
        // replica. Repair devices that opened a synchronized PDF with the old one-document
        // fallback before returning the book to details/reader code.
        val confirmed = aethon_syncQueries.selectCoreReplicaRecord(
            scopeId = BOOK_SCOPE,
            entityType = BOOK_ENTRY_TYPE,
            entityId = bookId,
        ).executeAsOneOrNull()
        val payload = confirmed?.record_json?.let { encoded ->
            runCatching { json.parseToJsonElement(encoded) as? JsonObject }.getOrNull()
        }
        val confirmedChapters = payload.structureCount("tocCount", "spineCount", "sectionCount")
        val confirmedPages = payload.structureCount("pageCount")
        val chapterCount = maxOf(current.chapter_count ?: 0L, confirmedChapters ?: 0L).takeIf { it > 0 }
        val pageCount = maxOf(current.page_count ?: 0L, confirmedPages ?: 0L).takeIf { it > 0 }
        if (chapterCount != current.chapter_count || pageCount != current.page_count) {
            local_booksQueries.updateStructure(
                chapterCount = chapterCount,
                pageCount = pageCount,
                updatedAt = current.updated_at,
                bookId = bookId,
            )
        }
        val remoteAvailable = aethon_syncQueries.selectAssetManifest(current.sha256)
            .executeAsOneOrNull()?.remote_available == true
        local_booksQueries.findById(bookId, ::mapBook).executeAsOne().copy(
            pdfSections = payload?.pdfSections().orEmpty(),
            remoteAvailable = remoteAvailable,
        )
    }

    override suspend fun findBySha256(sha256: String): LocalBook? =
        handler.awaitOneOrNull { local_booksQueries.findBySha256(sha256, ::mapBook) }

    override suspend fun snapshotForBackup(): List<LocalBookBackupSnapshot> {
        val books = handler.awaitList { local_booksQueries.findAll(::mapBook) }
        return books.map { book ->
            LocalBookBackupSnapshot(
                book = book,
                progress = getProgress(book.bookId),
                bookmarks = getBookmarks(book.bookId),
                highlights = getHighlights(book.bookId),
                categoryIds = getCategoryIds(book.bookId),
            )
        }
    }

    override suspend fun restoreMissing(entry: LocalBookRestoreEntry): LocalBook {
        val root = privateStorageDirectory?.absoluteFile
            ?: error("Local-book backup restore requires an app-private storage directory")
        val privatePath = expectedPrivatePath(root, entry.contentType, entry.sha256)

        return handler.await(inTransaction = true) {
            val existing = local_booksQueries.findBySha256(entry.sha256, ::mapBook).executeAsOneOrNull()
            val bookId = existing?.bookId ?: entry.bookId
            require(existing == null || existing.bookId == entry.bookId) {
                "A local-book backup collides with another book identity"
            }

            if (existing == null) {
                local_booksQueries.insert(
                    bookId = entry.bookId,
                    contentType = entry.contentType.name,
                    sha256 = entry.sha256,
                    displayName = entry.displayName,
                    author = entry.author,
                    description = entry.description,
                    coverPath = null,
                    coverAssetSha256 = null,
                    coverAssetByteSize = null,
                    coverAssetMimeType = null,
                    privatePath = privatePath,
                    mimeType = entry.mimeType,
                    byteSize = entry.byteSize,
                    chapterCount = entry.chapterCount?.toLong(),
                    pageCount = entry.pageCount?.toLong(),
                    importedAt = entry.importedAt,
                    updatedAt = entry.updatedAt,
                )
            } else {
                local_booksQueries.updateMetadata(
                    displayName = entry.displayName,
                    author = entry.author,
                    description = entry.description,
                    coverPath = null,
                    updatedAt = entry.updatedAt,
                    bookId = bookId,
                )
                local_booksQueries.updateAsset(
                    privatePath = privatePath,
                    mimeType = entry.mimeType,
                    byteSize = entry.byteSize,
                    updatedAt = entry.updatedAt,
                    bookId = bookId,
                )
                local_booksQueries.updateStructure(
                    chapterCount = entry.chapterCount?.toLong() ?: existing.chapterCount?.toLong(),
                    pageCount = entry.pageCount?.toLong() ?: existing.pageCount?.toLong(),
                    updatedAt = entry.updatedAt,
                    bookId = bookId,
                )
            }

            local_booksQueries.deleteCategories(bookId)
            entry.categoryIds.distinct().forEach { categoryId ->
                local_booksQueries.insertCategory(bookId, categoryId)
            }

            entry.progress?.let { locator ->
                local_booksQueries.upsertProgress(
                    bookId = bookId,
                    locatorJson = json.encodeToString(ReaderLocator.serializer(), locator),
                    progression = locator.progression(),
                    updatedAt = entry.updatedAt,
                )
            }
            entry.bookmarks.forEach { bookmark ->
                local_booksQueries.upsertBookmark(
                    bookmarkId = bookmark.bookmarkId,
                    bookId = bookId,
                    locatorJson = json.encodeToString(ReaderLocator.serializer(), bookmark.locator),
                    label = bookmark.label,
                    note = bookmark.note,
                    createdAt = bookmark.createdAt,
                    updatedAt = bookmark.updatedAt,
                )
            }
            entry.highlights.forEach { highlight ->
                local_booksQueries.upsertHighlight(
                    highlightId = highlight.highlightId,
                    bookId = bookId,
                    startLocatorJson = json.encodeToString(ReaderLocator.serializer(), highlight.start),
                    endLocatorJson = json.encodeToString(ReaderLocator.serializer(), highlight.end),
                    selectedText = highlight.selectedText,
                    colorArgb = highlight.colorArgb,
                    note = highlight.note,
                    createdAt = highlight.createdAt,
                    updatedAt = highlight.updatedAt,
                )
            }

            local_booksQueries.findById(bookId, ::mapBook).executeAsOne()
        }
    }

    override suspend fun publish(imported: ImportedBook): LocalBook {
        val manifest = imported.privateResult.manifest
        val cover = BookCoverAssetInspector.inspect(imported.coverPath)
        val now = System.currentTimeMillis()
        val bookId = mutations.publish(
            snapshot = BookEntrySnapshot(
                bookId = manifest.entityId,
                contentType = manifest.contentType,
                sha256 = manifest.assetId.value,
                title = imported.title,
                author = imported.author,
                description = imported.description,
                mimeType = manifest.mediaType,
                byteSize = manifest.byteSize,
                chapterCount = manifest.chapterCount,
                pageCount = if (manifest.contentType == ContentType.PDF) 1 else null,
                coverAssetSha256 = cover?.sha256,
                coverAssetByteSize = cover?.byteSize,
                coverAssetMimeType = cover?.mimeType,
                createdAtEpochMillis = now,
                updatedAtEpochMillis = now,
            ),
            privatePath = imported.privateResult.privateFile.absolutePath,
            coverPath = cover?.file?.absolutePath,
        )
        return find(bookId) ?: error("Published local book was not materialized")
    }

    override suspend fun relink(bookId: String, imported: ImportedBook): LocalBook =
        handler.await(inTransaction = true) {
            val manifest = imported.privateResult.manifest
            val existing = local_booksQueries.findById(bookId, ::mapBook).executeAsOneOrNull()
                ?: error("Unknown local book: $bookId")
            require(existing.sha256 == manifest.assetId.value) {
                "The selected file does not match the local book identity"
            }
            require(existing.contentType == manifest.contentType) {
                "The selected file has a different content type"
            }
            local_booksQueries.updateAsset(
                privatePath = imported.privateResult.privateFile.absolutePath,
                mimeType = manifest.mediaType,
                byteSize = manifest.byteSize,
                updatedAt = System.currentTimeMillis(),
                bookId = bookId,
            )
            local_booksQueries.updateStructure(
                chapterCount = manifest.chapterCount?.toLong() ?: existing.chapterCount?.toLong(),
                pageCount = if (manifest.contentType == ContentType.PDF) {
                    existing.pageCount ?: 1
                } else {
                    existing.pageCount
                }?.toLong(),
                updatedAt = System.currentTimeMillis(),
                bookId = bookId,
            )
            imported.coverPath?.let { coverPath ->
                val cover = BookCoverAssetInspector.inspect(coverPath) ?: return@let
                local_booksQueries.updateCover(
                    coverPath = cover.file.absolutePath,
                    coverAssetSha256 = cover.sha256,
                    coverAssetByteSize = cover.byteSize,
                    coverAssetMimeType = cover.mimeType,
                    updatedAt = System.currentTimeMillis(),
                    bookId = bookId,
                )
            }
            local_booksQueries.findById(bookId, ::mapBook).executeAsOne()
        }

    override suspend fun remove(bookId: String, removeFile: Boolean) {
        val book = find(bookId) ?: return
        if (removeFile) {
            val file = java.io.File(book.privatePath)
            if (file.exists() && !file.delete() && file.exists()) {
                throw IllegalStateException("The local book file could not be removed")
            }
            book.coverPath?.let { coverPath ->
                val cover = java.io.File(coverPath)
                if (cover.exists() && !cover.delete() && cover.exists()) {
                    throw IllegalStateException("The local book cover could not be removed")
                }
            }
        }
        // Delete the database row only after the private asset has been removed successfully.
        // This keeps a failed filesystem operation visible and retryable instead of silently
        // losing the library entry while leaving an inaccessible asset behind.
        handler.await { local_booksQueries.deleteById(bookId) }
    }

    override suspend fun saveProgress(bookId: String, locator: ReaderLocator) {
        mutations.saveProgress(bookId, locator)
    }

    override suspend fun saveStructure(bookId: String, chapterCount: Int?, pageCount: Int?) {
        mutations.saveStructure(bookId, chapterCount, pageCount)
    }

    private fun JsonObject?.structureCount(vararg keys: String): Long? = keys.firstNotNullOfOrNull { key ->
        (this?.get(key) as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 }
    }

    private companion object {
        const val BOOK_SCOPE = "books:global"
        const val BOOK_ENTRY_TYPE = "book.entry"
    }

    override suspend fun getProgress(bookId: String): ReaderLocator? =
        handler.awaitOneOrNull { local_booksQueries.findProgress(bookId) }
            ?.let { decodeLocator(it.locator_json, bookId) }

    override suspend fun addBookmark(bookmark: BookBookmark) {
        mutations.upsertBookmark(
            BookBookmarkMutation(
                bookmarkId = bookmark.bookmarkId,
                bookId = bookmark.bookId,
                locator = bookmark.locator,
                label = bookmark.label,
                note = bookmark.note,
                createdAtEpochMillis = bookmark.createdAt,
                updatedAtEpochMillis = bookmark.updatedAt,
            ),
        )
    }

    override suspend fun getBookmarks(bookId: String): List<BookBookmark> =
        handler.awaitList { local_booksQueries.findBookmarks(bookId) }
            .map { row ->
                BookBookmark(
                    bookmarkId = row.bookmark_id,
                    bookId = row.book_id,
                    locator = decodeLocator(row.locator_json, row.book_id),
                    label = row.label,
                    note = row.note,
                    createdAt = row.created_at,
                    updatedAt = row.updated_at,
                )
            }

    override suspend fun removeBookmark(bookmarkId: String) {
        mutations.removeBookmark(bookmarkId)
    }

    override suspend fun addHighlight(highlight: BookHighlight) {
        mutations.upsertHighlight(
            BookHighlightMutation(
                highlightId = highlight.highlightId,
                bookId = highlight.bookId,
                start = highlight.start,
                end = highlight.end,
                selectedText = highlight.selectedText,
                colorArgb = highlight.colorArgb,
                note = highlight.note,
                createdAtEpochMillis = highlight.createdAt,
                updatedAtEpochMillis = highlight.updatedAt,
            ),
        )
    }

    override suspend fun getHighlights(bookId: String): List<BookHighlight> =
        handler.awaitList { local_booksQueries.findHighlights(bookId) }
            .map { row ->
                BookHighlight(
                    highlightId = row.highlight_id,
                    bookId = row.book_id,
                    start = decodeLocator(row.start_locator_json, row.book_id),
                    end = decodeLocator(row.end_locator_json, row.book_id),
                    selectedText = row.selected_text,
                    colorArgb = row.color_argb,
                    note = row.note,
                    createdAt = row.created_at,
                    updatedAt = row.updated_at,
                )
            }

    override suspend fun removeHighlight(highlightId: String) {
        mutations.removeHighlight(highlightId)
    }

    override suspend fun setCategory(bookId: String, categoryId: Long, enabled: Boolean) {
        mutations.setCategory(bookId, categoryId, enabled)
    }

    override suspend fun getCategoryIds(bookId: String): List<Long> =
        handler.awaitList { local_booksQueries.findCategoryIds(bookId) }

    override suspend fun repairExistingBooks(): LocalBookRepairReport {
        val books = handler.awaitList { local_booksQueries.findAll(::mapBook) }
        var repaired = 0
        var coversMaterialized = 0
        var metadataUpdated = 0
        var unavailable = 0

        books.forEach { book ->
            val privateFile = File(book.privatePath)
            if (!privateFile.isFile || !privateFile.canRead()) {
                unavailable++
                return@forEach
            }

            val metadata = BookImportMetadataExtractor.extract(
                file = privateFile,
                contentType = book.contentType,
                fallbackDisplayName = book.displayName,
            )
            val structure = structureInspector?.inspect(book.document())
            val currentCover = BookCoverAssetInspector.inspect(book.coverPath)
            val derivedCover = currentCover ?: coverMaterializer?.materialize(
                file = privateFile,
                contentType = book.contentType,
                assetId = book.sha256,
            )?.let { file -> BookCoverAssetInspector.inspect(file.absolutePath) }
            val coverChanged = derivedCover != null && (
                book.coverPath != derivedCover.file.absolutePath ||
                    book.coverAssetSha256 != derivedCover.sha256 ||
                    book.coverAssetByteSize != derivedCover.byteSize ||
                    book.coverAssetMimeType != derivedCover.mimeType
                )
            if (coverChanged) coversMaterialized++

            val titleFromFile = book.displayName.endsWith(".epub", true) ||
                book.displayName.endsWith(".pdf", true) ||
                BookImportMetadataExtractor.isMisdecodedPdfTitle(book.displayName)
            val title = if (titleFromFile) {
                metadata.title
                    ?.takeIf { it.isNotBlank() && !BookImportMetadataExtractor.isMisdecodedPdfTitle(it) }
                    ?: book.displayName
            } else {
                book.displayName
            }
            val author = book.author ?: metadata.author
            val description = book.description ?: metadata.description
            val metadataChanged = title != book.displayName ||
                author != book.author ||
                description != book.description
            val structureChanged = structure != null && (
                structure.chapterCount != book.chapterCount ||
                    structure.pageCount != book.pageCount
                )
            if (metadataChanged) metadataUpdated++
            if (!coverChanged && !metadataChanged && !structureChanged) return@forEach

            handler.await(inTransaction = true) {
                if (metadataChanged || coverChanged) {
                    local_booksQueries.updateMetadata(
                        displayName = title,
                        author = author,
                        description = description,
                        coverPath = derivedCover?.file?.absolutePath ?: book.coverPath,
                        updatedAt = System.currentTimeMillis(),
                        bookId = book.bookId,
                    )
                }
                if (coverChanged) {
                    val cover = requireNotNull(derivedCover)
                    local_booksQueries.updateCover(
                        coverPath = cover.file.absolutePath,
                        coverAssetSha256 = cover.sha256,
                        coverAssetByteSize = cover.byteSize,
                        coverAssetMimeType = cover.mimeType,
                        updatedAt = System.currentTimeMillis(),
                        bookId = book.bookId,
                    )
                }
                if (structureChanged) {
                    local_booksQueries.updateStructure(
                        chapterCount = structure.chapterCount?.toLong(),
                        pageCount = structure.pageCount?.toLong(),
                        updatedAt = System.currentTimeMillis(),
                        bookId = book.bookId,
                    )
                }
            }
            repaired++
        }

        return LocalBookRepairReport(
            inspected = books.size,
            repaired = repaired,
            coversMaterialized = coversMaterialized,
            metadataUpdated = metadataUpdated,
            unavailable = unavailable,
        )
    }

    private fun decodeLocator(value: String, bookId: String): ReaderLocator =
        json.decodeFromString(ReaderLocator.serializer(), value).also {
            require(it.entityId.value == bookId) { "Stored locator belongs to a different book" }
        }

    private fun mapBook(
        bookId: String,
        contentType: String,
        sha256: String,
        displayName: String,
        author: String?,
        description: String?,
        coverPath: String?,
        coverAssetSha256: String?,
        coverAssetByteSize: Long?,
        coverAssetMimeType: String?,
        privatePath: String,
        mimeType: String,
        byteSize: Long,
        importedAt: Long,
        updatedAt: Long,
        chapterCount: Long?,
        pageCount: Long?,
    ): LocalBook = LocalBook(
        bookId = bookId,
        contentType = ContentType.valueOf(contentType),
        sha256 = sha256,
        displayName = displayName,
        author = author,
        description = description,
        coverPath = coverPath,
        coverAssetSha256 = coverAssetSha256,
        coverAssetByteSize = coverAssetByteSize,
        coverAssetMimeType = coverAssetMimeType,
        privatePath = privatePath,
        mimeType = mimeType,
        byteSize = byteSize,
        // Treat zeroes written by legacy/Core records as unknown. LocalBook deliberately keeps
        // a strict positive-count invariant; the maintenance pass reparses available bytes and
        // replaces this temporary unknown state with the exact EPUB spine/PDF page count.
        chapterCount = chapterCount?.takeIf { it > 0 }?.toInt(),
        pageCount = pageCount?.takeIf { it > 0 }?.toInt(),
        importedAt = importedAt,
        updatedAt = updatedAt,
    )

    private fun ReaderLocator.progression(): Double = when (this) {
        is ReaderLocator.Epub -> progression
        is ReaderLocator.Pdf -> documentProgression ?: pageIndex.toDouble()
        else -> error("Local book backup progress accepts only EPUB and PDF locators")
    }

    private fun JsonObject.pdfSections(): List<LocalBookPdfSection> {
        val entries = this["sectionsSummaryJson"] as? JsonArray ?: return emptyList()
        return entries.mapNotNull { element ->
            val section = element as? JsonObject ?: return@mapNotNull null
            val title = (section["label"] as? JsonPrimitive)
                ?.contentOrNull
                ?.trim()
                ?.takeIf { it.isNotEmpty() }
                ?: return@mapNotNull null
            val href = (section["href"] as? JsonPrimitive)?.contentOrNull
                ?: return@mapNotNull null
            val oneBasedPage = href.removePrefix("page:")
                .takeIf { href.startsWith("page:") }
                ?.toIntOrNull()
                ?.takeIf { it > 0 }
                ?: return@mapNotNull null
            val depth = (section["depth"] as? JsonPrimitive)?.intOrNull?.coerceAtLeast(0) ?: 0
            LocalBookPdfSection(
                title = title,
                pageIndex = oneBasedPage - 1,
                depth = depth,
            )
        }
    }

    private fun expectedPrivatePath(root: File, contentType: ContentType, sha256: String): String {
        val directory = when (contentType) {
            ContentType.EPUB -> "epub"
            ContentType.PDF -> "pdf"
            else -> error("Only EPUB and PDF files can be restored")
        }
        return File(File(root, directory), "$sha256.$directory").absolutePath
    }
}
