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
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import tachiyomi.data.Chapters
import yokai.data.Database

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

/** One user-intended chapter state edit made outside the reader; null fields stay untouched. */
data class ChapterStateChange(
    val localChapterId: Long,
    val read: Boolean? = null,
    val bookmarked: Boolean? = null,
    val lastPageRead: Long? = null,
    val pagesLeft: Long? = null,
)

data class ChapterStateMutationResult(
    val emittedCommandCount: Int,
)

/** A local comic chapter whose reading progress the backfill is about to publish. */
data class ComicBackfillCandidate(
    val mangaId: Long,
    val chapterId: Long,
    val url: String,
    val read: Boolean,
    val bookmarked: Boolean,
    val lastPageRead: Long,
)

/** Picks the backfill candidates to leave out of this run, such as progress the desktop already holds. */
fun interface ComicProgressBackfillFilter {
    suspend fun withheld(candidates: List<ComicBackfillCandidate>): Set<Long>

    companion object {
        val NONE = ComicProgressBackfillFilter { emptySet() }
    }
}

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
            val localChapter = chaptersQueries.getChaptersById(localChapterId).executeAsOneOrNull()
            val resolved = resolveChapter(localMangaId, localChapterId, localChapter, novel = true, createdAt)
                ?: return@mutateLocalBatch LocalMutationResult(
                    value = NovelReaderProgressMutationResult(false),
                    envelopes = emptyList(),
                )
            val entityId = resolved.entityId
            val chapterEntityId = resolved.chapterEntityId
            val portableWork = resolved.portableWork as? PortableWorkRef.Novel
            val portableChapter = resolved.portableChapter as? PortableChapterRef.Novel
            val persistedChapterEntityId = resolved.persistedChapterEntityId
            val chapterOrderKey = resolved.chapterOrderKey
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
                entityId = resolved.localEntityId,
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
            // Like comic.history: the other device lists this chapter as read, LNReader-style.
            val historyEnvelope = if (portableWork != null && portableChapter != null && !explicitReset) {
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = currentScopes.novels,
                    entityType = NOVEL_HISTORY,
                    command = SyncCommand.AppendHistory(
                        entityId = entityId,
                        entryId = "novel.history::${PortableIdentityV3.workId(portableWork)}::" +
                            PortableIdentityV3.chapterId(portableChapter),
                        locator = locator,
                        visitedAtEpochMillis = createdAt,
                        chapterTitle = localChapter?.name,
                    ),
                )
            } else {
                null
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
                envelopes = listOfNotNull(progressEnvelope, historyEnvelope, chapterStateEnvelope, bookmarkEnvelope),
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
            val localChapter = chaptersQueries.getChaptersById(localChapterId).executeAsOneOrNull()
            val resolved = resolveChapter(localMangaId, localChapterId, localChapter, novel = false, createdAt)
                ?: return@mutateLocalBatch LocalMutationResult(
                    value = ComicReaderProgressMutationResult(false),
                    envelopes = emptyList(),
                )
            val entityId = resolved.entityId
            val chapterEntityId = resolved.chapterEntityId
            val portableWork = resolved.portableWork as? PortableWorkRef.Comic
            val portableChapter = resolved.portableChapter as? PortableChapterRef.Comic
            val persistedChapterEntityId = resolved.persistedChapterEntityId
            val locator = ReaderLocator.Manga(
                entityId = entityId,
                chapterId = chapterEntityId,
                pageIndex = pageIndex,
                pageOffset = pageOffset,
                pageCount = pageCount?.let { comicPageCountCovering(pageIndex, it) },
                progression = progression,
                portableWork = portableWork,
                portableChapter = portableChapter,
            )
            aethon_syncQueries.upsertLocalReaderProgress(
                entityId = resolved.localEntityId,
                chapterEntityId = persistedChapterEntityId,
                locatorJson = locatorJson.encodeToString<ReaderLocator>(locator),
                chapterOrdinal = resolved.chapterOrderKey,
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
                scopeId = resolved.comicScope(currentScopes),
                entityType = COMIC_HISTORY,
                command = SyncCommand.SetProgress(entityId, locator, explicitReset),
            )
            val chapterStateEnvelope = if (
                read != null || bookmarked != null || lastPageRead != null
            ) {
                comicChapterStateEnvelope(
                    resolved = resolved,
                    scopes = currentScopes,
                    read = read,
                    bookmarked = bookmarked,
                    lastPageRead = lastPageRead?.toInt(),
                    createdAt = createdAt,
                    explicitProgressReset = explicitReset && lastPageRead != null,
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

    /**
     * Applies read/bookmark/progress edits made outside the reader (details, library, recents,
     * notifications, duplicate auto-read) and queues the Core chapter-state commands in the same
     * transaction. Only fields whose stored value actually changes are published; chapters without a
     * stable binding, and every edit made while unpaired, stay local.
     */
    suspend fun setChapterStates(changes: List<ChapterStateChange>): ChapterStateMutationResult {
        if (changes.isEmpty()) return ChapterStateMutationResult(0)
        changes.forEach { require(it.localChapterId > 0) { "local chapter ID must be positive" } }
        val scopes = pairedScopes()
        val createdAt = clock().also { require(it >= 0) { "mutation timestamp must be epoch milliseconds" } }
        return coordinator.mutateLocalBatch(createdAt) {
            val novelByManga = mutableMapOf<Long, Boolean?>()
            val envelopes = changes.flatMap { change ->
                val before = chaptersQueries.getChaptersById(change.localChapterId).executeAsOneOrNull()
                    ?: return@flatMap emptyList()
                chaptersQueries.update(
                    chapterId = change.localChapterId,
                    mangaId = null,
                    url = null,
                    name = null,
                    scanlator = null,
                    read = change.read,
                    bookmark = change.bookmarked,
                    lastPageRead = change.lastPageRead,
                    pagesLeft = change.pagesLeft,
                    chapterNumber = null,
                    sourceOrder = null,
                    dateFetch = null,
                    dateUpload = null,
                    memo = null,
                )
                if (scopes == null) return@flatMap emptyList()
                val read = change.read?.takeIf { it != before.read }
                val bookmarked = change.bookmarked?.takeIf { it != before.bookmark }
                val lastPageRead = change.lastPageRead
                    ?.takeIf { it != before.last_page_read && it in 0..Int.MAX_VALUE.toLong() }
                if (read == null && bookmarked == null && lastPageRead == null) return@flatMap emptyList()
                val novel = novelByManga.getOrPut(before.manga_id) { isNovelWork(before.manga_id) }
                    ?: return@flatMap emptyList()
                val after = chaptersQueries.getChaptersById(change.localChapterId).executeAsOne()
                val resolved = resolveChapter(before.manga_id, change.localChapterId, after, novel, createdAt)
                    ?: return@flatMap emptyList()
                if (novel) {
                    novelChapterStateEnvelopes(resolved, scopes, after, read, bookmarked, createdAt)
                } else {
                    listOf(
                        comicChapterStateEnvelope(
                            resolved = resolved,
                            scopes = scopes,
                            read = read,
                            bookmarked = bookmarked,
                            lastPageRead = lastPageRead?.toInt(),
                            createdAt = createdAt,
                            explicitProgressReset = lastPageRead != null && lastPageRead < before.last_page_read,
                        ),
                    )
                }
            }
            LocalMutationResult(ChapterStateMutationResult(envelopes.size), envelopes)
        }
    }

    /**
     * Publishes the comic reading progress this phone holds but the paired Core does not, such as
     * progress recorded before pairing or before the Core was reset. Each chapter that is read,
     * bookmarked or has a page reached becomes a chapter state carrying only those facts (never an
     * unread or a cleared bookmark), and each title's latest read becomes its reader position.
     * Every write is dated when the chapter was last read here (when it was fetched if it was never
     * opened in the reader), so Core keeps whichever device changed the chapter last. Waits until
     * the Core's snapshot has arrived, since that is what tells which chapters it already holds;
     * titles without a bound portable identity wait for it. [filter] holds chapters back for this
     * run, such as progress the desktop's Suwayomi already holds and would only receive as an echo.
     * Returns the number of commands queued.
     */
    suspend fun backfillComicProgress(
        maxCommands: Int = BACKFILL_MAX_COMMANDS,
        filter: ComicProgressBackfillFilter = ComicProgressBackfillFilter.NONE,
    ): Int {
        val scopes = pairedScopes() ?: return 0
        val comicScope = scopes.comics.value
        val (candidates, histories) = coordinator.readLocal {
            if (!aethon_syncQueries.hasCoreReplicaCoverageForScope(comicScope).executeAsOne()) {
                return@readLocal emptyList<Pair<BackfillRow, ComicBackfillCandidate>>() to emptyList<BackfillRow>()
            }
            val chapterRows = aethon_syncQueries.selectComicChapterProgressBackfill(comicScope).executeAsList()
                .distinctBy { it.chapter_id }
                .map { row ->
                    val lastReadAt: Long? = row.last_read_at
                    BackfillRow(row.manga_id, row.chapter_id, lastReadAt?.takeIf { it > 0 } ?: row.date_fetch) to
                        ComicBackfillCandidate(
                            mangaId = row.manga_id,
                            chapterId = row.chapter_id,
                            url = row.url,
                            read = row.read,
                            bookmarked = row.bookmark,
                            lastPageRead = row.last_page_read,
                        )
                }
            val historyRows = aethon_syncQueries.selectComicHistoryBackfill(comicScope).executeAsList()
                .distinctBy { it.manga_id }
                .mapNotNull { row ->
                    val lastReadAt: Long? = row.last_read_at
                    lastReadAt?.let { BackfillRow(row.manga_id, row.chapter_id, it) }
                }
            chapterRows to historyRows
        }
        val withheld = if (candidates.isEmpty()) emptySet() else filter.withheld(candidates.map { it.second })
        val chapters = candidates.mapNotNull { (row, _) -> row.takeUnless { it.chapterId in withheld } }
        var emitted = 0
        val batches = chapters.chunked(BACKFILL_BATCH).map { it to false } +
            histories.chunked(BACKFILL_BATCH).map { it to true }
        for ((batch, history) in batches) {
            if (emitted >= maxCommands) break
            val now = clock().also { require(it >= 0) { "mutation timestamp must be epoch milliseconds" } }
            emitted += coordinator.mutateLocalBatch(now) {
                val novelByManga = mutableMapOf<Long, Boolean?>()
                val dated = batch.mapNotNull { row ->
                    if (novelByManga.getOrPut(row.mangaId) { isNovelWork(row.mangaId) } != false) return@mapNotNull null
                    val readAt = row.readAt.coerceAtLeast(0)
                    val envelope = if (history) {
                        backfillHistoryEnvelope(row, scopes, now)
                    } else {
                        backfillChapterStateEnvelope(row, scopes, now, readAt)
                    }
                    envelope?.let { it to readAt }
                }
                LocalMutationResult(
                    value = dated.size,
                    envelopes = dated.map { it.first },
                    envelopeCreatedAt = dated.associate { (envelope, readAt) -> envelope.clientMutationId to readAt },
                )
            }
        }
        return emitted
    }

    private fun Database.backfillChapterStateEnvelope(
        row: BackfillRow,
        scopes: EpigraphSyncScopes,
        now: Long,
        readAt: Long,
    ): SyncCommandEnvelope? {
        val chapter = chaptersQueries.getChaptersById(row.chapterId).executeAsOneOrNull() ?: return null
        val lastPageRead = chapter.last_page_read.takeIf { it in 1..Int.MAX_VALUE.toLong() }?.toInt()
        if (!chapter.read && !chapter.bookmark && lastPageRead == null) return null
        val resolved = resolveChapter(row.mangaId, row.chapterId, chapter, novel = false, now)
            ?.takeIf { it.portableReady }
            ?: return null
        val envelope = comicChapterStateEnvelope(
            resolved = resolved,
            scopes = scopes,
            read = true.takeIf { chapter.read },
            bookmarked = true.takeIf { chapter.bookmark },
            lastPageRead = lastPageRead,
            createdAt = readAt,
            explicitProgressReset = false,
        )
        // A chapter that had no portable binding yet was listed without checking Core.
        val known = aethon_syncQueries.isEntityKnownToCore(
            envelope.scopeId.value,
            COMIC_CHAPTER_STATE.value,
            envelope.command.entityId.value,
        ).executeAsOne()
        return envelope.takeUnless { known }
    }

    private fun Database.backfillHistoryEnvelope(
        row: BackfillRow,
        scopes: EpigraphSyncScopes,
        now: Long,
    ): SyncCommandEnvelope? {
        val chapter = chaptersQueries.getChaptersById(row.chapterId).executeAsOneOrNull() ?: return null
        val resolved = resolveChapter(row.mangaId, row.chapterId, chapter, novel = false, now)
            ?.takeIf { it.portableReady }
            ?: return null
        // Same position the reader publishes for this chapter.
        val pageIndex = chapter.last_page_read.coerceIn(0, Int.MAX_VALUE.toLong()).toInt()
        val pageCount = (chapter.last_page_read + chapter.pages_left)
            .takeIf { it in 1..Int.MAX_VALUE.toLong() }
            ?.toInt()
            ?.let { comicPageCountCovering(pageIndex, it) }
        val progression = when {
            chapter.read -> 1.0
            pageCount != null -> ((pageIndex + 1).toDouble() / pageCount).coerceIn(0.0, 1.0)
            else -> 0.0
        }
        val locator = ReaderLocator.Manga(
            entityId = resolved.entityId,
            chapterId = resolved.chapterEntityId,
            pageIndex = pageIndex,
            pageOffset = 0.0,
            pageCount = pageCount,
            progression = progression,
            portableWork = resolved.portableWork as? PortableWorkRef.Comic,
            portableChapter = resolved.portableChapter as? PortableChapterRef.Comic,
        )
        return SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = deviceId,
            clientMutationId = mutationIds.next(),
            scopeId = resolved.comicScope(scopes),
            entityType = COMIC_HISTORY,
            command = SyncCommand.SetProgress(resolved.entityId, locator, false),
        )
    }

    /**
     * Resolves the published identity of one local chapter: the V3 portable binding when the work is
     * bound (creating the chapter binding on first use), otherwise the legacy identity + chapter
     * binding pair. Null means the chapter has no stable identity yet and must stay local.
     */
    private fun Database.resolveChapter(
        localMangaId: Long,
        localChapterId: Long,
        localChapter: Chapters?,
        novel: Boolean,
        createdAt: Long,
    ): ResolvedChapter? {
        val portableStore = SqlDelightPortableBindingStore(this)
        val portableWorkBinding = portableStore.workByLocalReference(localMangaId.toString())
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
        val portableWork = portableWorkBinding?.ref
            ?.takeIf { if (novel) it is PortableWorkRef.Novel else it is PortableWorkRef.Comic }
        val existingPortableChapter = portableStore.chapterByLocalReference(localChapterId.toString())
        val portableChapter = when {
            portableWork == null || localChapter == null -> null
            existingPortableChapter != null -> existingPortableChapter
                .takeIf { it.portableWorkId == requireNotNull(portableWorkBinding).portableId }
                ?.ref
                ?.takeIf { it.work == portableWork }
            localChapter.url.isNotEmpty() -> when (portableWork) {
                is PortableWorkRef.Novel -> PortableChapterRef.Novel(portableWork, ProviderOwnedKey(localChapter.url))
                is PortableWorkRef.Comic -> PortableChapterRef.Comic(portableWork, ProviderOwnedKey(localChapter.url))
            }
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
            .selectIdentityByLocalReference(if (novel) "NOVEL" else "MANGA", localMangaId.toString())
            .executeAsOneOrNull()
        val binding = aethon_syncQueries
            .selectChapterBindingByLocalChapterId(localChapterId)
            .executeAsOneOrNull()
        if (!portableReady && (identity == null || binding == null || binding.work_entity_id != identity.entity_id)) {
            return null
        }
        val chapterEntityId = if (portableReady) {
            PortableIdentityV3.chapterId(requireNotNull(portableChapter))
        } else {
            requireNotNull(binding).chapter_entity_id
        }
        val localEntityId = if (portableReady) {
            requireNotNull(portableWorkBinding).portableId
        } else {
            requireNotNull(identity).entity_id
        }
        return ResolvedChapter(
            entityId = EpigraphEntityId(
                if (portableReady || novel) localEntityId else coreServedMangaEntityId(localMangaId, localEntityId, chapterEntityId),
            ),
            localEntityId = localEntityId,
            chapterEntityId = chapterEntityId,
            portableReady = portableReady,
            portableWork = portableWork,
            portableChapter = portableChapter,
            chapterOrderKey = binding?.ordinal ?: localChapter?.chapter_number,
            // aethon_reader_progress.chapter_entity_id is FK-constrained to the legacy
            // aethon_chapter_binding table; portable chapter ids live in
            // aethon_portable_chapter_binding. Mirror the replica projection's resolution:
            // store the legacy binding id when one exists, otherwise keep the row work-keyed
            // (the chapter id itself is carried inside the locator JSON).
            persistedChapterEntityId = if (portableReady) {
                aethon_syncQueries.selectChapterBindingByEntityId(chapterEntityId)
                    .executeAsOneOrNull()?.chapter_entity_id
            } else {
                chapterEntityId
            },
        )
    }

    /**
     * A Core-served manga whose extension is not installed here keeps the portable `comic:` identity
     * the Core replica gave it, but has no bound portable work to send the refs the Core requires with
     * that id. Its chapters are scoped Suwayomi ids, so publish the matching scoped manga id instead,
     * as for manga first seen through Suwayomi.
     */
    private fun Database.coreServedMangaEntityId(localMangaId: Long, entityId: String, chapterEntityId: String): String {
        if (suwayomiMangaIdForEntity(entityId) != null) return entityId
        val url = mangasQueries.findById(localMangaId).executeAsOneOrNull()?.url ?: return entityId
        val scoped = suwayomiMangaEntityIdForCoreUrl(url) ?: return entityId
        return scoped.takeIf { chapterEntityId.startsWith(it.substringBeforeLast(":manga:") + ":chapter:") } ?: entityId
    }

    /** A bound V3 work decides the content type; otherwise the legacy identity does. Null stays local. */
    private fun Database.isNovelWork(localMangaId: Long): Boolean? {
        val reference = localMangaId.toString()
        val bound = SqlDelightPortableBindingStore(this).workByLocalReference(reference)
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            ?.ref
        if (bound is PortableWorkRef.Novel) return true
        if (bound is PortableWorkRef.Comic) return false
        return when {
            aethon_syncQueries.selectIdentityByLocalReference("NOVEL", reference).executeAsOneOrNull() != null -> true
            aethon_syncQueries.selectIdentityByLocalReference("MANGA", reference).executeAsOneOrNull() != null -> false
            else -> null
        }
    }

    private fun comicChapterStateEnvelope(
        resolved: ResolvedChapter,
        scopes: EpigraphSyncScopes,
        read: Boolean?,
        bookmarked: Boolean?,
        lastPageRead: Int?,
        createdAt: Long,
        explicitProgressReset: Boolean,
    ) = SyncCommandEnvelope(
        protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
        deviceId = deviceId,
        clientMutationId = mutationIds.next(),
        scopeId = resolved.comicScope(scopes),
        entityType = COMIC_CHAPTER_STATE,
        command = SyncCommand.SetChapterState(
            entityId = EpigraphEntityId("comic.chapter_state::${resolved.entityId.value}::${resolved.chapterEntityId}"),
            state = ChapterStatePatch(
                chapterId = resolved.chapterEntityId,
                portableWorkRef = (resolved.portableWork as? PortableWorkRef.Comic)?.takeIf { resolved.portableReady },
                portableChapterRef = (resolved.portableChapter as? PortableChapterRef.Comic)
                    ?.takeIf { resolved.portableReady },
                read = read,
                bookmarked = bookmarked,
                lastPageRead = lastPageRead,
                lastReadAtEpochMillis = if (read != null || lastPageRead != null) createdAt else null,
                explicitProgressReset = explicitProgressReset,
            ),
        ),
    )

    private fun Database.novelChapterStateEnvelopes(
        resolved: ResolvedChapter,
        scopes: EpigraphSyncScopes,
        chapter: Chapters,
        read: Boolean?,
        bookmarked: Boolean?,
        createdAt: Long,
    ): List<SyncCommandEnvelope> = buildList {
        // Core-v1 novel chapter rows are full snapshots; a chapter without path/title cannot be one.
        if (read != null && chapter.url.isNotBlank() && chapter.name.isNotBlank()) {
            add(
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = scopes.novels,
                    entityType = NOVEL_CHAPTER,
                    command = SyncCommand.SetNovelChapterState(
                        entityId = EpigraphEntityId(resolved.chapterEntityId),
                        novelId = resolved.entityId,
                        path = chapter.url,
                        title = chapter.name,
                        chapterOrderKey = resolved.chapterOrderKey ?: 0.0,
                        releaseTimeEpochMillis = chapter.date_upload.takeIf { it >= 0 },
                        unread = !read,
                    ),
                ),
            )
        }
        if (bookmarked != null) {
            val locator = storedNovelLocator(resolved) ?: ReaderLocator.Novel(
                entityId = resolved.entityId,
                chapterId = resolved.chapterEntityId,
                blockIndex = 0,
                textOffset = 0,
                progression = (chapter.last_page_read / 100.0).coerceIn(0.0, 1.0),
                chapterOrderKey = resolved.chapterOrderKey,
                portableWork = resolved.portableWork as? PortableWorkRef.Novel,
                portableChapter = resolved.portableChapter as? PortableChapterRef.Novel,
            )
            add(
                SyncCommandEnvelope(
                    protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                    deviceId = deviceId,
                    clientMutationId = mutationIds.next(),
                    scopeId = scopes.novels,
                    entityType = NOVEL_BOOKMARK,
                    command = SyncCommand.SetNovelChapterBookmark(
                        entityId = EpigraphEntityId(
                            deterministicNovelBookmarkId(resolved.entityId.value, resolved.chapterEntityId),
                        ),
                        novelId = resolved.entityId,
                        locator = locator,
                        chapterTitle = chapter.name.takeIf { it.isNotBlank() },
                        bookmarked = bookmarked,
                        savedAtEpochMillis = createdAt,
                    ),
                ),
            )
        }
    }

    /** Reuses the exact reader anchor when the stored progress belongs to this chapter. */
    private fun Database.storedNovelLocator(resolved: ResolvedChapter): ReaderLocator.Novel? {
        val row = aethon_syncQueries.selectReaderProgress(resolved.entityId.value).executeAsOneOrNull() ?: return null
        val locator = runCatching {
            locatorJson.decodeFromString<ReaderLocator>(row.locator_json) as? ReaderLocator.Novel
        }.getOrNull()
        return locator?.takeIf { it.chapterId == resolved.chapterEntityId && it.entityId == resolved.entityId }
    }

    /** Without a paired profile there is nowhere to publish; the edit stays local. */
    private suspend fun pairedScopes(): EpigraphSyncScopes? = try {
        scopeProvider.current()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    /** A local chapter the progress backfill publishes, with when it was last read here. */
    private class BackfillRow(val mangaId: Long, val chapterId: Long, val readAt: Long)

    private class ResolvedChapter(
        val entityId: EpigraphEntityId,
        /** Identity the local reader-progress row is keyed by; [entityId] is the published one. */
        val localEntityId: String,
        val chapterEntityId: String,
        val portableReady: Boolean,
        val portableWork: PortableWorkRef?,
        val portableChapter: PortableChapterRef?,
        val chapterOrderKey: Double?,
        val persistedChapterEntityId: String?,
    ) {
        fun comicScope(scopes: EpigraphSyncScopes): SyncScopeId = if (portableReady) {
            scopes.comics
        } else {
            suwayomiComicScopeForEntity(entityId.value, scopes.comics)
        }
    }

    private companion object {
        val NOVEL_PROGRESS = SyncEntityType("novel.progress")
        val NOVEL_CHAPTER = SyncEntityType("novel.chapter")
        val NOVEL_BOOKMARK = SyncEntityType("novel.bookmark")
        val NOVEL_HISTORY = SyncEntityType("novel.history")
        val COMIC_HISTORY = SyncEntityType("comic.history")
        val COMIC_CHAPTER_STATE = SyncEntityType("comic.chapter_state")

        /** Chapters resolved per backfill transaction, and commands queued per backfill run. */
        const val BACKFILL_BATCH = 200
        const val BACKFILL_MAX_COMMANDS = 2_000

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

/**
 * A chapter marked read keeps `pages_left` at 0, so `last_page_read + pages_left` counts one page short of
 * the zero-based index of the last page. Core rejects a page count that does not cover the page index.
 */
fun comicPageCountCovering(pageIndex: Int, pageCount: Int): Int =
    if (pageIndex < Int.MAX_VALUE) maxOf(pageCount, pageIndex + 1) else pageCount
