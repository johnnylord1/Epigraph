package epigraph.contract

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

@Serializable
enum class SyncState {
    @SerialName("synced")
    SYNCED,

    @SerialName("pending")
    PENDING,

    @SerialName("conflict")
    CONFLICT,

    @SerialName("local_only")
    LOCAL_ONLY,

    @SerialName("error")
    ERROR,
}

/**
 * Transport envelope. The Core persists one receipt for each [idempotencyKey], making retries safe.
 */
@Serializable
data class SyncCommandEnvelope(
    val protocolVersion: Int,
    val deviceId: DeviceId,
    val clientMutationId: ClientMutationId,
    val scopeId: SyncScopeId,
    val entityType: SyncEntityType,
    val command: SyncCommand,
) {
    init {
        require(protocolVersion > 0) { "protocol version must be positive" }
    }

    val idempotencyKey: String
        get() = lengthPrefixed(deviceId.value, clientMutationId.value)
}

object EpigraphSyncProtocol {
    const val CURRENT_VERSION: Int = 2
}

fun SyncCommand.operationWireName(): String = when (this) {
    is SyncCommand.UpsertIdentity -> "upsert_identity"
    is SyncCommand.SetLibraryMembership -> "set_library_membership"
    is SyncCommand.UpsertCategory -> "upsert_category"
    is SyncCommand.SetCategoryOrder -> "set_category_order"
    is SyncCommand.SetCategoryAssignment -> "set_category_assignment"
    is SyncCommand.SetChapterState -> "set_chapter_state"
    is SyncCommand.SetNovelChapterState -> "set_novel_chapter_state"
    is SyncCommand.SetNovelChapterBookmark -> "set_novel_chapter_bookmark"
    is SyncCommand.SetProgress -> "set_progress"
    is SyncCommand.SetBookmark -> "set_bookmark"
    is SyncCommand.AppendHistory -> "append_history"
    is SyncCommand.ClearHistory -> "clear_history"
    is SyncCommand.PatchTracking -> "patch_tracking"
    is SyncCommand.UpsertRepository -> "upsert_repository"
    is SyncCommand.UpsertComicExtension -> "upsert_comic_extension"
    is SyncCommand.UpsertNovelPlugin -> "upsert_novel_plugin"
    is SyncCommand.SetAssetBinding -> "set_asset_binding"
    is SyncCommand.SetEntityAlias -> "set_entity_alias"
    is SyncCommand.MigrateEntity -> "migrate_entity"
    is SyncCommand.DeleteEntity -> "delete_entity"
    is SyncCommand.SetNovelLibraryMembership -> "set_novel_library_membership"
    is SyncCommand.UpsertBookEntry -> "upsert_book_entry"
    is SyncCommand.UpsertBookBookmark -> "upsert_book_bookmark"
    is SyncCommand.UpsertBookHighlight -> "upsert_book_highlight"
    is SyncCommand.SetBookCategoryAssignments -> "set_book_category_assignments"
}

@Serializable
sealed interface SyncCommand {
    val entityId: EpigraphEntityId

    @Serializable
    @SerialName("upsert_identity")
    data class UpsertIdentity(
        override val entityId: EpigraphEntityId,
        val contentType: ContentType,
        val source: SourceBinding? = null,
    ) : SyncCommand {
        init {
            require(contentType == ContentType.EPUB || contentType == ContentType.PDF || source != null) {
                "manga and novel identities require a source binding"
            }
        }
    }

    @Serializable
    @SerialName("set_library_membership")
    data class SetLibraryMembership(
        override val entityId: EpigraphEntityId,
        val inLibrary: Boolean,
        val portableWorkRef: PortableWorkRef.Comic? = null,
    ) : SyncCommand

    /**
     * A lossless library mutation for LNReader novels. Unlike comics, a Core novel entry is the
     * library record itself, so adding it must carry the complete metadata patch and removing it
     * is represented as a delete. The optional snapshot is required for [inLibrary] = true.
     */
    @Serializable
    @SerialName("set_novel_library_membership")
    data class SetNovelLibraryMembership(
        override val entityId: EpigraphEntityId,
        val inLibrary: Boolean,
        val entry: NovelEntrySnapshot? = null,
        val portableWorkRef: PortableWorkRef.Novel? = null,
    ) : SyncCommand {
        init {
            require(!inLibrary || entry != null) {
                "novel library additions require a complete entry snapshot"
            }
        }
    }

    @Serializable
    @SerialName("upsert_book_entry")
    data class UpsertBookEntry(
        override val entityId: EpigraphEntityId,
        val entry: BookEntrySnapshot,
    ) : SyncCommand {
        init {
            require(entry.bookId == entityId) { "book snapshot must belong to the command entity" }
        }
    }

    @Serializable
    @SerialName("upsert_book_bookmark")
    data class UpsertBookBookmark(
        override val entityId: EpigraphEntityId,
        val bookId: EpigraphEntityId,
        val locator: ReaderLocator,
        val label: String? = null,
        val note: String? = null,
        val createdAtEpochMillis: Long,
        val updatedAtEpochMillis: Long,
    ) : SyncCommand {
        init {
            require(locator.entityId == bookId) { "bookmark locator must belong to its book" }
            require(createdAtEpochMillis >= 0) { "bookmark creation timestamp must not be negative" }
            require(updatedAtEpochMillis >= createdAtEpochMillis) {
                "bookmark update timestamp must not precede creation"
            }
        }
    }

    @Serializable
    @SerialName("upsert_book_highlight")
    data class UpsertBookHighlight(
        override val entityId: EpigraphEntityId,
        val bookId: EpigraphEntityId,
        val start: ReaderLocator,
        val end: ReaderLocator,
        val selectedText: String,
        val colorArgb: Long,
        val note: String? = null,
        val createdAtEpochMillis: Long,
        val updatedAtEpochMillis: Long,
    ) : SyncCommand {
        init {
            require(start.entityId == bookId && end.entityId == bookId) {
                "highlight locators must belong to their book"
            }
            require(start.contentType == end.contentType) {
                "highlight locators must use the same content type"
            }
            require(createdAtEpochMillis >= 0) { "highlight creation timestamp must not be negative" }
            require(updatedAtEpochMillis >= createdAtEpochMillis) {
                "highlight update timestamp must not precede creation"
            }
        }
    }

    @Serializable
    @SerialName("set_book_category_assignments")
    data class SetBookCategoryAssignments(
        override val entityId: EpigraphEntityId,
        val categoryIds: List<EpigraphEntityId>,
    ) : SyncCommand {
        init {
            require(categoryIds.distinct().size == categoryIds.size) {
                "book category assignments must not contain duplicates"
            }
        }
    }

    @Serializable
    @SerialName("upsert_category")
    data class UpsertCategory(
        override val entityId: EpigraphEntityId,
        val name: String,
        val scope: CategoryScope,
        val position: Long,
    ) : SyncCommand {
        init {
            require(name.isNotBlank()) { "category name must not be blank" }
            require(name == name.trim()) { "category name must not have surrounding whitespace" }
            require(name.length <= 512) { "category name is too long" }
            require(name.none(Char::isISOControl)) { "category name must not contain control characters" }
            require(position >= 0) { "category position must not be negative" }
        }
    }

    @Serializable
    @SerialName("set_category_order")
    data class SetCategoryOrder(
        override val entityId: EpigraphEntityId,
        val scope: CategoryScope,
        val position: Long,
    ) : SyncCommand {
        init {
            require(position >= 0) { "category position must not be negative" }
        }
    }

    @Serializable
    @SerialName("set_category_assignment")
    data class SetCategoryAssignment(
        override val entityId: EpigraphEntityId,
        val categoryId: EpigraphEntityId,
        val assigned: Boolean,
        val portableWorkRef: PortableWorkRef? = null,
    ) : SyncCommand

    @Serializable
    @SerialName("set_chapter_state")
    data class SetChapterState(
        override val entityId: EpigraphEntityId,
        val state: ChapterStatePatch,
    ) : SyncCommand

    /** Complete Core-v1-compatible snapshot used to change a novel chapter's unread state. */
    @Serializable
    @SerialName("set_novel_chapter_state")
    data class SetNovelChapterState(
        override val entityId: EpigraphEntityId,
        val novelId: EpigraphEntityId,
        val path: String,
        val title: String,
        val chapterOrderKey: Double,
        val releaseTimeEpochMillis: Long? = null,
        val unread: Boolean,
    ) : SyncCommand {
        init {
            require(path.isNotBlank()) { "novel chapter path must not be blank" }
            require(title.isNotBlank()) { "novel chapter title must not be blank" }
            require(chapterOrderKey.isFinite()) { "novel chapter order key must be finite" }
            require(releaseTimeEpochMillis == null || releaseTimeEpochMillis >= 0) {
                "novel chapter release timestamp must not be negative"
            }
        }
    }

    /** Deterministic one-per-chapter bookmark command for Core's novel.bookmark entity. */
    @Serializable
    @SerialName("set_novel_chapter_bookmark")
    data class SetNovelChapterBookmark(
        override val entityId: EpigraphEntityId,
        val novelId: EpigraphEntityId,
        val locator: ReaderLocator.Novel,
        val chapterTitle: String? = null,
        val bookmarked: Boolean,
        val savedAtEpochMillis: Long,
    ) : SyncCommand {
        init {
            require(locator.entityId == novelId) { "novel bookmark locator must belong to its novel" }
            require(savedAtEpochMillis >= 0) { "novel bookmark timestamp must not be negative" }
        }
    }

    @Serializable
    @SerialName("set_progress")
    data class SetProgress(
        override val entityId: EpigraphEntityId,
        val locator: ReaderLocator,
        val explicitReset: Boolean = false,
    ) : SyncCommand {
        init {
            require(locator.entityId == entityId) { "progress locator must belong to the command entity" }
        }
    }

    @Serializable
    @SerialName("set_bookmark")
    data class SetBookmark(
        override val entityId: EpigraphEntityId,
        val locator: ReaderLocator,
        val bookmarked: Boolean,
    ) : SyncCommand {
        init {
            require(locator.entityId == entityId) { "bookmark locator must belong to the command entity" }
        }
    }

    @Serializable
    @SerialName("append_history")
    data class AppendHistory(
        override val entityId: EpigraphEntityId,
        val entryId: String,
        val locator: ReaderLocator,
        val visitedAtEpochMillis: Long,
    ) : SyncCommand {
        init {
            validateProtocolIdentifier(entryId, "history entry ID")
            require(locator.entityId == entityId) { "history locator must belong to the command entity" }
            require(visitedAtEpochMillis >= 0) { "history timestamp must not be negative" }
        }
    }

    @Serializable
    @SerialName("clear_history")
    data class ClearHistory(
        override val entityId: EpigraphEntityId,
        val throughEpochMillis: Long? = null,
    ) : SyncCommand {
        init {
            require(throughEpochMillis == null || throughEpochMillis >= 0) {
                "history clear timestamp must not be negative"
            }
        }
    }

    @Serializable
    @SerialName("patch_tracking")
    data class PatchTracking(
        override val entityId: EpigraphEntityId,
        val trackerId: String,
        val fields: List<TrackingFieldPatch>,
    ) : SyncCommand {
        init {
            validateProtocolIdentifier(trackerId, "tracker ID")
            require(fields.isNotEmpty()) { "tracking patch must contain at least one field" }
            require(fields.map(TrackingFieldPatch::field).distinct().size == fields.size) {
                "tracking patch must not contain duplicate fields"
            }
        }
    }

    @Serializable
    @SerialName("upsert_repository")
    data class UpsertRepository(
        override val entityId: EpigraphEntityId,
        val repository: RepositoryDescriptor,
    ) : SyncCommand

    @Serializable
    @SerialName("upsert_comic_extension")
    data class UpsertComicExtension(
        override val entityId: EpigraphEntityId,
        val extension: ComicExtensionDescriptor,
    ) : SyncCommand

    @Serializable
    @SerialName("upsert_novel_plugin")
    data class UpsertNovelPlugin(
        override val entityId: EpigraphEntityId,
        val plugin: NovelPluginDescriptor,
    ) : SyncCommand

    @Serializable
    @SerialName("set_asset_binding")
    data class SetAssetBinding(
        override val entityId: EpigraphEntityId,
        val asset: AssetDescriptor,
        val role: AssetRole,
        val bound: Boolean,
    ) : SyncCommand

    @Serializable
    @SerialName("set_entity_alias")
    data class SetEntityAlias(
        override val entityId: EpigraphEntityId,
        val canonicalEntityId: EpigraphEntityId,
        val active: Boolean,
    ) : SyncCommand {
        init {
            require(entityId != canonicalEntityId) { "an entity cannot alias itself" }
        }
    }

    @Serializable
    @SerialName("migrate_entity")
    data class MigrateEntity(
        override val entityId: EpigraphEntityId,
        val canonicalEntityId: EpigraphEntityId,
        val reason: IdentityMigrationReason,
        val preserveSourceTombstone: Boolean = true,
    ) : SyncCommand {
        init {
            require(entityId != canonicalEntityId) { "an entity cannot migrate to itself" }
        }
    }

    @Serializable
    @SerialName("delete_entity")
    data class DeleteEntity(
        override val entityId: EpigraphEntityId,
    ) : SyncCommand
}

/** Complete, non-secret metadata needed to publish a novel entry to Epigraph Core. */
@Serializable
data class NovelEntrySnapshot(
    val identityKey: String,
    val title: String,
    val author: String? = null,
    val description: String? = null,
    val coverUrl: String? = null,
    val path: String,
    val status: String? = null,
    val tags: List<String> = emptyList(),
    val source: kotlinx.serialization.json.JsonObject,
    val addedAtMs: Long,
    val updatedAtMs: Long,
)

@Serializable
data class BookEntrySnapshot(
    val bookId: EpigraphEntityId,
    val contentType: ContentType,
    val sha256: String,
    val title: String,
    val author: String? = null,
    val description: String? = null,
    val mimeType: String,
    val byteSize: Long,
    val coverAssetSha256: String? = null,
    val coverAssetByteSize: Long? = null,
    val coverAssetMimeType: String? = null,
    /** Optional display metadata; null is valid for an older/remote-only record. */
    val chapterCount: Int? = null,
    val pageCount: Int? = null,
    val createdAtEpochMillis: Long,
    val updatedAtEpochMillis: Long,
) {
    init {
        require(contentType == ContentType.EPUB || contentType == ContentType.PDF) {
            "book entries support only EPUB and PDF"
        }
        require(sha256.length == 64 && sha256.all { it in '0'..'9' || it in 'a'..'f' }) {
            "book SHA-256 must be lowercase hexadecimal"
        }
        require(title.isNotBlank()) { "book title must not be blank" }
        require(mimeType.isNotBlank()) { "book MIME type must not be blank" }
        require(byteSize >= 0) { "book byte size must not be negative" }
        require(chapterCount == null || chapterCount > 0) { "book chapter count must be positive" }
        require(pageCount == null || pageCount > 0) { "book page count must be positive" }
        val hasCover = coverAssetSha256 != null || coverAssetByteSize != null || coverAssetMimeType != null
        require(!hasCover || (coverAssetSha256 != null && coverAssetByteSize != null && coverAssetMimeType != null)) {
            "cover asset metadata must be complete"
        }
        require(coverAssetSha256 == null || (
            coverAssetSha256.length == 64 && coverAssetSha256.all { it in '0'..'9' || it in 'a'..'f' }
        )) { "cover SHA-256 must be lowercase hexadecimal" }
        require(coverAssetByteSize == null || coverAssetByteSize in 1..MAX_COVER_ASSET_BYTES) {
            "cover byte size is outside the supported limit"
        }
        require(coverAssetMimeType == null || coverAssetMimeType in COVER_MIME_TYPES) {
            "cover MIME type must be JPEG, PNG or WebP"
        }
        require(createdAtEpochMillis >= 0) { "book creation timestamp must not be negative" }
        require(updatedAtEpochMillis >= createdAtEpochMillis) {
            "book update timestamp must not precede creation"
        }
    }

    private companion object {
        const val MAX_COVER_ASSET_BYTES = 8L * 1024L * 1024L
        val COVER_MIME_TYPES = setOf("image/jpeg", "image/png", "image/webp")
    }
}

private fun lengthPrefixed(vararg values: String): String = buildString {
    append("v1|")
    values.forEach { value -> append(value.length).append(':').append(value) }
}
