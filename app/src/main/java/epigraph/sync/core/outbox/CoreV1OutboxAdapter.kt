package epigraph.sync.core.outbox

import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.CategoryScope
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.ReaderLocator
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.TrackingField
import epigraph.contract.NovelEntrySnapshot
import epigraph.contract.operationWireName
import epigraph.sync.core.novels.CoreNovelDependencyIds
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreEventClock
import epigraph.sync.core.protocol.CoreCompatibility
import epigraph.sync.core.protocol.CoreMutationInput
import epigraph.sync.core.protocol.CoreMutationOperation
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonObjectBuilder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URLEncoder
import java.security.MessageDigest

/**
 * Transport-neutral view of one persisted Android outbox row.
 *
 * The caller must supply a lamport clock because the current SQLDelight outbox deliberately does
 * not invent one from wall-clock time. [payloadJson] remains the canonical local protocol-v2
 * envelope and is never forwarded to Syncd.
 */
data class CoreOutboxRecord(
    val deviceId: String,
    val clientMutationId: String,
    val scopeId: String,
    val entityType: String,
    val entityId: String,
    val operation: String,
    val payloadJson: String,
    val createdAtEpochMillis: Long,
)

data class CoreOutboxIdentity(
    val deviceId: String,
    val clientMutationId: String,
)

sealed interface CoreOutboxAdaptation {
    val identity: CoreOutboxIdentity

    data class Ready(
        override val identity: CoreOutboxIdentity,
        val mutation: CoreMutationInput,
    ) : CoreOutboxAdaptation

    /** A blocked row remains pending and must never be acknowledged as synchronized. */
    data class Blocked(
        override val identity: CoreOutboxIdentity,
        val reason: CoreOutboxBlockReason,
        val errorCode: String,
    ) : CoreOutboxAdaptation
}

enum class CoreOutboxBlockReason {
    MALFORMED_LOCAL_PAYLOAD,
    LOCAL_PROTOCOL_MISMATCH,
    ROW_ENVELOPE_MISMATCH,
    AUTHENTICATED_DEVICE_MISMATCH,
    CORE_INCOMPATIBLE,
    ENTITY_NOT_SUPPORTED_BY_CORE_V1,
    ENTITY_CAPABILITY_NOT_ADVERTISED,
    INVALID_SCOPE,
    COMMAND_ENTITY_MISMATCH,
    UNSAFE_OR_INCOMPLETE_PROJECTION,
}

/**
 * Projects durable local protocol-v2 commands onto Syncd's current flat protocol-v1 mutation.
 *
 * This is intentionally fail-closed. A command is emitted only when every required Syncd field can
 * be derived without guessing. In particular, the serialized [SyncCommandEnvelope] is never placed
 * inside `patch`.
 */
class CoreV1OutboxAdapter(
    private val json: Json = Json {
        classDiscriminator = "operation"
        encodeDefaults = true
        ignoreUnknownKeys = false
    },
) {
    fun adapt(
        record: CoreOutboxRecord,
        authenticatedDeviceId: String,
        capabilities: CoreCapabilities,
        lamport: Long,
        eventLogical: Long = lamport,
    ): CoreOutboxAdaptation {
        val identity = CoreOutboxIdentity(record.deviceId, record.clientMutationId)
        if (lamport < 0) {
            return identity.blocked(
                CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION,
                "invalid_lamport",
            )
        }
        if (record.createdAtEpochMillis < 0) {
            return identity.blocked(
                CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION,
                "invalid_outbox_timestamp",
            )
        }
        if (eventLogical < 0) {
            return identity.blocked(
                CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION,
                "invalid_event_clock",
            )
        }

        val envelope = try {
            json.decodeFromString<SyncCommandEnvelope>(record.payloadJson)
        } catch (_: SerializationException) {
            return identity.blocked(
                CoreOutboxBlockReason.MALFORMED_LOCAL_PAYLOAD,
                "malformed_local_payload",
            )
        } catch (_: IllegalArgumentException) {
            return identity.blocked(
                CoreOutboxBlockReason.MALFORMED_LOCAL_PAYLOAD,
                "invalid_local_payload",
            )
        }

        if (envelope.protocolVersion != EpigraphSyncProtocol.CURRENT_VERSION) {
            return identity.blocked(
                CoreOutboxBlockReason.LOCAL_PROTOCOL_MISMATCH,
                "local_protocol_mismatch",
            )
        }
        if (record.deviceId != envelope.deviceId.value || record.clientMutationId != envelope.clientMutationId.value ||
            record.scopeId != envelope.scopeId.value || record.entityType != envelope.entityType.value ||
            record.entityId != envelope.command.entityId.value ||
            record.operation != envelope.command.operationWireName()
        ) {
            return identity.blocked(
                CoreOutboxBlockReason.ROW_ENVELOPE_MISMATCH,
                "outbox_envelope_mismatch",
            )
        }
        if (authenticatedDeviceId != record.deviceId) {
            return identity.blocked(
                CoreOutboxBlockReason.AUTHENTICATED_DEVICE_MISMATCH,
                "authenticated_device_mismatch",
            )
        }

        if (EpigraphCoreCompatibilityEvaluator.evaluate(capabilities) !is CoreCompatibility.Compatible) {
            return identity.blocked(CoreOutboxBlockReason.CORE_INCOMPATIBLE, "core_v1_incompatible")
        }
        if (record.entityType !in CORE_V1_ENTITY_TYPES) {
            return identity.blocked(
                CoreOutboxBlockReason.ENTITY_NOT_SUPPORTED_BY_CORE_V1,
                "entity_not_supported_by_core_v1",
            )
        }
        if (!EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, record.entityType)) {
            return identity.blocked(
                CoreOutboxBlockReason.ENTITY_CAPABILITY_NOT_ADVERTISED,
                "entity_capability_not_advertised",
            )
        }
        if (!scopeMatchesEntity(record.scopeId, record.entityType)) {
            return identity.blocked(CoreOutboxBlockReason.INVALID_SCOPE, "invalid_scope_for_entity")
        }

        val projection = project(record, envelope.command, capabilities)
            ?: return identity.blocked(
                CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION,
                "command_has_no_lossless_core_v1_projection",
            )
        if (projection.entityId.isBlank()) {
            return identity.blocked(
                CoreOutboxBlockReason.COMMAND_ENTITY_MISMATCH,
                "invalid_projected_entity_id",
            )
        }

        return CoreOutboxAdaptation.Ready(
            identity = identity,
            mutation = CoreMutationInput(
                entityType = record.entityType,
                clientMutationId = record.clientMutationId,
                scopeId = record.scopeId,
                entityId = projection.entityId,
                op = projection.operation,
                lamport = lamport,
                eventClock = if (capabilities.supportsCausalMutationsV3) {
                    CoreEventClock(
                        physicalMs = record.createdAtEpochMillis,
                        logical = eventLogical,
                        deviceGenerationId = authenticatedDeviceId,
                    )
                } else {
                    null
                },
                patch = projection.patch,
            ),
        )
    }

    private fun project(
        record: CoreOutboxRecord,
        command: SyncCommand,
        capabilities: CoreCapabilities,
    ): Projection? = when (command) {
        is SyncCommand.DeleteEntity -> projectDelete(record)
        is SyncCommand.SetNovelLibraryMembership -> projectNovelLibraryMembership(record, command)
        is SyncCommand.SetLibraryMembership -> projectComicLibraryMembership(record, command)
        is SyncCommand.UpsertCategory -> projectCategory(record, command)
        is SyncCommand.SetCategoryAssignment -> projectCategoryAssignment(record, command)
        is SyncCommand.SetBookCategoryAssignments -> projectBookCategoryAssignments(record, command)
        is SyncCommand.UpsertBookEntry -> projectBookEntry(record, command)
        is SyncCommand.UpsertBookBookmark -> projectBookBookmark(record, command)
        is SyncCommand.UpsertBookHighlight -> projectBookHighlight(record, command)
        is SyncCommand.SetChapterState -> projectComicChapterState(record, command)
        is SyncCommand.SetNovelChapterState -> projectNovelChapterState(record, command)
        is SyncCommand.SetNovelChapterBookmark -> projectNovelChapterBookmark(record, command)
        is SyncCommand.SetProgress -> projectComicProgress(record, command, capabilities)
            ?: projectNovelProgress(record, command, capabilities)
            ?: projectBookProgress(record, command)
        is SyncCommand.AppendHistory -> projectBookHistory(record, command)
            ?: projectNovelHistory(record, command)
        is SyncCommand.PatchTracking -> projectTracking(record, command)
        is SyncCommand.UpsertRepository -> projectNovelRepository(record, command)
        is SyncCommand.UpsertNovelPlugin -> projectNovelPlugin(record, command)
        else -> null
    }

    /**
     * LNReader repository declaration. The id must be the Core's digest of the canonical URL, or
     * the Core would reject it; `createdAtMs` is 0 like the desktop's, so either device may own it.
     */
    private fun projectNovelRepository(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertRepository,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_REPOSITORY) return null
        val repository = command.repository
        if (repository.ecosystem != LNREADER_ECOSYSTEM) return null
        val canonicalUrl = CoreNovelDependencyIds.canonicalRepositoryUrl(repository.canonicalUrl) ?: return null
        if (canonicalUrl != repository.canonicalUrl) return null
        if (record.entityId != CoreNovelDependencyIds.repositoryId(canonicalUrl)) return null
        if (repository.displayName.toByteArray().size > MAX_NOVEL_REPOSITORY_NAME_BYTES) return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("canonicalUrl", canonicalUrl)
                put("name", repository.displayName)
                put("enabled", repository.enabled)
                put("createdAtMs", 0)
                put("updatedAtMs", record.createdAtEpochMillis)
            },
        )
    }

    /**
     * LNReader plugin evidence: which repository declares it and the hash/size of the installed
     * artifact. Executable bytes never cross Syncd; the other device installs from the repository.
     */
    private fun projectNovelPlugin(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertNovelPlugin,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_PLUGIN) return null
        val plugin = command.plugin
        val sourceId = plugin.sourceId ?: return null
        val lang = plugin.lang ?: return null
        val byteLength = plugin.artifactByteLength?.takeIf { it in 1..MAX_NOVEL_PLUGIN_ARTIFACT_BYTES } ?: return null
        val repositoryId = plugin.repositoryId.value
        if (!repositoryId.startsWith(NOVEL_REPOSITORY_ID_PREFIX)) return null
        if (record.entityId != CoreNovelDependencyIds.pluginId(repositoryId, plugin.pluginId, sourceId)) return null
        val withinLimits = listOf(
            plugin.pluginId to MAX_NOVEL_PLUGIN_ID_BYTES,
            sourceId to MAX_NOVEL_PLUGIN_ID_BYTES,
            plugin.displayName to MAX_NOVEL_PLUGIN_NAME_BYTES,
            plugin.version to MAX_NOVEL_PLUGIN_VERSION_BYTES,
            lang to MAX_NOVEL_PLUGIN_LANG_BYTES,
        ).all { (value, limit) -> value.toByteArray().size <= limit }
        if (!withinLimits) return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("repositoryId", repositoryId)
                put("pluginId", plugin.pluginId)
                put("sourceId", sourceId)
                put("name", plugin.displayName)
                put("version", plugin.version)
                put("lang", lang)
                put("enabled", plugin.desiredInstalled)
                put("artifactSha256", plugin.artifactSha256)
                put("artifactByteLength", byteLength)
                put("publicSettings", buildJsonObject { })
                put("createdAtMs", 0)
                put("updatedAtMs", record.createdAtEpochMillis)
            },
        )
    }

    /**
     * Serde-compatible encoding of a portable work ref. The Core (syncd) models these as
     * internally-tagged enums (`#[serde(tag = "type", rename_all = "lowercase")]`), so the
     * discriminator must be present even when the local field is typed as a concrete subclass
     * (kotlinx would otherwise omit it and Syncd rejects the mutation with 422).
     */
    private fun portableWorkRefJson(ref: PortableWorkRef): JsonObject = when (ref) {
        is PortableWorkRef.Comic -> buildJsonObject {
            put("type", "comic")
            put("sourceId", ref.sourceId.value)
            put("mangaKey", ref.mangaKey.value)
        }
        is PortableWorkRef.Novel -> buildJsonObject {
            put("type", "novel")
            put("pluginId", ref.pluginId)
            put("novelKey", ref.novelKey.value)
        }
    }

    private fun portableChapterRefJson(ref: PortableChapterRef): JsonObject = when (ref) {
        is PortableChapterRef.Comic -> buildJsonObject {
            put("type", "comic")
            put("work", portableWorkRefJson(ref.work))
            put("chapterKey", ref.chapterKey.value)
        }
        is PortableChapterRef.Novel -> buildJsonObject {
            put("type", "novel")
            put("work", portableWorkRefJson(ref.work))
            put("chapterKey", ref.chapterKey.value)
        }
    }

    private fun projectNovelLibraryMembership(
        record: CoreOutboxRecord,
        command: SyncCommand.SetNovelLibraryMembership,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_ENTRY) return null
        if (!command.inLibrary) {
            return Projection(record.entityId, CoreMutationOperation.DELETE, null)
        }
        val entry = command.entry ?: return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                entry.toPatch().forEach { (key, value) -> put(key, value) }
                command.portableWorkRef?.let { put("portableWorkRef", portableWorkRefJson(it)) }
            },
        )
    }

    private fun projectComicLibraryMembership(
        record: CoreOutboxRecord,
        command: SyncCommand.SetLibraryMembership,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.COMIC_ENTRY) return null
        if (!command.inLibrary) {
            return Projection(record.entityId, CoreMutationOperation.DELETE, null)
        }
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("comicId", record.entityId)
                put("inLibrary", true)
                command.portableWorkRef?.let { put("portableWorkRef", portableWorkRefJson(it)) }
                command.titleHint?.let { put("titleHint", it) }
            },
        )
    }

    private fun projectCategoryAssignment(
        record: CoreOutboxRecord,
        command: SyncCommand.SetCategoryAssignment,
    ): Projection? {
        val assignmentId = when (record.entityType) {
            EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT -> canonicalNovelCategoryAssignmentId(
                novelId = record.entityId,
                categoryId = command.categoryId.value,
            )
            EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT -> canonicalComicCategoryAssignmentId(
                comicId = record.entityId,
                categoryId = command.categoryId.value,
            )
            else -> return null
        }
        if (!command.assigned) {
            return Projection(assignmentId, CoreMutationOperation.DELETE, null)
        }
        return Projection(
            entityId = assignmentId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("assignmentId", assignmentId)
                if (record.entityType == EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT) {
                    put("novelId", record.entityId)
                } else {
                    put("comicId", record.entityId)
                }
                put("categoryId", command.categoryId.value)
                // The Core's novel assignment patch denies unknown fields; an extra key fails the
                // whole mutation batch with 422. Only the comic patch carries a portable work ref.
                if (record.entityType == EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT) {
                    command.portableWorkRef?.let { put("portableWorkRef", portableWorkRefJson(it)) }
                }
            },
        )
    }

    private fun projectBookCategoryAssignments(
        record: CoreOutboxRecord,
        command: SyncCommand.SetBookCategoryAssignments,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_CATEGORY_ASSIGNMENT) return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("bookId", command.entityId.value)
                put(
                    "categoryIds",
                    kotlinx.serialization.json.JsonArray(command.categoryIds.map { JsonPrimitive(it.value) }),
                )
            },
        )
    }

    private fun projectBookEntry(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertBookEntry,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_ENTRY) return null
        val entry = command.entry
        if (entry.bookId.value != record.entityId || entry.sha256 != record.entityId.substringAfterLast(':')) {
            return null
        }
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("assetFingerprint", entry.sha256)
                put("mimeType", entry.mimeType)
                put("byteSize", entry.byteSize)
                putNullableString("coverAssetSha256", entry.coverAssetSha256)
                entry.coverAssetByteSize?.let { put("coverAssetByteSize", it) }
                putNullableString("coverAssetMimeType", entry.coverAssetMimeType)
                put("title", entry.title)
                putNullableString("author", entry.author)
                putNullableString("description", entry.description)
                put("subtype", entry.contentType.name.lowercase())
                if (entry.pageCount != null) {
                    put("pageCount", entry.pageCount)
                } else {
                    put("pageCount", JsonNull)
                }
                if (entry.chapterCount != null) {
                    val count = entry.chapterCount
                    put("tocCount", count)
                    put("spineCount", count)
                    put("sectionCount", count)
                } else {
                    put("tocCount", JsonNull)
                    put("spineCount", JsonNull)
                    put("sectionCount", JsonNull)
                }
                put("sectionsSummaryJson", JsonNull)
                put("hasCover", entry.coverAssetSha256 != null)
                put("createdAtMs", entry.createdAtEpochMillis)
                put("bookUpdatedAtMs", entry.updatedAtEpochMillis)
            },
        )
    }

    private fun projectBookBookmark(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertBookBookmark,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_BOOKMARK) return null
        val locator = command.locator.toBookLocation() ?: return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("bookId", command.bookId.value)
                putNullableString("location", locator.location)
                put("href", JsonNull)
                put("pageIndex", locator.pageIndex?.let(::JsonPrimitive) ?: JsonNull)
                put("progressPercent", locator.progression)
                putNullableString("label", command.label)
                putNullableString("note", command.note)
                put("createdAtMs", command.createdAtEpochMillis)
                put("updatedAtMs", command.updatedAtEpochMillis)
                put("savedAtMs", command.updatedAtEpochMillis)
            },
        )
    }

    private fun projectBookHighlight(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertBookHighlight,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_HIGHLIGHT) return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("highlightId", record.entityId)
                put("bookId", command.bookId.value)
                put("startLocatorJson", json.encodeToJsonElement(ReaderLocator.serializer(), command.start))
                put("endLocatorJson", json.encodeToJsonElement(ReaderLocator.serializer(), command.end))
                put("selectedText", command.selectedText)
                put("colorArgb", command.colorArgb)
                putNullableString("note", command.note)
                put("createdAtMs", command.createdAtEpochMillis)
                put("updatedAtMs", command.updatedAtEpochMillis)
            },
        )
    }

    private fun projectDelete(record: CoreOutboxRecord): Projection? {
        if (record.entityType !in CORE_V1_DELETABLE_ENTITY_TYPES) return null
        return Projection(record.entityId, CoreMutationOperation.DELETE, null)
    }

    /**
     * Tracker bindings are full-state, non-secret records keyed by
     * `<entityType>::<workId>::<trackerKey>`. The work ID is the same Core ID used by the entry
     * record, so the Core resolves the work without a separate portable reference. Every field the
     * local router emits is required; a partial patch would let an older device erase data.
     */
    private fun projectTracking(
        record: CoreOutboxRecord,
        command: SyncCommand.PatchTracking,
    ): Projection? {
        val workKey = when (record.entityType) {
            EpigraphCoreEntityType.NOVEL_TRACKING -> "novelId"
            EpigraphCoreEntityType.COMIC_TRACKING -> "comicId"
            else -> return null
        }
        val prefix = "${record.entityType}::"
        val suffix = "::${command.trackerId}"
        if (!record.entityId.startsWith(prefix) || !record.entityId.endsWith(suffix)) return null
        val workId = record.entityId.substring(prefix.length, record.entityId.length - suffix.length)
        if (workId.isBlank() || workId != workId.trim()) return null
        // Comic tracking is portable-only; novels may still use their pre-portable identity.
        if (workKey == "comicId" && !workId.startsWith("comic:")) return null

        val fields = command.fields.associate { it.field to it.value }
        if (!fields.keys.containsAll(REQUIRED_TRACKING_FIELDS)) return null
        val remoteId = fields[TrackingField.REMOTE_ID]?.toLongOrNull() ?: return null
        val libraryId = fields[TrackingField.LIBRARY_ID]?.let { it.toLongOrNull() ?: return null }
        val title = fields[TrackingField.TITLE] ?: return null
        val remoteUrl = fields[TrackingField.REMOTE_URL] ?: return null
        val status = fields[TrackingField.STATUS]?.toLongOrNull() ?: return null
        val progress = fields[TrackingField.PROGRESS]?.toDoubleOrNull()?.takeIf(Double::isFinite) ?: return null
        val totalChapters = fields[TrackingField.TOTAL_CHAPTERS]?.toLongOrNull() ?: return null
        val score = fields[TrackingField.SCORE]?.toDoubleOrNull()?.takeIf(Double::isFinite) ?: return null
        val startedAt = fields[TrackingField.STARTED_AT]?.toLongOrNull() ?: return null
        val finishedAt = fields[TrackingField.FINISHED_AT]?.toLongOrNull() ?: return null

        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("trackingId", record.entityId)
                put(workKey, workId)
                put("trackerKey", command.trackerId)
                put("remoteId", remoteId)
                put("libraryId", libraryId?.let(::JsonPrimitive) ?: JsonNull)
                put("title", title)
                put("remoteUrl", remoteUrl)
                put("status", status)
                put("progress", progress)
                put("totalChapters", totalChapters)
                put("score", score)
                put("startedAtMs", startedAt)
                put("finishedAtMs", finishedAt)
                put("updatedAtMs", record.createdAtEpochMillis)
            },
        )
    }

    private fun projectCategory(
        record: CoreOutboxRecord,
        command: SyncCommand.UpsertCategory,
    ): Projection? {
        val expectedScope = when (record.entityType) {
            EpigraphCoreEntityType.BOOK_CATEGORY -> CategoryScope.BOOK
            EpigraphCoreEntityType.NOVEL_CATEGORY -> CategoryScope.NOVEL
            EpigraphCoreEntityType.COMIC_CATEGORY -> CategoryScope.MANGA
            else -> return null
        }
        if (command.scope != expectedScope) return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("categoryId", command.entityId.value)
                put("name", command.name)
                put("order", command.position)
            },
        )
    }

    private fun projectBookProgress(
        record: CoreOutboxRecord,
        command: SyncCommand.SetProgress,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_PROGRESS) return null
        val locator = command.locator.toBookLocation() ?: return null
        return Projection(
            entityId = record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("renderer", locator.renderer)
                putNullableString("location", locator.location)
                put("href", JsonNull)
                put("progressPercent", locator.progression)
                put("lastReadAtMs", record.createdAtEpochMillis)
                put("pageIndex", locator.pageIndex?.let(::JsonPrimitive) ?: JsonNull)
                put("totalPages", locator.totalPages?.let(::JsonPrimitive) ?: JsonNull)
                put("sectionLabel", JsonNull)
                put("reset", command.explicitReset)
            },
        )
    }

    private fun projectComicProgress(
        record: CoreOutboxRecord,
        command: SyncCommand.SetProgress,
        capabilities: CoreCapabilities,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.COMIC_HISTORY) return null
        val locator = command.locator as? ReaderLocator.Manga ?: return null
        val portable = capabilities.supportsPortableSyncV3 &&
            locator.portableWork != null && locator.portableChapter != null
        val comicId = if (portable) PortableIdentityV3.workId(requireNotNull(locator.portableWork)) else locator.entityId.value
        val chapterId = if (portable) PortableIdentityV3.chapterId(requireNotNull(locator.portableChapter)) else locator.chapterId
        val historyId = "comic.history::$comicId"
        return Projection(
            entityId = historyId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("historyId", historyId)
                put("comicId", comicId)
                put("chapterId", chapterId)
                put("pageIndex", locator.pageIndex)
                if (locator.pageCount != null) {
                    put("pageCount", locator.pageCount)
                } else {
                    put("pageCount", JsonNull)
                }
                put("progressPercent", locator.progression)
                put("readAtMs", record.createdAtEpochMillis)
                if (
                    portable
                ) {
                    put("portableWorkRef", portableWorkRefJson(requireNotNull(locator.portableWork)))
                    put("portableChapterRef", portableChapterRefJson(requireNotNull(locator.portableChapter)))
                }
            },
        )
    }

    private fun projectComicChapterState(
        record: CoreOutboxRecord,
        command: SyncCommand.SetChapterState,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.COMIC_CHAPTER_STATE) return null
        val state = command.state
        val portable = state.portableWorkRef != null && state.portableChapterRef != null
        val chapterId = if (portable) PortableIdentityV3.chapterId(requireNotNull(state.portableChapterRef)) else state.chapterId
        val comicId = if (portable) {
            PortableIdentityV3.workId(requireNotNull(state.portableWorkRef))
        } else {
            comicIdOfChapterState(record.entityId, chapterId)
        }
        val chapterStateId = "comic.chapter_state::$comicId::$chapterId"
        return Projection(
            entityId = chapterStateId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("chapterStateId", chapterStateId)
                put("comicId", comicId)
                put("chapterId", chapterId)
                if (portable) {
                    put("portableWorkRef", portableWorkRefJson(requireNotNull(state.portableWorkRef)))
                    put("portableChapterRef", portableChapterRefJson(requireNotNull(state.portableChapterRef)))
                }
                put("read", state.read?.let(::JsonPrimitive) ?: JsonNull)
                put("bookmarked", state.bookmarked?.let(::JsonPrimitive) ?: JsonNull)
                put("lastPageRead", state.lastPageRead?.let(::JsonPrimitive) ?: JsonNull)
                put("lastReadAtMs", state.lastReadAtEpochMillis?.let(::JsonPrimitive) ?: JsonNull)
                put("updatedAtMs", record.createdAtEpochMillis)
                put("explicitProgressReset", state.explicitProgressReset)
            },
        )
    }

    /**
     * The reader router keys chapter-state rows as `comic.chapter_state::<comic>::<chapter>`;
     * older rows used the bare comic id. Sending the composite as `comicId` makes the Core reject
     * the mutation as a foreign Suwayomi identity.
     */
    private fun comicIdOfChapterState(entityId: String, chapterId: String): String {
        val suffix = "::$chapterId"
        if (!entityId.startsWith(COMIC_CHAPTER_STATE_PREFIX) || !entityId.endsWith(suffix)) return entityId
        return entityId.substring(COMIC_CHAPTER_STATE_PREFIX.length, entityId.length - suffix.length)
            .takeIf { it.isNotBlank() } ?: entityId
    }

    private fun projectNovelProgress(
        record: CoreOutboxRecord,
        command: SyncCommand.SetProgress,
        capabilities: CoreCapabilities,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_PROGRESS) return null
        val locator = command.locator as? ReaderLocator.Novel ?: return null
        val portable = capabilities.supportsPortableSyncV3 &&
            locator.portableWork != null && locator.portableChapter != null
        val novelId = if (portable) PortableIdentityV3.workId(requireNotNull(locator.portableWork)) else record.entityId
        val chapterId = if (portable) PortableIdentityV3.chapterId(requireNotNull(locator.portableChapter)) else locator.chapterId
        return Projection(
            entityId = if (portable) "novel.progress::$novelId" else record.entityId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                putNullableString("chapterId", chapterId)
                put("chapterTitle", JsonNull)
                if (locator.chapterOrderKey != null) {
                    put("chapterOrderKey", locator.chapterOrderKey)
                } else {
                    put("chapterOrderKey", JsonNull)
                }
                put("progressPercent", locator.progression)
                put("locator", "block:${locator.blockIndex}:${locator.textOffset}")
                put("locatorSortKey", locator.textOffset.toDouble())
                put("updatedAtMs", record.createdAtEpochMillis)
                put("reset", command.explicitReset)
                if (portable) {
                    put("portableWorkRef", portableWorkRefJson(requireNotNull(locator.portableWork)))
                    put("portableChapterRef", portableChapterRefJson(requireNotNull(locator.portableChapter)))
                }
            },
        )
    }

    private fun projectNovelChapterState(
        record: CoreOutboxRecord,
        command: SyncCommand.SetNovelChapterState,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_CHAPTER) return null
        return Projection(
            entityId = command.entityId.value,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("novelId", command.novelId.value)
                put("path", command.path)
                put("title", command.title)
                put("chapterOrderKey", command.chapterOrderKey)
                put("releaseTimeMs", command.releaseTimeEpochMillis?.let(::JsonPrimitive) ?: JsonNull)
                put("unread", command.unread)
            },
        )
    }

    private fun projectNovelChapterBookmark(
        record: CoreOutboxRecord,
        command: SyncCommand.SetNovelChapterBookmark,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_BOOKMARK) return null
        if (!command.bookmarked) {
            return Projection(command.entityId.value, CoreMutationOperation.DELETE, null)
        }
        val locator = command.locator
        return Projection(
            entityId = command.entityId.value,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("novelId", command.novelId.value)
                put("chapterId", locator.chapterId)
                putNullableString("chapterTitle", command.chapterTitle)
                put("chapterOrderKey", locator.chapterOrderKey?.let(::JsonPrimitive) ?: JsonNull)
                put("locator", "block:${locator.blockIndex}:${locator.textOffset}")
                put("locatorSortKey", locator.textOffset.toDouble())
                put("label", JsonNull)
                put("savedAtMs", command.savedAtEpochMillis)
            },
        )
    }

    private fun projectBookHistory(
        record: CoreOutboxRecord,
        command: SyncCommand.AppendHistory,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.BOOK_HISTORY) return null
        val locator = command.locator as? ReaderLocator.Epub ?: return null
        return Projection(
            entityId = command.entryId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("historyId", command.entryId)
                put("bookId", command.entityId.value)
                put("renderer", "epub")
                putNullableString("location", locator.cfi)
                put("href", JsonNull)
                put("pageIndex", JsonNull)
                put("progressPercent", locator.progression)
                put("sectionLabel", JsonNull)
                put("readAtMs", command.visitedAtEpochMillis)
            },
        )
    }

    /**
     * The desktop lists history by its local chapter id, `chapter:novel:<plugin>:<work>:<chapter>`
     * with keys encoded like `encodeURIComponent`; the replica projection parses that form back.
     */
    private fun projectNovelHistory(
        record: CoreOutboxRecord,
        command: SyncCommand.AppendHistory,
    ): Projection? {
        if (record.entityType != EpigraphCoreEntityType.NOVEL_HISTORY) return null
        val locator = command.locator as? ReaderLocator.Novel ?: return null
        val work = locator.portableWork ?: return null
        val chapter = locator.portableChapter ?: return null
        return Projection(
            entityId = command.entryId,
            operation = CoreMutationOperation.MERGE,
            patch = buildJsonObject {
                put("novelId", PortableIdentityV3.workId(work))
                put(
                    "chapterId",
                    "chapter:novel:${work.pluginId}:${encodeUriComponent(work.novelKey.value)}:" +
                        encodeUriComponent(chapter.chapterKey.value),
                )
                putNullableString("chapterTitle", command.chapterTitle)
                put("locator", "block:${locator.blockIndex}:${locator.textOffset}")
                put("readAtMs", command.visitedAtEpochMillis)
            },
        )
    }

    private fun scopeMatchesEntity(scopeId: String, entityType: String): Boolean = when {
        entityType.startsWith("book.") -> scopeId == BOOKS_GLOBAL_SCOPE
        entityType.startsWith("novel.") -> hasNonEmptyProfileId(scopeId, NOVELS_PROFILE_SCOPE_PREFIX)
        entityType.startsWith("comic.") -> hasNonEmptyProfileId(scopeId, COMICS_PROFILE_SCOPE_PREFIX)
        else -> false
    }

    private fun hasNonEmptyProfileId(scopeId: String, prefix: String): Boolean {
        if (!scopeId.startsWith(prefix)) return false
        val profileId = scopeId.removePrefix(prefix)
        return profileId.isNotBlank() && profileId == profileId.trim()
    }

    private data class Projection(
        val entityId: String,
        val operation: CoreMutationOperation,
        val patch: JsonObject?,
    )

    private data class BookLocation(
        val renderer: String,
        val location: String?,
        val pageIndex: Int?,
        val totalPages: Int?,
        val progression: Double,
    )

    private fun ReaderLocator.toBookLocation(): BookLocation? = when (this) {
        is ReaderLocator.Epub -> BookLocation("epub", cfi, null, null, progression)
        is ReaderLocator.Pdf -> {
            val overallProgress = documentProgression ?: return null
            // Core `book.*` records carry the 1-based PDF page number that Epigraph desktop reads
            // and writes; the Android reader counts pages from zero.
            BookLocation("pdf", null, pageIndex + 1, totalPages, overallProgress)
        }
        else -> null
    }

    private fun NovelEntrySnapshot.toPatch(): JsonObject = buildJsonObject {
        put("identityKey", identityKey)
        put("title", title)
        putNullableString("author", author)
        putNullableString("description", description)
        putNullableString("coverUrl", coverUrl)
        put("path", path)
        putNullableString("status", status)
        put("tags", kotlinx.serialization.json.JsonArray(tags.map(::JsonPrimitive)))
        put("source", source)
        put("addedAtMs", addedAtMs)
        put("updatedAtMs", updatedAtMs)
    }

    private fun canonicalNovelCategoryAssignmentId(novelId: String, categoryId: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(novelId.toByteArray(Charsets.UTF_8))
        digest.update(0)
        digest.update(categoryId.toByteArray(Charsets.UTF_8))
        return "novel-category-assignment:" + digest.digest().joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        }
    }

    private fun canonicalComicCategoryAssignmentId(comicId: String, categoryId: String): String {
        val digest = MessageDigest.getInstance("SHA-256")
        digest.update(comicId.toByteArray(Charsets.UTF_8))
        digest.update(0)
        digest.update(categoryId.toByteArray(Charsets.UTF_8))
        return "comic-category-assignment:" + digest.digest().joinToString("") {
            "%02x".format(it.toInt() and 0xff)
        }
    }

    private companion object {
        const val LNREADER_ECOSYSTEM = "lnreader"
        const val NOVEL_REPOSITORY_ID_PREFIX = "novel-repository:"
        const val MAX_NOVEL_REPOSITORY_NAME_BYTES = 200
        const val MAX_NOVEL_PLUGIN_ID_BYTES = 256
        const val MAX_NOVEL_PLUGIN_NAME_BYTES = 200
        const val MAX_NOVEL_PLUGIN_VERSION_BYTES = 100
        const val MAX_NOVEL_PLUGIN_LANG_BYTES = 35
        const val MAX_NOVEL_PLUGIN_ARTIFACT_BYTES = 2_097_152L
        const val BOOKS_GLOBAL_SCOPE = "books:global"
        const val NOVELS_PROFILE_SCOPE_PREFIX = "novels:profile:"
        const val COMICS_PROFILE_SCOPE_PREFIX = "comics:profile:"
        private const val COMIC_CHAPTER_STATE_PREFIX = "comic.chapter_state::"

        val CORE_V1_ENTITY_TYPES = setOf(
            EpigraphCoreEntityType.BOOK_ENTRY,
            EpigraphCoreEntityType.BOOK_CATEGORY,
            EpigraphCoreEntityType.BOOK_CATEGORY_ASSIGNMENT,
            EpigraphCoreEntityType.BOOK_LIBRARY_UI,
            EpigraphCoreEntityType.BOOK_PROGRESS,
            EpigraphCoreEntityType.BOOK_BOOKMARK,
            EpigraphCoreEntityType.BOOK_HIGHLIGHT,
            EpigraphCoreEntityType.BOOK_HISTORY,
            EpigraphCoreEntityType.NOVEL_ENTRY,
            EpigraphCoreEntityType.NOVEL_CHAPTER,
            EpigraphCoreEntityType.NOVEL_CHAPTER_ASSET,
            EpigraphCoreEntityType.NOVEL_PROGRESS,
            EpigraphCoreEntityType.NOVEL_BOOKMARK,
            EpigraphCoreEntityType.NOVEL_HISTORY,
            EpigraphCoreEntityType.NOVEL_CLASSIFICATION,
            EpigraphCoreEntityType.NOVEL_REPOSITORY,
            EpigraphCoreEntityType.NOVEL_PLUGIN,
            EpigraphCoreEntityType.NOVEL_CATEGORY,
            EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT,
            EpigraphCoreEntityType.COMIC_ENTRY,
            EpigraphCoreEntityType.COMIC_CATEGORY,
            EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT,
            EpigraphCoreEntityType.COMIC_CHAPTER_STATE,
            EpigraphCoreEntityType.COMIC_HISTORY,
            EpigraphCoreEntityType.COMIC_PAGE_BOOKMARK,
            EpigraphCoreEntityType.COMIC_TRACKING,
            EpigraphCoreEntityType.NOVEL_TRACKING,
        )

        val REQUIRED_TRACKING_FIELDS = setOf(
            TrackingField.REMOTE_ID,
            TrackingField.LIBRARY_ID,
            TrackingField.TITLE,
            TrackingField.REMOTE_URL,
            TrackingField.STATUS,
            TrackingField.PROGRESS,
            TrackingField.TOTAL_CHAPTERS,
            TrackingField.SCORE,
            TrackingField.STARTED_AT,
            TrackingField.FINISHED_AT,
        )

        val CORE_V1_DELETABLE_ENTITY_TYPES = CORE_V1_ENTITY_TYPES - setOf(
            EpigraphCoreEntityType.BOOK_LIBRARY_UI,
            EpigraphCoreEntityType.BOOK_PROGRESS,
            EpigraphCoreEntityType.NOVEL_PROGRESS,
        )
    }
}

private fun CoreOutboxIdentity.blocked(
    reason: CoreOutboxBlockReason,
    errorCode: String,
): CoreOutboxAdaptation.Blocked = CoreOutboxAdaptation.Blocked(this, reason, errorCode)

private fun JsonObjectBuilder.putNullableString(key: String, value: String?) {
    put(key, value?.let(::JsonPrimitive) ?: JsonNull)
}

/** Matches JavaScript's `encodeURIComponent`, which the desktop uses for its local ids. */
private fun encodeUriComponent(value: String): String =
    URLEncoder.encode(value, Charsets.UTF_8.name())
        .replace("+", "%20")
        .replace("%21", "!")
        .replace("%27", "'")
        .replace("%28", "(")
        .replace("%29", ")")
        .replace("%7E", "~")
