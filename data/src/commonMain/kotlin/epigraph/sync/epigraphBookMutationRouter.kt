package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphIdentityRules
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.BookEntrySnapshot
import epigraph.contract.CategoryScope
import epigraph.contract.ClientMutationId
import epigraph.contract.ContentType
import epigraph.contract.DeviceId
import epigraph.contract.ReaderLocator
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

data class BookBookmarkMutation(
    val bookmarkId: String,
    val bookId: String,
    val locator: ReaderLocator,
    val label: String?,
    val note: String?,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
)

data class BookHighlightMutation(
    val highlightId: String,
    val bookId: String,
    val start: ReaderLocator,
    val end: ReaderLocator,
    val selectedText: String,
    val colorArgb: Long,
    val note: String?,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
)

/** Atomically persists every user-authored Books change with its Core outbox command. */
class EpigraphBookMutationRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val clock: () -> Long = System::currentTimeMillis,
    private val json: Json = Json { encodeDefaults = true },
) {
    private val progressMutex = Mutex()

    suspend fun publish(
        snapshot: BookEntrySnapshot,
        privatePath: String,
        coverPath: String?,
    ): String {
        val now = timestamp()
        return coordinator.mutateLocalBatch(now) {
            val expectedId = EpigraphIdentityRules.importedBookId(snapshot.contentType, snapshot.sha256).value
            require(snapshot.bookId.value == expectedId) { "book metadata does not match its content identity" }
            val existing = local_booksQueries.findBySha256(snapshot.sha256).executeAsOneOrNull()
            val bookId = existing?.book_id ?: snapshot.bookId.value
            require(bookId == snapshot.bookId.value) { "book asset collides with another identity" }

            if (existing == null) {
                local_booksQueries.insert(
                    bookId = bookId,
                    contentType = snapshot.contentType.name,
                    sha256 = snapshot.sha256,
                    displayName = snapshot.title,
                    author = snapshot.author,
                    description = snapshot.description,
                    coverPath = coverPath,
                    coverAssetSha256 = snapshot.coverAssetSha256,
                    coverAssetByteSize = snapshot.coverAssetByteSize,
                    coverAssetMimeType = snapshot.coverAssetMimeType,
                    privatePath = privatePath,
                    mimeType = snapshot.mimeType,
                    byteSize = snapshot.byteSize,
                    chapterCount = snapshot.chapterCount?.toLong(),
                    pageCount = snapshot.pageCount?.toLong(),
                    importedAt = snapshot.createdAtEpochMillis,
                    updatedAt = snapshot.updatedAtEpochMillis,
                )
            } else {
                local_booksQueries.updateMetadata(
                    displayName = snapshot.title,
                    author = snapshot.author,
                    description = snapshot.description,
                    coverPath = coverPath,
                    updatedAt = snapshot.updatedAtEpochMillis,
                    bookId = bookId,
                )
                local_booksQueries.updateCover(
                    coverPath = coverPath,
                    coverAssetSha256 = snapshot.coverAssetSha256,
                    coverAssetByteSize = snapshot.coverAssetByteSize,
                    coverAssetMimeType = snapshot.coverAssetMimeType,
                    updatedAt = snapshot.updatedAtEpochMillis,
                    bookId = bookId,
                )
                local_booksQueries.updateAsset(
                    privatePath = privatePath,
                    mimeType = snapshot.mimeType,
                    byteSize = snapshot.byteSize,
                    updatedAt = snapshot.updatedAtEpochMillis,
                    bookId = bookId,
                )
                local_booksQueries.updateStructure(
                    chapterCount = snapshot.chapterCount?.toLong() ?: existing.chapter_count,
                    pageCount = snapshot.pageCount?.toLong() ?: existing.page_count,
                    updatedAt = snapshot.updatedAtEpochMillis,
                    bookId = bookId,
                )
            }
            aethon_syncQueries.upsertIdentity(
                entityId = bookId,
                contentType = snapshot.contentType.name,
                localReference = bookId,
                createdAt = existing?.imported_at ?: snapshot.createdAtEpochMillis,
                updatedAt = snapshot.updatedAtEpochMillis,
            )
            aethon_syncQueries.insertAssetManifest(
                sha256 = snapshot.sha256,
                contentType = snapshot.contentType.name,
                byteSize = snapshot.byteSize,
                mimeType = snapshot.mimeType,
                localUri = privatePath,
                remoteAvailable = false,
                state = "PENDING_UPLOAD",
                updatedAt = now,
            )
            aethon_syncQueries.linkEntityAsset(
                entityId = bookId,
                sha256 = snapshot.sha256,
                role = "PUBLICATION",
                relativePath = "",
                ordinal = 0,
            )
            aethon_syncQueries.deleteEntityAssetsByRole(bookId, "COVER")
            snapshot.coverAssetSha256?.let { coverSha256 ->
                val coverByteSize = requireNotNull(snapshot.coverAssetByteSize)
                val coverMimeType = requireNotNull(snapshot.coverAssetMimeType)
                val localCoverPath = requireNotNull(coverPath) {
                    "A published local cover must have a local path"
                }
                aethon_syncQueries.insertAssetManifest(
                    sha256 = coverSha256,
                    contentType = "BOOK_COVER",
                    byteSize = coverByteSize,
                    mimeType = coverMimeType,
                    localUri = localCoverPath,
                    remoteAvailable = false,
                    state = "PENDING_UPLOAD",
                    updatedAt = now,
                )
                aethon_syncQueries.linkEntityAsset(
                    entityId = bookId,
                    sha256 = coverSha256,
                    role = "COVER",
                    relativePath = "",
                    ordinal = 0,
                )
            }
            LocalMutationResult(bookId, listOf(envelope(BOOK_ENTRY, SyncCommand.UpsertBookEntry(snapshot.bookId, snapshot))))
        }
    }

    suspend fun saveProgress(bookId: String, locator: ReaderLocator) {
        val now = timestamp()
        val progression = locator.documentProgression()
        progressMutex.withLock {
            coordinator.mutateLocalBatch(now) {
                val book = local_booksQueries.findById(bookId).executeAsOneOrNull()
                    ?: error("Unknown local book: $bookId")
                require(locator.entityId.value == bookId && locator.contentType.name == book.content_type) {
                    "book progress locator does not belong to the local book"
                }
                val current = local_booksQueries.findProgress(bookId).executeAsOneOrNull()
                if (current != null && current.updated_at > now) {
                    return@mutateLocalBatch LocalMutationResult(Unit, emptyList())
                }
                local_booksQueries.upsertProgress(
                    bookId = bookId,
                    locatorJson = json.encodeToString(ReaderLocator.serializer(), locator),
                    progression = progression,
                    updatedAt = now,
                )
                // Intermediate reader positions that have never left this device are replaceable.
                // Attempted rows remain immutable so acknowledgements still match their payload.
                aethon_syncQueries.deleteUnattemptedMutationForEntity(
                    deviceId = deviceId.value,
                    scopeId = BOOKS_SCOPE.value,
                    entityType = BOOK_PROGRESS.value,
                    entityId = bookId,
                )
                val command = SyncCommand.SetProgress(EpigraphEntityId(bookId), locator)
                LocalMutationResult(Unit, listOf(envelope(BOOK_PROGRESS, command)))
            }
        }
    }

    /**
     * Publishes structure metadata discovered only after the private publication is opened.
     *
     * This deliberately does not touch the asset manifest: a book downloaded from Core must
     * remain an available remote asset, rather than being turned into a new upload merely
     * because this device was the first one to inspect its EPUB spine or PDF page tree.
     */
    suspend fun saveStructure(bookId: String, chapterCount: Int?, pageCount: Int?) {
        require(chapterCount == null || chapterCount > 0) {
            "A local book chapter count must be positive"
        }
        require(pageCount == null || pageCount > 0) {
            "A local book page count must be positive"
        }
        val now = timestamp()
        coordinator.mutateLocalBatch(now) {
            val existing = local_booksQueries.findById(bookId).executeAsOneOrNull()
                ?: return@mutateLocalBatch LocalMutationResult(Unit, emptyList())
            val contentType = ContentType.valueOf(existing.content_type)
            val resolvedChapterCount = if (contentType == ContentType.PDF) {
                maxOf(existing.chapter_count ?: 0, chapterCount?.toLong() ?: 0).takeIf { it > 0 }
            } else {
                chapterCount?.toLong() ?: existing.chapter_count
            }
            val resolvedPageCount = pageCount?.toLong() ?: existing.page_count
            val confirmed = aethon_syncQueries.selectCoreReplicaRecord(
                scopeId = BOOKS_SCOPE.value,
                entityType = BOOK_ENTRY.value,
                entityId = bookId,
            ).executeAsOneOrNull()?.record_json?.let { encoded ->
                runCatching { json.parseToJsonElement(encoded) as? JsonObject }.getOrNull()
            }
            val confirmedChapterCount = confirmed?.structureCount("tocCount", "spineCount", "sectionCount")
            val confirmedPageCount = confirmed?.structureCount("pageCount")
            val confirmedNeedsRepair = confirmed != null && (
                (resolvedChapterCount != null && confirmedChapterCount != resolvedChapterCount) ||
                    (resolvedPageCount != null && confirmedPageCount != resolvedPageCount)
                )
            if (
                resolvedChapterCount == existing.chapter_count &&
                resolvedPageCount == existing.page_count &&
                !confirmedNeedsRepair
            ) {
                return@mutateLocalBatch LocalMutationResult(Unit, emptyList())
            }

            local_booksQueries.updateStructure(
                chapterCount = resolvedChapterCount,
                pageCount = resolvedPageCount,
                updatedAt = now,
                bookId = bookId,
            )
            val snapshot = BookEntrySnapshot(
                bookId = EpigraphEntityId(existing.book_id),
                contentType = contentType,
                sha256 = existing.sha256,
                title = existing.display_name,
                author = existing.author,
                description = existing.description,
                mimeType = existing.mime_type,
                byteSize = existing.byte_size,
                coverAssetSha256 = existing.cover_asset_sha256,
                coverAssetByteSize = existing.cover_asset_byte_size,
                coverAssetMimeType = existing.cover_asset_mime_type,
                chapterCount = resolvedChapterCount?.toInt(),
                pageCount = resolvedPageCount?.toInt(),
                createdAtEpochMillis = existing.imported_at,
                updatedAtEpochMillis = now,
            )
            // Coalesce metadata discovered repeatedly before the Core has acknowledged it.
            aethon_syncQueries.deleteUnattemptedMutationForEntity(
                deviceId = deviceId.value,
                scopeId = BOOKS_SCOPE.value,
                entityType = BOOK_ENTRY.value,
                entityId = bookId,
            )
            LocalMutationResult(
                Unit,
                listOf(envelope(BOOK_ENTRY, SyncCommand.UpsertBookEntry(snapshot.bookId, snapshot))),
            )
        }
    }

    suspend fun upsertBookmark(mutation: BookBookmarkMutation) {
        coordinator.mutateLocalBatch(mutation.updatedAtEpochMillis) {
            requireLocalBook(mutation.bookId, mutation.locator)
            local_booksQueries.upsertBookmark(
                bookmarkId = mutation.bookmarkId,
                bookId = mutation.bookId,
                locatorJson = json.encodeToString(ReaderLocator.serializer(), mutation.locator),
                label = mutation.label,
                note = mutation.note,
                createdAt = mutation.createdAtEpochMillis,
                updatedAt = mutation.updatedAtEpochMillis,
            )
            val command = SyncCommand.UpsertBookBookmark(
                entityId = EpigraphEntityId(mutation.bookmarkId),
                bookId = EpigraphEntityId(mutation.bookId),
                locator = mutation.locator,
                label = mutation.label,
                note = mutation.note,
                createdAtEpochMillis = mutation.createdAtEpochMillis,
                updatedAtEpochMillis = mutation.updatedAtEpochMillis,
            )
            LocalMutationResult(Unit, listOf(envelope(BOOK_BOOKMARK, command)))
        }
    }

    suspend fun removeBookmark(bookmarkId: String) = deleteAnnotation(BOOK_BOOKMARK, bookmarkId) {
        local_booksQueries.deleteBookmark(bookmarkId)
    }

    suspend fun upsertHighlight(mutation: BookHighlightMutation) {
        coordinator.mutateLocalBatch(mutation.updatedAtEpochMillis) {
            requireLocalBook(mutation.bookId, mutation.start)
            require(mutation.start.entityId == mutation.end.entityId && mutation.start.contentType == mutation.end.contentType) {
                "book highlight cannot span documents or content types"
            }
            local_booksQueries.upsertHighlight(
                highlightId = mutation.highlightId,
                bookId = mutation.bookId,
                startLocatorJson = json.encodeToString(ReaderLocator.serializer(), mutation.start),
                endLocatorJson = json.encodeToString(ReaderLocator.serializer(), mutation.end),
                selectedText = mutation.selectedText,
                colorArgb = mutation.colorArgb,
                note = mutation.note,
                createdAt = mutation.createdAtEpochMillis,
                updatedAt = mutation.updatedAtEpochMillis,
            )
            val command = SyncCommand.UpsertBookHighlight(
                entityId = EpigraphEntityId(mutation.highlightId),
                bookId = EpigraphEntityId(mutation.bookId),
                start = mutation.start,
                end = mutation.end,
                selectedText = mutation.selectedText,
                colorArgb = mutation.colorArgb,
                note = mutation.note,
                createdAtEpochMillis = mutation.createdAtEpochMillis,
                updatedAtEpochMillis = mutation.updatedAtEpochMillis,
            )
            LocalMutationResult(Unit, listOf(envelope(BOOK_HIGHLIGHT, command)))
        }
    }

    suspend fun removeHighlight(highlightId: String) = deleteAnnotation(BOOK_HIGHLIGHT, highlightId) {
        local_booksQueries.deleteHighlight(highlightId)
    }

    suspend fun setCategory(bookId: String, categoryId: Long, enabled: Boolean) {
        val now = timestamp()
        coordinator.mutateLocalBatch(now) {
            require(local_booksQueries.findById(bookId).executeAsOneOrNull() != null) {
                "Unknown local book: $bookId"
            }
            val category = categoriesQueries.findAll().executeAsList().firstOrNull { it._id == categoryId }
                ?: error("Unknown category: $categoryId")
            if (enabled) {
                local_booksQueries.insertCategory(bookId, categoryId)
            } else {
                local_booksQueries.deleteCategory(bookId, categoryId)
            }
            val requested = local_booksQueries.findCategoryIds(bookId).executeAsList().distinct().sorted()
            val categories = categoriesQueries.findAll().executeAsList().associateBy { it._id }
            val categoryCommands = requested.map { localId ->
                val local = categories[localId] ?: error("Unknown category: $localId")
                val identity = aethon_syncQueries.selectCategoryIdentityByLocalId(localId).executeAsOneOrNull()
                val entityId = identity?.entity_id ?: "book-category-local-$localId"
                aethon_syncQueries.upsertCategoryScope(localId, "BOOK")
                aethon_syncQueries.upsertCategoryIdentity(
                    entityId = entityId,
                    localCategoryId = localId,
                    contentScope = "BOOK",
                    name = local.name,
                    sortOrder = local.sort,
                    updatedAt = now,
                )
                SyncCommand.UpsertCategory(EpigraphEntityId(entityId), local.name, CategoryScope.BOOK, local.sort)
            }
            val assignment = SyncCommand.SetBookCategoryAssignments(
                EpigraphEntityId(bookId),
                requested.map { localId ->
                    val identity = aethon_syncQueries.selectCategoryIdentityByLocalId(localId).executeAsOne()
                    EpigraphEntityId(identity.entity_id)
                },
            )
            val envelopes = categoryCommands.map { envelope(BOOK_CATEGORY, it) } +
                envelope(BOOK_CATEGORY_ASSIGNMENT, assignment)
            LocalMutationResult(Unit, envelopes)
        }
    }

    private suspend fun deleteAnnotation(
        entityType: SyncEntityType,
        entityId: String,
        delete: suspend yokai.data.Database.() -> Unit,
    ) {
        val now = timestamp()
        coordinator.mutateLocalBatch(now) {
            delete()
            val command = SyncCommand.DeleteEntity(EpigraphEntityId(entityId))
            LocalMutationResult(Unit, listOf(envelope(entityType, command)))
        }
    }

    private fun yokai.data.Database.requireLocalBook(bookId: String, locator: ReaderLocator) {
        val book = local_booksQueries.findById(bookId).executeAsOneOrNull()
            ?: error("Unknown local book: $bookId")
        require(locator.entityId.value == bookId && locator.contentType.name == book.content_type) {
            "book locator does not belong to the local book"
        }
    }

    private fun envelope(entityType: SyncEntityType, command: SyncCommand) = SyncCommandEnvelope(
        protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
        deviceId = deviceId,
        clientMutationId = mutationIds.next(),
        scopeId = BOOKS_SCOPE,
        entityType = entityType,
        command = command,
    )

    private fun ReaderLocator.documentProgression(): Double = when (this) {
        is ReaderLocator.Epub -> progression
        is ReaderLocator.Pdf -> documentProgression
            ?: error("PDF progress requires total document progression")
        else -> error("Books accept only EPUB and PDF progress")
    }

    private fun JsonObject.structureCount(vararg keys: String): Long? = keys
        .mapNotNull { key -> (get(key) as? JsonPrimitive)?.longOrNull?.takeIf { it > 0 } }
        .maxOrNull()

    private fun timestamp(): Long = clock().also {
        require(it >= 0) { "mutation timestamp must be epoch milliseconds" }
    }

    private companion object {
        val BOOKS_SCOPE = SyncScopeId("books:global")
        val BOOK_ENTRY = SyncEntityType("book.entry")
        val BOOK_CATEGORY = SyncEntityType("book.category")
        val BOOK_CATEGORY_ASSIGNMENT = SyncEntityType("book.category_assignment")
        val BOOK_PROGRESS = SyncEntityType("book.progress")
        val BOOK_BOOKMARK = SyncEntityType("book.bookmark")
        val BOOK_HIGHLIGHT = SyncEntityType("book.highlight")
    }
}
