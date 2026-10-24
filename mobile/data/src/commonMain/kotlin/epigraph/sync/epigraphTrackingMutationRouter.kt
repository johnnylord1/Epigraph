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
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import tachiyomi.data.SelectCoreReplicaRecordVersionsByType
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

data class TrackingReconcileResult(
    val publishedRows: Int,
    val appliedRows: Int,
    val removedRows: Int,
)

/**
 * Transaction-safe writer for tracker bindings. The `manga_sync` write and its outbox envelopes
 * commit together, so a crash can never leave a tracker change that the Core will not hear about.
 *
 * Each tracking record is full-state: the Core keeps the last causally ordered patch per
 * `(work, tracker)`. Comic tracking needs a portable work binding, exactly like comic library
 * membership; novels fall back to their Epigraph identity. A comic still waiting for its native
 * extension is tracked through its Core-backed row (`coreSourceId`), as the projection does.
 */
class EpigraphTrackingMutationRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val scopeProvider: EpigraphSyncScopeProvider,
    private val gate: TrackingSyncGate,
    private val coreSourceId: Long? = null,
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
     * Converges `manga_sync` with the Core replica after a replica pass. Bindings created before the
     * Core advertised tracking (for example restored from a backup) never produced a patch, and
     * records that arrived while their work was not bound yet were skipped by the projection.
     *
     * - A local row without any Core record or tombstone is published (backfill).
     * - A Core record wins over a different local row; a Core tombstone removes the local row.
     * - A Core record whose work is now bound locally but has no row is applied.
     *
     * Rows with a pending local mutation, or one the replica has not caught up with, are left
     * alone. Replica-driven writes never emit commands, so this cannot echo.
     */
    suspend fun reconcileWithReplica(createdAtEpochMillis: Long): TrackingReconcileResult {
        val emission = emissionContext(EpigraphMutationOrigin.LOCAL_IMPORT)
            ?: return TrackingReconcileResult(0, 0, 0)
        return coordinator.mutateLocalBatch(createdAtEpochMillis) {
            var applied = 0
            var removed = 0
            val seen = mutableSetOf<String>()
            // Read once for the pass: each per-row lookup costs about a millisecond on a phone,
            // which added up to seconds for a few hundred trackers.
            val favorites = aethon_syncQueries.selectFavoriteMangaIds().executeAsList().toHashSet()
            val index = trackingPassIndex()
            val replicas = emission.advertised.associateWith { replicaIndex(emission.scopeFor(it), it) }
            val envelopes = buildList {
                manga_syncQueries.getAll().executeAsList().forEach { local ->
                    val trackerKey = TrackerSyncKeys.keyFor(local.sync_id) ?: return@forEach
                    if (local.manga_id !in favorites) return@forEach
                    val target = trackingTarget(local.manga_id, index) ?: return@forEach
                    if (target.entityType !in emission.advertised) return@forEach
                    val trackingId = trackingEntityId(target.entityType, target.workId, trackerKey)
                    seen += trackingId
                    val scopeId = emission.scopeFor(target.entityType)
                    val replica = replicas.getValue(target.entityType)
                    val record = replica.records[trackingId]
                    val tombstoneVersion = replica.tombstones[trackingId]
                    val observed = maxOf(record?.server_version ?: 0L, tombstoneVersion ?: 0L)
                    if (replica.mayBlock(trackingId) &&
                        hasBlockingTrackingMutation(scopeId, target.entityType, trackingId, observed)
                    ) {
                        return@forEach
                    }
                    val localRow = local.toTrackingRow()
                    when {
                        record != null && (tombstoneVersion == null || record.server_version > tombstoneVersion) -> {
                            val remote = decodeTrackingRecord(record.record_json, local.manga_id, local.sync_id)
                                ?: return@forEach
                            if (remote != localRow) {
                                insertTrackingRow(remote)
                                applied++
                            }
                        }
                        tombstoneVersion != null -> {
                            manga_syncQueries.deleteForManga(local.manga_id, local.sync_id)
                            removed++
                        }
                        else -> trackingEnvelope(emission, local.manga_id, local.sync_id, index) { id, key ->
                            SyncCommand.PatchTracking(id, key, localRow.toFieldPatches())
                        }?.let(::add)
                    }
                }
                emission.advertised.forEach { entityType ->
                    val scopeId = emission.scopeFor(entityType)
                    val replicaIndex = replicas.getValue(entityType)
                    replicaIndex.records.values
                        .forEach replica@{ replica ->
                            if (replica.entity_id in seen) return@replica
                            val (mangaId, syncId) = localTrackingTarget(
                                entityType,
                                replica.entity_id,
                                favorites,
                                index,
                            ) ?: return@replica
                            val version = replica.server_version
                            if (replicaIndex.mayBlock(replica.entity_id) &&
                                hasBlockingTrackingMutation(scopeId, entityType, replica.entity_id, version)
                            ) {
                                return@replica
                            }
                            val remote = decodeTrackingRecord(replica.record_json, mangaId, syncId)
                                ?: return@replica
                            insertTrackingRow(remote)
                            applied++
                        }
                }
            }
            LocalMutationResult(TrackingReconcileResult(envelopes.size, applied, removed), envelopes)
        }
    }

    private fun Database.hasBlockingTrackingMutation(
        scopeId: String,
        entityType: SyncEntityType,
        trackingId: String,
        observedServerVersion: Long,
    ): Boolean = aethon_syncQueries.hasBlockingMutationForObservedVersion(
        scopeId = scopeId,
        entityType = entityType.value,
        entityId = trackingId,
        observedServerVersion = observedServerVersion,
    ).executeAsOne()

    /** Resolves `<entityType>::<workId>::<trackerKey>` to a favorite local `(manga_id, sync_id)`. */
    private fun Database.localTrackingTarget(
        entityType: SyncEntityType,
        trackingId: String,
        favorites: Set<Long>,
        index: TrackingPassIndex,
    ): Pair<Long, Long>? {
        val prefix = "${entityType.value}::"
        if (!trackingId.startsWith(prefix)) return null
        val workId = trackingId.removePrefix(prefix).substringBeforeLast("::", "")
        val syncId = TrackerSyncKeys.syncIdFor(trackingId.substringAfterLast("::")) ?: return null
        if (workId.isBlank()) return null
        val binding = index.works[workId]
        val portableLocalId = binding
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            ?.localReference?.toLongOrNull()
        val mangaId = portableLocalId ?: if (entityType == NOVEL_TRACKING) {
            index.localReferences[workId]?.toLongOrNull()
        } else {
            coreBackedMangaId(binding?.ref, index.coreBacked)
        }
        mangaId ?: return null
        if (mangaId !in favorites) return null
        return mangaId to syncId
    }

    private fun Database.insertTrackingRow(row: TrackingRow) {
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
        index: TrackingPassIndex? = null,
        command: (EpigraphEntityId, String) -> SyncCommand,
    ): SyncCommandEnvelope? {
        val trackerKey = TrackerSyncKeys.keyFor(syncId) ?: return null
        val target = trackingTarget(mangaId, index) ?: return null
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

    private fun Database.trackingTarget(mangaId: Long, index: TrackingPassIndex? = null): TrackingTarget? {
        val localReference = mangaId.toString()
        val portableWork = if (index != null) {
            index.boundWorks[localReference]
        } else {
            SqlDelightPortableBindingStore(this)
                .workByLocalReference(localReference)
                ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
        }?.ref
        return when (portableWork) {
            is PortableWorkRef.Comic -> TrackingTarget(COMIC_TRACKING, PortableIdentityV3.workId(portableWork))
            is PortableWorkRef.Novel -> TrackingTarget(NOVEL_TRACKING, PortableIdentityV3.workId(portableWork))
            null -> coreBackedComic(mangaId, index)
                ?.let { TrackingTarget(COMIC_TRACKING, PortableIdentityV3.workId(it)) }
                ?: if (index != null) {
                    index.novelEntityIds[localReference]
                } else {
                    aethon_syncQueries
                        .selectIdentityByLocalReference("NOVEL", localReference)
                        .executeAsOneOrNull()
                        ?.entity_id
                }?.let { TrackingTarget(NOVEL_TRACKING, it) }
        }
    }

    /** The unbound portable comic shown through this Core-backed row, when it is the only one. */
    private fun Database.coreBackedComic(mangaId: Long, index: TrackingPassIndex?): PortableWorkRef.Comic? {
        val coreSource = coreSourceId ?: return null
        val coreBacked = index?.coreBacked
        val portableIds = coreBacked?.unboundPortableIds(mangaId)
            ?: aethon_syncQueries
                .selectUnboundPortableComicIdsByCoreManga(mangaId = mangaId, coreSourceId = coreSource)
                .executeAsList()
        val portableId = portableIds.singleOrNull() ?: return null
        val work = if (index != null) index.works[portableId] else SqlDelightPortableBindingStore(this).work(portableId)
        val comic = work?.ref as? PortableWorkRef.Comic
        // Only when inbound records resolve back to this same row, so both directions agree.
        return comic?.takeIf { coreBackedMangaId(it, coreBacked) == mangaId }
    }

    private fun Database.coreBackedMangaId(ref: PortableWorkRef?, coreBacked: CoreBackedLookup? = null): Long? {
        val comic = ref as? PortableWorkRef.Comic ?: return null
        val coreSource = coreSourceId ?: return null
        val mangaIds = coreBacked?.mangaIds(comic.sourceId.value, comic.mangaKey.value)
            ?: aethon_syncQueries.selectAethonCoreMangaBySourceBinding(
                sourceId = comic.sourceId.value,
                providerKey = comic.mangaKey.value,
                coreSourceId = coreSource,
            ).executeAsList()
        return mangaIds.singleOrNull()
    }

    /** The two Core-backed lookups above for every row at once; null without a Core source. */
    private fun Database.coreBackedLookup(): CoreBackedLookup? {
        val coreSource = coreSourceId ?: return null
        val mangaBySourceKey = aethon_syncQueries.selectAethonCoreMangaSourceKeys(coreSource).executeAsList()
            .groupBy({ it.source_id to it.normalized_url }, { it.manga_id })
        val unboundByManga = aethon_syncQueries.selectUnboundPortableComicIdsByCoreMangas(coreSource).executeAsList()
            .groupBy({ it.manga_id }, { it.portable_id })
        return CoreBackedLookup(mangaBySourceKey, unboundByManga)
    }

    /** The binding and identity lookups of one reconcile pass, read once inside its transaction. */
    private fun Database.trackingPassIndex(): TrackingPassIndex {
        val works = SqlDelightPortableBindingStore(this).allWorks()
        // Same pick as [SqlDelightPortableBindingStore.workByLocalReference]: the newest bound row.
        val boundWorks = works
            .filter { it.resolution.state == PortableResolutionState.BOUND && it.localReference != null }
            .groupBy { requireNotNull(it.localReference) }
            .mapValues { (_, rows) -> rows.maxBy { it.updatedAt } }
        val identities = aethon_syncQueries.selectContentIdentityReferences().executeAsList()
        return TrackingPassIndex(
            coreBacked = coreBackedLookup(),
            works = works.associateBy { it.portableId },
            boundWorks = boundWorks,
            novelEntityIds = identities.filter { it.content_type == "NOVEL" }
                .associate { it.local_reference to it.entity_id },
            localReferences = identities.associate { it.entity_id to it.local_reference },
        )
    }

    private fun Database.replicaIndex(scopeId: String, entityType: SyncEntityType): TrackingReplicaIndex =
        TrackingReplicaIndex(
            records = aethon_syncQueries.selectCoreReplicaRecordVersionsByType(scopeId, entityType.value)
                .executeAsList()
                .associateBy { it.entity_id },
            tombstones = aethon_syncQueries.selectCoreReplicaTombstoneVersionsByType(scopeId, entityType.value)
                .executeAsList()
                .associate { it.entity_id to it.server_version },
            pending = aethon_syncQueries.selectOutboxOrWaitEntityIdsForType(scopeId, entityType.value)
                .executeAsList()
                .filterNotNullTo(hashSetOf()),
        )

    private class TrackingPassIndex(
        val coreBacked: CoreBackedLookup?,
        val works: Map<String, PortableWorkBindingRecord>,
        val boundWorks: Map<String, PortableWorkBindingRecord>,
        val novelEntityIds: Map<String, String>,
        val localReferences: Map<String, String>,
    )

    private class TrackingReplicaIndex(
        val records: Map<String, SelectCoreReplicaRecordVersionsByType>,
        val tombstones: Map<String, Long>,
        private val pending: Set<String>,
    ) {
        /** Only an entity with an outbox command or a replica wait can be blocked; it is checked exactly. */
        fun mayBlock(entityId: String): Boolean = entityId in pending
    }

    private class CoreBackedLookup(
        private val mangaBySourceKey: Map<Pair<String, String>, List<Long>>,
        private val unboundByManga: Map<Long, List<String>>,
    ) {
        fun mangaIds(sourceId: String, providerKey: String): List<Long> =
            mangaBySourceKey[sourceId to providerKey].orEmpty()

        fun unboundPortableIds(mangaId: Long): List<String> = unboundByManga[mangaId].orEmpty()
    }

    private data class EmissionContext(
        val advertised: Set<SyncEntityType>,
        val scopes: EpigraphSyncScopes,
    ) {
        fun scopeFor(entityType: SyncEntityType): String =
            (if (entityType == NOVEL_TRACKING) scopes.novels else scopes.comics).value
    }

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

/**
 * Reads a confirmed Core tracking record with the same rules as the replica projection: malformed
 * records are ignored instead of failing the pass, unknown extra fields are ignored.
 */
private fun decodeTrackingRecord(recordJson: String, mangaId: Long, syncId: Long): TrackingRow? {
    val record = runCatching { Json.parseToJsonElement(recordJson).jsonObject }.getOrNull() ?: return null
    fun primitive(name: String) = (record[name] as? JsonPrimitive)?.takeUnless { it is JsonNull }
    fun long(name: String) = primitive(name)?.let { it.longOrNull ?: it.doubleOrNull?.toLong() }
    fun double(name: String) = primitive(name)?.doubleOrNull?.takeIf(Double::isFinite)
    fun string(name: String) = primitive(name)?.takeIf { it.isString }?.content
    return TrackingRow(
        mangaId = mangaId,
        syncId = syncId,
        remoteId = long("remoteId") ?: return null,
        libraryId = long("libraryId"),
        title = string("title") ?: return null,
        lastChapterRead = double("progress") ?: return null,
        totalChapters = long("totalChapters") ?: return null,
        status = long("status") ?: return null,
        score = double("score") ?: return null,
        remoteUrl = string("remoteUrl") ?: return null,
        startDate = long("startedAtMs") ?: 0L,
        finishDate = long("finishedAtMs") ?: 0L,
    )
}

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
