package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.ClientMutationId
import epigraph.contract.ChapterStatePatch
import epigraph.contract.DeviceId
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.ReaderLocator
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.PortableChapterBindingRecord
import java.security.MessageDigest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A novel progress write that can be committed together with its Core outbox row. */
data class NovelReaderProgressMutationResult(
    val emitted: Boolean,
    val entityId: EpigraphEntityId? = null,
    val chapterEntityId: String? = null,
)

data class ComicReaderProgressMutationResult(
    val emitted: Boolean,
    val entityId: EpigraphEntityId? = null,
    val chapterEntityId: String? = null,
)

/**
 * Bridges the existing chapter reader to the Epigraph protocol without changing the reader's
 * domain semantics. If a source/chapter has not been assigned a stable Epigraph binding yet, the
 * local progress remains valid but no guessed mutation is emitted; bootstrap/source binding can
 * safely retry it later.
 */
class EpigraphReaderProgressRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val scopeId: SyncScopeId,
    private val mutationIds: ClientMutationIdFactory,
    private val comicScopeId: SyncScopeId = SyncScopeId("comics:profile:legacy_unbound"),
    private val clock: () -> Long = System::currentTimeMillis,
    private val locatorJson: Json = Json { encodeDefaults = true },
    private val scopeProvider: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider {
        EpigraphSyncScopes(scopeId, comicScopeId)
    },
) {
    /** Returns the persisted locator only when it belongs to the requested local novel chapter. */
    suspend fun getNovelLocator(
        localMangaId: Long,
        localChapterId: Long,
    ): ReaderLocator.Novel? {
        require(localMangaId > 0) { "local manga ID must be positive" }
        require(localChapterId > 0) { "local chapter ID must be positive" }
        return coordinator.readLocal {
            val portableStore = SqlDelightPortableBindingStore(this)
            val portableWorkBinding = portableStore.workByLocalReference(localMangaId.toString())
                ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            val portableWork = portableWorkBinding?.ref as? PortableWorkRef.Novel
            val portableChapterBinding = portableStore.chapterByLocalReference(localChapterId.toString())
                ?.takeIf { it.portableWorkId == portableWorkBinding?.portableId }
            val portableChapter = portableChapterBinding?.ref as? PortableChapterRef.Novel
            val legacyIdentity = aethon_syncQueries
                .selectIdentityByLocalReference("NOVEL", localMangaId.toString())
                .executeAsOneOrNull()
            val entityId = portableWorkBinding?.portableId ?: legacyIdentity?.entity_id
                ?: return@readLocal null
            val expectedChapterId = portableChapterBinding?.portableChapterId
                ?: aethon_syncQueries.selectChapterBindingByLocalChapterId(localChapterId)
                    .executeAsOneOrNull()?.chapter_entity_id
                ?: return@readLocal null
            val row = aethon_syncQueries.selectReaderProgress(entityId).executeAsOneOrNull()
                ?: return@readLocal null
            val decoded = runCatching {
                locatorJson.decodeFromString<ReaderLocator>(row.locator_json) as? ReaderLocator.Novel
            }.getOrNull()
            if (decoded != null) {
                return@readLocal decoded.takeIf { it.chapterId == expectedChapterId }
            }

            // One-version compatibility for rows written before the replica stored typed locators.
            val legacy = runCatching { locatorJson.parseToJsonElement(row.locator_json).jsonObject }.getOrNull()
                ?: return@readLocal null
            if (legacy.string("chapterId") != expectedChapterId) return@readLocal null
            val (blockIndex, textOffset) = parseCoreNovelLocator(legacy.string("locator"))
            ReaderLocator.Novel(
                entityId = EpigraphEntityId(entityId),
                chapterId = expectedChapterId,
                blockIndex = blockIndex,
                textOffset = textOffset,
                progression = (legacy.double("progressPercent") ?: row.progression).coerceIn(0.0, 1.0),
                chapterOrderKey = legacy.double("chapterOrderKey") ?: row.chapter_ordinal,
                portableWork = portableWork,
                portableChapter = portableChapter,
            )
        }
    }

    suspend fun setNovelProgress(
        localMangaId: Long,
        localChapterId: Long,
        progression: Double,
        blockIndex: Int = 0,
        textOffset: Int = 0,
        explicitReset: Boolean = false,
        read: Boolean? = null,
        bookmarked: Boolean? = null,
        lastPageRead: Long? = null,
        pagesLeft: Long? = null,
    ): NovelReaderProgressMutationResult {
        require(localMangaId > 0) { "local manga ID must be positive" }
        require(localChapterId > 0) { "local chapter ID must be positive" }
        require(progression.isFinite() && progression in 0.0..1.0) {
            "novel progression must be between 0 and 1"
        }
        require(blockIndex >= 0) { "block index must not be negative" }
        require(textOffset >= 0) { "text offset must not be negative" }

        val currentScopes = scopeProvider.current()
        val createdAt = clock().also { require(it >= 0) { "mutation timestamp must be epoch milliseconds" } }
        return coordinator.mutateLocalBatch(createdAt) {
            val portableStore = SqlDelightPortableBindingStore(this)
            val portableWorkBinding = portableStore.workByLocalReference(localMangaId.toString())
                ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            val portableWork = portableWorkBinding?.ref as? PortableWorkRef.Novel
            val localChapter = chaptersQueries.getChaptersById(localChapterId).executeAsOneOrNull()
            val existingPortableChapter = portableStore.chapterByLocalReference(localChapterId.toString())
            val portableChapter = when {
                portableWork == null || localChapter == null -> null
                existingPortableChapter != null -> existingPortableChapter
                    .takeIf { it.portableWorkId == requireNotNull(portableWorkBinding).portableId }
                    ?.ref as? PortableChapterRef.Novel
                localChapter.url.isNotEmpty() -> PortableChapterRef.Novel(portableWork, ProviderOwnedKey(localChapter.url))
                else -> null
            }
            if (portableWorkBinding != null && portableChapter != null && existingPortableChapter == null) {
                portableStore.upsertChapter(
                    PortableChapterBindingRecord(
                        portableChapterId = PortableIdentityV3.chapterId(portableChapter),
                        portableWorkId = portableWorkBinding.portableId,
                        ref = portableChapter,
                        localReference = localChapterId.toString(),
                        resolution = PortableResolution(PortableResolutionState.BOUND),
                        attemptCount = 0,
                        updatedAt = createdAt,
                    ),
                )
            }
            val portableReady = portableWorkBinding != null && portableWork != null && portableChapter != null
            val identity = aethon_syncQueries
                .selectIdentityByLocalReference("NOVEL", localMangaId.toString())
                .executeAsOneOrNull()
            val binding = aethon_syncQueries
                .selectChapterBindingByLocalChapterId(localChapterId)
                .executeAsOneOrNull()
            if (!portableReady && (identity == null || binding == null || binding.work_entity_id != identity.entity_id)) {
                return@mutateLocalBatch LocalMutationResult(
                    value = NovelReaderProgressMutationResult(false),
                    envelopes = emptyList(),
                )
            }

            val entityId = EpigraphEntityId(
                if (portableReady) requireNotNull(portableWorkBinding).portableId else requireNotNull(identity).entity_id,
            )
            val chapterEntityId = if (portableReady) {
                PortableIdentityV3.chapterId(requireNotNull(portableChapter))
            } else {
                requireNotNull(binding).chapter_entity_id
            }
            // aethon_reader_progress.chapter_entity_id is FK-constrained to the legacy
            // aethon_chapter_binding table; portable chapter ids live in
            // aethon_portable_chapter_binding. Mirror the replica projection's resolution:
            // store the legacy binding id when one exists, otherwise keep the row work-keyed
            // (the chapter id itself is carried inside the locator JSON).
            val persistedChapterEntityId = if (portableReady) {
                aethon_syncQueries.selectChapterBindingByEntityId(chapterEntityId)
                    .executeAsOneOrNull()?.chapter_entity_id
            } else {
                chapterEntityId
            }
            val chapterOrderKey = binding?.ordinal ?: localChapter?.chapter_number
            val locator = ReaderLocator.Novel(
                entityId = entityId,
                chapterId = chapterEntityId,
                blockIndex = blockIndex,
                textOffset = textOffset,
                progression = progression,
                chapterOrderKey = chapterOrderKey,
                portableWork = portableWork,
                portableChapter = portableChapter,
            )
            aethon_syncQueries.upsertLocalReaderProgress(
                entityId = entityId.value,
                chapterEntityId = persistedChapterEntityId,
                locatorJson = locatorJson.encodeToString<ReaderLocator>(locator),
                chapterOrdinal = chapterOrderKey,
                progression = progression,
                updatedAt = createdAt,
            )
            chaptersQueries.update(
                chapterId = localChapterId,
                mangaId = null,
                url = null,
                name = null,
                scanlator = null,
                read = read,
                bookmark = bookmarked,
                lastPageRead = lastPageRead,
                pagesLeft = pagesLeft,
                chapterNumber = null,
                sourceOrder = null,
                dateFetch = null,
                dateUpload = null,
                memo = null,
            )

            val command = SyncCommand.SetProgress(entityId, locator, explicitReset)
            val progressEnvelope = SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = currentScopes.novels,
                entityType = NOVEL_PROGRESS,
                command = command,
            )
            val chapterStateEnvelope = read?.let { isRead ->
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = currentScopes.novels,
                    entityType = NOVEL_CHAPTER,
                    command = SyncCommand.SetNovelChapterState(
                        entityId = EpigraphEntityId(chapterEntityId),
                        novelId = entityId,
                        path = requireNotNull(localChapter).url,
                        title = localChapter.name,
                        chapterOrderKey = chapterOrderKey ?: 0.0,
                        releaseTimeEpochMillis = localChapter.date_upload.takeIf { it >= 0 },
                        unread = !isRead,
                    ),
                )
            }
            val bookmarkEnvelope = bookmarked?.let { isBookmarked ->
                val bookmarkId = EpigraphEntityId(deterministicNovelBookmarkId(entityId.value, chapterEntityId))
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = currentScopes.novels,
                    entityType = NOVEL_BOOKMARK,
                    command = SyncCommand.SetNovelChapterBookmark(
                        entityId = bookmarkId,
                        novelId = entityId,
                        locator = locator,
                        chapterTitle = localChapter?.name,
                        bookmarked = isBookmarked,
                        savedAtEpochMillis = createdAt,
                    ),
                )
            }
            LocalMutationResult(
                value = NovelReaderProgressMutationResult(
                    emitted = true,
                    entityId = entityId,
                    chapterEntityId = chapterEntityId,
                ),
                envelopes = listOfNotNull(progressEnvelope, chapterStateEnvelope, bookmarkEnvelope),
            )
        }
    }

    /**
     * Mirrors a manga reader position into Core's comic.history entity. Unbound legacy rows remain
     * local instead of inventing a media key; the next bootstrap can retry once the source binding
     * is available.
     */
    suspend fun setComicProgress(
        localMangaId: Long,
        localChapterId: Long,
        pageIndex: Int,
        pageCount: Int?,
        progression: Double,
        pageOffset: Double = 0.0,
        explicitReset: Boolean = false,
        read: Boolean? = null,
        bookmarked: Boolean? = null,
        lastPageRead: Long? = null,
        pagesLeft: Long? = null,
    ): ComicReaderProgressMutationResult {
        require(localMangaId > 0) { "local manga ID must be positive" }
        require(localChapterId > 0) { "local chapter ID must be positive" }
        require(pageIndex >= 0) { "page index must not be negative" }
        require(pageCount == null || pageCount > 0) { "page count must be positive when present" }
        require(progression.isFinite() && progression in 0.0..1.0) {
            "comic progression must be between 0 and 1"
        }
        require(pageOffset.isFinite() && pageOffset in 0.0..1.0) {
            "page offset must be between 0 and 1"
        }
        require(lastPageRead == null || lastPageRead in 0..Int.MAX_VALUE.toLong()) {
            "last page read must fit the portable chapter-state contract"
        }

        val currentScopes = scopeProvider.current()
        val createdAt = clock().also { require(it >= 0) { "mutation timestamp must be epoch milliseconds" } }
        return coordinator.mutateLocalBatch(createdAt) {
            val portableStore = SqlDelightPortableBindingStore(this)
            val portableWorkBinding = portableStore.workByLocalReference(localMangaId.toString())
                ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            val portableWork = portableWorkBinding?.ref as? PortableWorkRef.Comic
            val localChapter = chaptersQueries.getChaptersById(localChapterId).executeAsOneOrNull()
            val existingPortableChapter = portableStore.chapterByLocalReference(localChapterId.toString())
            val portableChapter = when {
                portableWork == null || localChapter == null -> null
                existingPortableChapter != null -> existingPortableChapter
                    .takeIf { it.portableWorkId == requireNotNull(portableWorkBinding).portableId }
                    ?.ref as? PortableChapterRef.Comic
                localChapter.url.isNotEmpty() -> PortableChapterRef.Comic(portableWork, ProviderOwnedKey(localChapter.url))
                else -> null
            }
            if (portableWorkBinding != null && portableChapter != null && existingPortableChapter == null) {
                portableStore.upsertChapter(
                    PortableChapterBindingRecord(
                        portableChapterId = PortableIdentityV3.chapterId(portableChapter),
                        portableWorkId = portableWorkBinding.portableId,
                        ref = portableChapter,
                        localReference = localChapterId.toString(),
                        resolution = PortableResolution(PortableResolutionState.BOUND),
                        attemptCount = 0,
                        updatedAt = createdAt,
                    ),
                )
            }
            val portableReady = portableWorkBinding != null && portableWork != null && portableChapter != null
            val identity = aethon_syncQueries
                .selectIdentityByLocalReference("MANGA", localMangaId.toString())
                .executeAsOneOrNull()
            val binding = aethon_syncQueries
                .selectChapterBindingByLocalChapterId(localChapterId)
                .executeAsOneOrNull()
            if (!portableReady && (identity == null || binding == null || binding.work_entity_id != identity.entity_id)) {
                return@mutateLocalBatch LocalMutationResult(
                    value = ComicReaderProgressMutationResult(false),
                    envelopes = emptyList(),
                )
            }

            val entityId = EpigraphEntityId(
                if (portableReady) requireNotNull(portableWorkBinding).portableId else requireNotNull(identity).entity_id,
            )
            val chapterEntityId = if (portableReady) {
                PortableIdentityV3.chapterId(requireNotNull(portableChapter))
            } else {
                requireNotNull(binding).chapter_entity_id
            }
            // aethon_reader_progress.chapter_entity_id is FK-constrained to the legacy
            // aethon_chapter_binding table; portable chapter ids live in
            // aethon_portable_chapter_binding. Mirror the replica projection's resolution:
            // store the legacy binding id when one exists, otherwise keep the row work-keyed
            // (the chapter id itself is carried inside the locator JSON).
            val persistedChapterEntityId = if (portableReady) {
                aethon_syncQueries.selectChapterBindingByEntityId(chapterEntityId)
                    .executeAsOneOrNull()?.chapter_entity_id
            } else {
                chapterEntityId
            }
            val locator = ReaderLocator.Manga(
                entityId = entityId,
                chapterId = chapterEntityId,
                pageIndex = pageIndex,
                pageOffset = pageOffset,
                pageCount = pageCount,
                progression = progression,
                portableWork = portableWork,
                portableChapter = portableChapter,
            )
            aethon_syncQueries.upsertLocalReaderProgress(
                entityId = entityId.value,
                chapterEntityId = persistedChapterEntityId,
                locatorJson = locatorJson.encodeToString<ReaderLocator>(locator),
                chapterOrdinal = binding?.ordinal ?: localChapter?.chapter_number,
                progression = progression,
                updatedAt = createdAt,
            )
            chaptersQueries.update(
                chapterId = localChapterId,
                mangaId = null,
                url = null,
                name = null,
                scanlator = null,
                read = read,
                bookmark = bookmarked,
                lastPageRead = lastPageRead ?: pageIndex.toLong(),
                pagesLeft = pagesLeft,
                chapterNumber = null,
                sourceOrder = null,
                dateFetch = null,
                dateUpload = null,
                memo = null,
            )

            val historyEnvelope = SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = if (portableReady) {
                    currentScopes.comics
                } else {
                    suwayomiComicScopeForEntity(entityId.value, currentScopes.comics)
                },
                entityType = COMIC_HISTORY,
                command = SyncCommand.SetProgress(entityId, locator, explicitReset),
            )
            val chapterStateEnvelope = if (
                read != null || bookmarked != null || lastPageRead != null
            ) {
                val chapterStateId = EpigraphEntityId(
                    "comic.chapter_state::${entityId.value}::$chapterEntityId",
                )
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = historyEnvelope.scopeId,
                    entityType = COMIC_CHAPTER_STATE,
                    command = SyncCommand.SetChapterState(
                        entityId = chapterStateId,
                        state = ChapterStatePatch(
                            chapterId = chapterEntityId,
                            portableWorkRef = portableWork,
                            portableChapterRef = portableChapter,
                            read = read,
                            bookmarked = bookmarked,
                            lastPageRead = lastPageRead?.toInt(),
                            lastReadAtEpochMillis = if (read != null || lastPageRead != null) createdAt else null,
                            explicitProgressReset = explicitReset && lastPageRead != null,
                        ),
                    ),
                )
            } else {
                null
            }
            LocalMutationResult(
                value = ComicReaderProgressMutationResult(
                    emitted = true,
                    entityId = entityId,
                    chapterEntityId = chapterEntityId,
                ),
                envelopes = listOfNotNull(historyEnvelope, chapterStateEnvelope),
            )
        }
    }

    private companion object {
        val NOVEL_PROGRESS = SyncEntityType("novel.progress")
        val NOVEL_CHAPTER = SyncEntityType("novel.chapter")
        val NOVEL_BOOKMARK = SyncEntityType("novel.bookmark")
        val COMIC_HISTORY = SyncEntityType("comic.history")
        val COMIC_CHAPTER_STATE = SyncEntityType("comic.chapter_state")

        fun deterministicNovelBookmarkId(novelId: String, chapterId: String): String {
            val digest = MessageDigest.getInstance("SHA-256")
            digest.update(novelId.toByteArray(Charsets.UTF_8))
            digest.update(0)
            digest.update(chapterId.toByteArray(Charsets.UTF_8))
            return "novel-bookmark:" + digest.digest().joinToString("") { "%02x".format(it) }
        }

        fun parseCoreNovelLocator(value: String?): Pair<Int, Int> {
            val parts = value?.split(':').orEmpty()
            if (parts.size != 3 || parts[0] != "block") return 0 to 0
            return (parts[1].toIntOrNull()?.coerceAtLeast(0) ?: 0) to
                (parts[2].toIntOrNull()?.coerceAtLeast(0) ?: 0)
        }

        fun JsonObject.string(key: String): String? = this[key]?.jsonPrimitive?.content
        fun JsonObject.double(key: String): Double? = this[key]?.jsonPrimitive?.doubleOrNull
    }
}
