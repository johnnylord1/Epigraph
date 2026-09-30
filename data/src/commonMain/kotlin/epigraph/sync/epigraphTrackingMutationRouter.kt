package epigraph.sync

import epigraph.contract.DeviceId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.TrackingField
import epigraph.contract.TrackingFieldPatch
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.CancellationException
import yokai.data.Database

/**
 * Stable wire keys for the local tracker IDs (`manga_sync.sync_id`). The numeric IDs are a local
 * implementation detail of the tracker manager and must never be used across devices.
 */
object TrackerSyncKeys {
    private val keysById = linkedMapOf(
        1L to "myanimelist",
        2L to "anilist",
        3L to "kitsu",
        4L to "shikimori",
        5L to "bangumi",
        6L to "komga",
        7L to "mangaupdates",
        8L to "kavita",
        9L to "suwayomi",
        10L to "novelupdates",
        11L to "novellist",
        12L to "hardcover",
    )
    private val idsByKey = keysById.entries.associate { (id, key) -> key to id }

    val all: Map<Long, String> get() = keysById

    fun keyFor(syncId: Long): String? = keysById[syncId]

    fun syncIdFor(trackerKey: String): Long? = idsByKey[trackerKey]
}

/**
 * Tracking entity types are sent only while the paired Core advertises them. The gate reflects the
 * last negotiated capabilities and must answer false when the device is not paired.
 */
fun interface TrackingSyncGate {
    suspend fun advertises(entityType: SyncEntityType): Boolean
}

/** A complete, non-secret `manga_sync` row. */
data class TrackingRow(
    val mangaId: Long,
    val syncId: Long,
    val remoteId: Long,
    val libraryId: Long?,
    val title: String,
    val lastChapterRead: Double,
    val totalChapters: Long,
    val status: Long,
    val score: Double,
    val remoteUrl: String,
    val startDate: Long,
    val finishDate: Long,
)

data class TrackingMutationResult(
    val changedRows: Int,
    val emittedCommandCount: Int,
)

/**
 * Transaction-safe writer for tracker bindings. The `manga_sync` write and its outbox envelopes
 * commit together, so a crash can never leave a tracker change that the Core will not hear about.
 *
 * Each tracking record is full-state: the Core keeps the last causally ordered patch per
 * `(work, tracker)`. Comic tracking needs a portable work binding, exactly like comic library
 * membership; novels fall back to their Epigraph identity.
 */
class EpigraphTrackingMutationRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val scopeProvider: EpigraphSyncScopeProvider,
    private val gate: TrackingSyncGate,
) {
    suspend fun upsert(
        rows: List<TrackingRow>,
        origin: EpigraphMutationOrigin,
        createdAtEpochMillis: Long,
    ): TrackingMutationResult {
        if (rows.isEmpty()) return TrackingMutationResult(0, 0)
        val emission = emissionContext(origin)
        return coordinator.mutateLocalBatch(createdAtEpochMillis) {
            var changed = 0
            val envelopes = buildList {
                rows.forEach { row ->
                    val existing = manga_syncQueries.getAllByMangaId(row.mangaId).executeAsList()
                        .firstOrNull { it.sync_id == row.syncId }
                    if (existing != null && existing.toTrackingRow() == row) return@forEach
                    manga_syncQueries.insert(
                        mangaId = row.mangaId,
                        syncId = row.syncId,
                        remoteId = row.remoteId,
                        libraryId = row.libraryId,
                        title = row.title,
                        lastChapterRead = row.lastChapterRead,
                        totalChapters = row.totalChapters,
                        status = row.status,
                        score = row.score,
                        remoteUrl = row.remoteUrl,
                        startDate = row.startDate,
                        finishDate = row.finishDate,
                    )
                    changed++
                    emission?.let { context ->
                        trackingEnvelope(context, row.mangaId, row.syncId) { trackingId, trackerKey ->
                            SyncCommand.PatchTracking(trackingId, trackerKey, row.toFieldPatches())
                        }?.let(::add)
                    }
                }
            }
            LocalMutationResult(TrackingMutationResult(changed, envelopes.size), envelopes)
        }
    }

    suspend fun delete(
        mangaId: Long,
        syncId: Long,
        origin: EpigraphMutationOrigin,
        createdAtEpochMillis: Long,
    ): TrackingMutationResult {
        val emission = emissionContext(origin)
        return coordinator.mutateLocalBatch(createdAtEpochMillis) {
            val existing = manga_syncQueries.getAllByMangaId(mangaId).executeAsList()
                .any { it.sync_id == syncId }
            if (!existing) return@mutateLocalBatch LocalMutationResult(TrackingMutationResult(0, 0), emptyList())
            manga_syncQueries.deleteForManga(mangaId, syncId)
            val envelopes = listOfNotNull(
                emission?.let { context ->
                    trackingEnvelope(context, mangaId, syncId) { trackingId, _ ->
                        SyncCommand.DeleteEntity(trackingId)
                    }
                },
            )
            LocalMutationResult(TrackingMutationResult(1, envelopes.size), envelopes)
        }
    }

    /**
     * Resolved outside the transaction because both the gate and the scope provider may suspend.
     * Unpaired devices, replayed/source-refresh writes and Cores without tracking stay local-only.
     */
    private suspend fun emissionContext(origin: EpigraphMutationOrigin): EmissionContext? {
        if (!origin.emitsOutbox) return null
        val advertised = TRACKING_TYPES.filterTo(linkedSetOf()) { gate.advertises(it) }
        if (advertised.isEmpty()) return null
        val scopes = try {
            scopeProvider.current()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            return null
        }
        return EmissionContext(advertised, scopes)
    }

    private fun Database.trackingEnvelope(
        context: EmissionContext,
        mangaId: Long,
        syncId: Long,
        command: (EpigraphEntityId, String) -> SyncCommand,
    ): SyncCommandEnvelope? {
        val trackerKey = TrackerSyncKeys.keyFor(syncId) ?: return null
        val target = trackingTarget(mangaId) ?: return null
        if (target.entityType !in context.advertised) return null
        val trackingId = trackingEntityId(target.entityType, target.workId, trackerKey)
        return try {
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = if (target.entityType == NOVEL_TRACKING) context.scopes.novels else context.scopes.comics,
                entityType = target.entityType,
                command = command(EpigraphEntityId(trackingId), trackerKey),
            )
        } catch (_: IllegalArgumentException) {
            // An over-long identity or a tracker title the contract cannot carry stays local-only
            // instead of failing the user's tracker update.
            null
        }
    }

    private fun Database.trackingTarget(mangaId: Long): TrackingTarget? {
        val portableWork = SqlDelightPortableBindingStore(this)
            .workByLocalReference(mangaId.toString())
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            ?.ref
        return when (portableWork) {
            is PortableWorkRef.Comic -> TrackingTarget(COMIC_TRACKING, PortableIdentityV3.workId(portableWork))
            is PortableWorkRef.Novel -> TrackingTarget(NOVEL_TRACKING, PortableIdentityV3.workId(portableWork))
            null -> aethon_syncQueries
                .selectIdentityByLocalReference("NOVEL", mangaId.toString())
                .executeAsOneOrNull()
                ?.let { TrackingTarget(NOVEL_TRACKING, it.entity_id) }
        }
    }

    private data class EmissionContext(
        val advertised: Set<SyncEntityType>,
        val scopes: EpigraphSyncScopes,
    )

    private data class TrackingTarget(
        val entityType: SyncEntityType,
        val workId: String,
    )

    companion object {
        val COMIC_TRACKING = SyncEntityType("comic.tracking")
        val NOVEL_TRACKING = SyncEntityType("novel.tracking")
        private val TRACKING_TYPES = listOf(COMIC_TRACKING, NOVEL_TRACKING)

        /** `<entityType>::<workId>::<trackerKey>`, the Core record ID of one tracker binding. */
        fun trackingEntityId(entityType: SyncEntityType, workId: String, trackerKey: String): String =
            "${entityType.value}::$workId::$trackerKey"
    }
}

private fun tachiyomi.data.Manga_sync.toTrackingRow() = TrackingRow(
    mangaId = manga_id,
    syncId = sync_id,
    remoteId = remote_id,
    libraryId = library_id,
    title = title,
    lastChapterRead = last_chapter_read,
    totalChapters = total_chapters,
    status = status,
    score = score,
    remoteUrl = remote_url,
    startDate = start_date,
    finishDate = finish_date,
)

private fun TrackingRow.toFieldPatches(): List<TrackingFieldPatch> = listOf(
    TrackingFieldPatch(TrackingField.REMOTE_ID, remoteId.toString()),
    TrackingFieldPatch(TrackingField.LIBRARY_ID, libraryId?.toString()),
    TrackingFieldPatch(TrackingField.TITLE, title),
    TrackingFieldPatch(TrackingField.REMOTE_URL, remoteUrl),
    TrackingFieldPatch(TrackingField.STATUS, status.toString()),
    TrackingFieldPatch(TrackingField.PROGRESS, lastChapterRead.toString()),
    TrackingFieldPatch(TrackingField.TOTAL_CHAPTERS, totalChapters.toString()),
    TrackingFieldPatch(TrackingField.SCORE, score.toString()),
    TrackingFieldPatch(TrackingField.STARTED_AT, startDate.toString()),
    TrackingFieldPatch(TrackingField.FINISHED_AT, finishDate.toString()),
)
