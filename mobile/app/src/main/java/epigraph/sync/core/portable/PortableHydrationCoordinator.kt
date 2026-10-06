package epigraph.sync.core.portable

import epigraph.contract.ChapterResolution
import epigraph.contract.PortableContentProvider
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderDependency
import epigraph.sync.core.replica.CoreConfirmedRecord
import epigraph.sync.core.replica.CoreReplicaKey
import epigraph.sync.core.replica.CoreReplicaProjection
import epigraph.sync.core.replica.EpigraphCoreDomainProjection
import epigraph.sync.portable.PortableComicDependencyRecord
import epigraph.sync.portable.PortableChapterBindingRecord
import epigraph.sync.portable.PortableNovelDependencyRecord
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.SqlDelightPortableDependencyStore
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import yokai.data.DatabaseHandler

data class PortableHydrationSnapshot(
    val comics: List<PortableComicDependencyRecord>,
    val novels: List<PortableNovelDependencyRecord>,
    val works: List<PortableWorkBindingRecord>,
    val chapters: List<PortableChapterBindingRecord> = emptyList(),
    /** Already-bound works that own a pending chapter; consulted, never re-resolved. */
    val chapterWorks: List<PortableWorkBindingRecord> = emptyList(),
)

data class PortableHydrationReport(
    val examinedDependencies: Int,
    val dependenciesRequiringUserAction: Int,
    val examinedWorks: Int,
    val boundWorks: Int,
    val pendingWorks: Int,
    val boundChapters: Int = 0,
    val pendingChapters: Int = 0,
)

interface PortableHydrationStore {
    suspend fun load(serverId: String, profileId: String, limit: Long): PortableHydrationSnapshot

    suspend fun persist(
        comicDependencies: List<PortableComicDependencyRecord>,
        novelDependencies: List<PortableNovelDependencyRecord>,
        works: List<PortableWorkBindingRecord>,
        chapters: List<PortableChapterBindingRecord> = emptyList(),
    )
}

class SqlDelightPortableHydrationStore(
    private val database: DatabaseHandler,
    private val json: Json = Json { ignoreUnknownKeys = true },
    private val replicaProjection: CoreReplicaProjection = EpigraphCoreDomainProjection(),
) : PortableHydrationStore {
    override suspend fun load(serverId: String, profileId: String, limit: Long): PortableHydrationSnapshot =
        database.await(inTransaction = false) {
            val dependencies = SqlDelightPortableDependencyStore(this)
            val bindings = SqlDelightPortableBindingStore(this)
            val works = bindings.pendingWorks(serverId, profileId, limit)
            val chapters = bindings.pendingChapters(serverId, profileId, limit)
            val pendingWorkIds = works.mapTo(HashSet(), PortableWorkBindingRecord::portableId)
            PortableHydrationSnapshot(
                comics = dependencies.comics(serverId, profileId),
                novels = dependencies.novels(serverId, profileId),
                works = works,
                chapters = chapters,
                chapterWorks = chapters.asSequence()
                    .map(PortableChapterBindingRecord::portableWorkId)
                    .filterNot(pendingWorkIds::contains)
                    .distinct()
                    .mapNotNull { bindings.work(it) }
                    .toList(),
            )
        }

    override suspend fun persist(
        comicDependencies: List<PortableComicDependencyRecord>,
        novelDependencies: List<PortableNovelDependencyRecord>,
        works: List<PortableWorkBindingRecord>,
        chapters: List<PortableChapterBindingRecord>,
    ) {
        database.await(inTransaction = true) {
            val dependencies = SqlDelightPortableDependencyStore(this)
            val bindings = SqlDelightPortableBindingStore(this)
            comicDependencies.forEach(dependencies::upsertComic)
            novelDependencies.forEach(dependencies::upsertNovel)
            works.forEach(bindings::upsertWork)
            works.asSequence()
                .filter { it.resolution.state == PortableResolutionState.BOUND }
                .mapNotNull { it.localReference?.toLongOrNull() }
                .distinct()
                .forEach { localMangaId ->
                    val manga = mangasQueries.findById(localMangaId).executeAsOneOrNull()
                        ?: return@forEach
                    if (!manga.favorite) {
                        mangasQueries.update(
                            source = null,
                            url = null,
                            artist = null,
                            author = null,
                            description = null,
                            genre = null,
                            title = null,
                            status = null,
                            thumbnailUrl = null,
                            favorite = true,
                            lastUpdate = null,
                            initialized = null,
                            viewer = null,
                            hideTitle = null,
                            chapterFlags = null,
                            dateAdded = null,
                            filteredScanlators = null,
                            updateStrategy = null,
                            coverLastModified = null,
                            nextUpdate = null,
                            fetchInterval = null,
                            memo = null,
                            mangaId = localMangaId,
                        )
                    }
                }
            chapters.forEach(bindings::upsertChapter)
            chapters
                .asSequence()
                .filter { it.resolution.state == PortableResolutionState.BOUND }
                .forEach { chapter ->
                    val localChapterId = chapter.localReference?.toLongOrNull() ?: return@forEach
                    val progress = aethon_syncQueries
                        .selectReaderProgress(chapter.portableWorkId)
                        .executeAsOneOrNull()
                        ?: return@forEach
                    val payload = runCatching { json.parseToJsonElement(progress.locator_json).jsonObject }
                        .getOrNull()
                        ?: return@forEach
                    when (val ref = chapter.ref) {
                        is epigraph.contract.PortableChapterRef.Novel -> {
                            val observedRef = runCatching {
                                json.decodeFromJsonElement<epigraph.contract.PortableChapterRef.Novel>(
                                    payload.getValue("portableChapterRef"),
                                )
                            }.getOrNull()
                            if (observedRef != ref) return@forEach
                            val lastPage = (progress.progression * 100.0).toLong().coerceIn(0, 100)
                            updateChapterProgress(
                                localChapterId,
                                read = lastPage >= 98,
                                bookmark = null,
                                lastPageRead = lastPage,
                                pagesLeft = 100 - lastPage,
                            )
                        }
                        is epigraph.contract.PortableChapterRef.Comic -> {
                            val observedRef = runCatching {
                                json.decodeFromJsonElement<epigraph.contract.PortableChapterRef.Comic>(
                                    payload.getValue("portableChapterRef"),
                                )
                            }.getOrNull()
                            if (observedRef != ref) return@forEach
                            val pageIndex = payload["pageIndex"]?.toString()?.toLongOrNull()
                            val pageCount = payload["pageCount"]?.toString()?.toLongOrNull()
                            val lastPage = pageIndex ?: pageCount?.let { count ->
                                (progress.progression * count).toLong().coerceAtMost(count)
                            }
                            updateChapterProgress(
                                localChapterId,
                                read = payload["read"]?.toString()?.toBooleanStrictOrNull()
                                    ?: (progress.progression >= 1.0),
                                bookmark = payload["bookmark"]?.toString()?.toBooleanStrictOrNull(),
                                lastPageRead = lastPage,
                                pagesLeft = pageCount?.let { (it - (lastPage ?: 0)).coerceAtLeast(0) },
                            )
                        }
                    }
                }
            // Reader progress keeps only a work's latest chapter, so chapter states confirmed by
            // the Core before their chapter was bound are replayed now that a local chapter exists.
            chapters
                .asSequence()
                .filter { it.resolution.state == PortableResolutionState.BOUND }
                .filter { it.ref is epigraph.contract.PortableChapterRef.Comic }
                .flatMap { chapter ->
                    aethon_syncQueries.selectCoreReplicaRecordsByEntity(
                        entityType = "comic.chapter_state",
                        entityId = "comic.chapter_state::${chapter.portableWorkId}::${chapter.portableChapterId}",
                    ).executeAsList()
                }
                .forEach { row ->
                    val element = runCatching { json.parseToJsonElement(row.record_json) }.getOrNull()
                        ?: return@forEach
                    replicaProjection.upsert(
                        this,
                        CoreConfirmedRecord(
                            key = CoreReplicaKey(row.scope_id, row.entity_type, row.entity_id),
                            serverVersion = row.server_version,
                            lamport = row.lamport,
                            record = element,
                        ),
                    )
                }
        }
    }

    private fun yokai.data.Database.updateChapterProgress(
        chapterId: Long,
        read: Boolean?,
        bookmark: Boolean?,
        lastPageRead: Long?,
        pagesLeft: Long?,
    ) {
        chaptersQueries.update(
            chapterId = chapterId,
            mangaId = null,
            url = null,
            name = null,
            scanlator = null,
            read = read,
            bookmark = bookmark,
            lastPageRead = lastPageRead,
            pagesLeft = pagesLeft,
            chapterNumber = null,
            sourceOrder = null,
            dateFetch = null,
            dateUpload = null,
            memo = null,
        )
    }
}

/** Resolves each provider graph independently; one unavailable source never blocks another. */
class PortableHydrationCoordinator(
    private val store: PortableHydrationStore,
    private val comics: PortableContentProvider,
    private val novels: PortableContentProvider,
    private val maxConcurrentSourceQueues: Int = DEFAULT_SOURCE_QUEUES,
) {
    init {
        require(comics.ecosystem == PortableEcosystem.SUWAYOMI)
        require(novels.ecosystem == PortableEcosystem.LNREADER)
        require(maxConcurrentSourceQueues in 1..MAX_SOURCE_QUEUES)
    }

    suspend fun hydrate(
        serverId: String,
        profileId: String,
        nowEpochMillis: Long,
        workLimit: Long = DEFAULT_WORK_LIMIT,
    ): PortableHydrationReport {
        require(nowEpochMillis >= 0)
        require(workLimit in 1..MAX_WORK_LIMIT)
        val snapshot = store.load(serverId, profileId, workLimit)
        val comicDependencies = inspectComics(snapshot.comics, nowEpochMillis)
        val novelDependencies = inspectNovels(snapshot.novels, nowEpochMillis)
        val dependencyGates = buildMap {
            comicDependencies.forEach {
                put(
                    DependencyKey(PortableEcosystem.SUWAYOMI, it.dependency.pkgName),
                    DependencyGate(it.resolution, it.dependency.requiredSourceIds.map { source -> source.value }.toSet()),
                )
            }
            novelDependencies.forEach {
                put(
                    DependencyKey(PortableEcosystem.LNREADER, it.dependency.pluginId),
                    DependencyGate(it.resolution),
                )
            }
        }

        val immediatelyPending = ArrayList<PortableWorkBindingRecord>()
        val eligible = ArrayList<PortableWorkBindingRecord>()
        for (work in snapshot.works) {
            val dependencyKey = work.dependencyKey
            val dependency = dependencyKey?.let { dependencyGates[DependencyKey(work.ref.ecosystem, it)] }
            val existing = if (dependency != null && dependency.resolution.state != PortableResolutionState.READY &&
                dependency.accepts(work.ref)
            ) {
                // An unavailable provider blocks acquiring new titles, not binding the titles a
                // restored backup already holds under the exact same provider identity.
                resolveExisting(work, nowEpochMillis)
            } else {
                null
            }
            when {
                existing != null -> immediatelyPending += existing
                // Older Suwayomi snapshots can retain a stable source id even after the
                // extension row itself disappeared, leaving no package name to publish in the
                // dependency manifest. If the user has independently installed a source with
                // that exact id, let the provider resolve it. Epigraph's SourceManager remains the
                // trust boundary: an absent or unloaded source deterministically returns
                // SOURCE_NOT_LOADED instead of binding to a similarly named extension.
                dependencyKey == null && work.ref is PortableWorkRef.Comic -> eligible += work
                dependency == null -> immediatelyPending += work.withResolution(
                    missingDependency(work.ref.ecosystem),
                    nowEpochMillis,
                    incrementAttempt = false,
                )
                !dependency.accepts(work.ref) -> immediatelyPending += work.withResolution(
                    conflict(),
                    nowEpochMillis,
                    incrementAttempt = false,
                )
                dependency.resolution.state != PortableResolutionState.READY -> immediatelyPending +=
                    work.withResolution(dependency.resolution, nowEpochMillis, incrementAttempt = false)
                else -> eligible += work
            }
        }

        val resolved = resolveBySourceQueue(eligible, nowEpochMillis)
        val updates = immediatelyPending + resolved
        // A chapter that arrives after its work was bound must still see that work as bound.
        val worksById = (snapshot.chapterWorks + snapshot.works + updates)
            .associateBy(PortableWorkBindingRecord::portableId)
        val chapterUpdates = resolveChapters(snapshot.chapters, worksById, nowEpochMillis)
        store.persist(comicDependencies, novelDependencies, updates, chapterUpdates)
        return PortableHydrationReport(
            examinedDependencies = comicDependencies.size + novelDependencies.size,
            dependenciesRequiringUserAction = (comicDependencies.asSequence().map { it.resolution } +
                novelDependencies.asSequence().map { it.resolution })
                .count { it.state == PortableResolutionState.REQUIRES_USER_ACTION },
            examinedWorks = snapshot.works.size,
            boundWorks = updates.count { it.resolution.state == PortableResolutionState.BOUND },
            pendingWorks = updates.count { it.resolution.state != PortableResolutionState.BOUND },
            boundChapters = chapterUpdates.count { it.resolution.state == PortableResolutionState.BOUND },
            pendingChapters = chapterUpdates.count { it.resolution.state != PortableResolutionState.BOUND },
        )
    }

    private suspend fun inspectComics(
        records: List<PortableComicDependencyRecord>,
        now: Long,
    ): List<PortableComicDependencyRecord> {
        // Inspect every dependency. Repository approval gates acquisition of a missing APK; it
        // must not disable an extension that the user has already installed and trusted through
        // Android's normal Package Installer flow.
        val dependencies = records.map { ProviderDependency.Comic(it.dependency) }
        val resolutions = inspect(comics, dependencies)
        return records.map { record ->
            val dependency = ProviderDependency.Comic(record.dependency)
            val inspected = resolutions[dependency] ?: conflict()
            record.copy(
                resolution = if (
                    record.trustState != TRUSTED &&
                    inspected.reason == PortableResolutionReason.EXTENSION_NOT_FOUND
                ) {
                    PortableResolution(
                        PortableResolutionState.REQUIRES_USER_ACTION,
                        PortableResolutionReason.EXTENSION_STORE_APPROVAL_REQUIRED,
                    )
                } else inspected,
                updatedAt = now,
            )
        }
    }

    private suspend fun inspectNovels(
        records: List<PortableNovelDependencyRecord>,
        now: Long,
    ): List<PortableNovelDependencyRecord> {
        // The same rule applies to LNReader: repository approval is required to acquire a
        // missing plugin, while an already-installed plugin remains usable.
        val dependencies = records.map { ProviderDependency.Novel(it.dependency) }
        val resolutions = inspect(novels, dependencies)
        return records.map { record ->
            val dependency = ProviderDependency.Novel(record.dependency)
            val inspected = resolutions[dependency] ?: conflict()
            record.copy(
                resolution = if (
                    record.trustState != TRUSTED &&
                    inspected.reason == PortableResolutionReason.PLUGIN_NOT_FOUND
                ) {
                    PortableResolution(
                        PortableResolutionState.REQUIRES_USER_ACTION,
                        PortableResolutionReason.PLUGIN_REPOSITORY_APPROVAL_REQUIRED,
                    )
                } else inspected,
                updatedAt = now,
            )
        }
    }

    private suspend fun inspect(
        provider: PortableContentProvider,
        dependencies: List<ProviderDependency>,
    ): Map<ProviderDependency, PortableResolution> {
        if (dependencies.isEmpty()) return emptyMap()
        return try {
            provider.inspectDependencies(dependencies).resolutions
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            dependencies.associateWith {
                PortableResolution(PortableResolutionState.RETRYABLE_FAILURE, providerFailure(it.ecosystem))
            }
        }
    }

    private suspend fun resolveBySourceQueue(
        works: List<PortableWorkBindingRecord>,
        now: Long,
    ): List<PortableWorkBindingRecord> {
        val groups = works.groupBy { SourceQueueKey.from(it.ref) }.values.toList()
        val results = ArrayList<PortableWorkBindingRecord>(works.size)
        for (window in groups.chunked(maxConcurrentSourceQueues)) {
            results += coroutineScope {
                window.map { queue ->
                    async {
                        queue.map { work -> resolveWork(work, now) }
                    }
                }.awaitAll().flatten()
            }
        }
        return results
    }

    private suspend fun resolveExisting(work: PortableWorkBindingRecord, now: Long): PortableWorkBindingRecord? {
        val provider = when (work.ref.ecosystem) {
            PortableEcosystem.SUWAYOMI -> comics
            PortableEcosystem.LNREADER -> novels
        }
        val result = try {
            provider.resolveExistingWork(work.ref)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            null
        } ?: return null
        if (result.ref != work.ref || result.resolution.state != PortableResolutionState.BOUND || result.localId == null) {
            return null
        }
        return work.copy(
            localReference = result.localId,
            resolution = result.resolution,
            attemptCount = work.attemptCount + 1,
            updatedAt = now,
        )
    }

    private suspend fun resolveWork(work: PortableWorkBindingRecord, now: Long): PortableWorkBindingRecord {
        val provider = when (work.ref.ecosystem) {
            PortableEcosystem.SUWAYOMI -> comics
            PortableEcosystem.LNREADER -> novels
        }
        val result = try {
            provider.resolveWork(work.ref)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return work.withResolution(
                PortableResolution(
                    PortableResolutionState.RETRYABLE_FAILURE,
                    PortableResolutionReason.WORK_RESOLUTION_FAILED,
                ),
                now,
            )
        }
        if (result.ref != work.ref || (result.resolution.state == PortableResolutionState.BOUND) != (result.localId != null)) {
            return work.withResolution(conflict(), now)
        }
        return work.copy(
            localReference = result.localId ?: work.localReference,
            resolution = result.resolution,
            attemptCount = work.attemptCount + 1,
            updatedAt = now,
        )
    }

    private suspend fun resolveChapters(
        chapters: List<PortableChapterBindingRecord>,
        worksById: Map<String, PortableWorkBindingRecord>,
        now: Long,
    ): List<PortableChapterBindingRecord> {
        val eligible = ArrayList<PortableChapterBindingRecord>()
        val pending = ArrayList<PortableChapterBindingRecord>()
        for (chapter in chapters) {
            if (worksById[chapter.portableWorkId]?.resolution?.state == PortableResolutionState.BOUND) {
                eligible += chapter
            } else {
                pending += chapter.copy(
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    updatedAt = now,
                )
            }
        }
        val groups = eligible.groupBy { SourceQueueKey.from(it.ref.work) }.values.toList()
        val resolved = ArrayList<PortableChapterBindingRecord>(eligible.size)
        for (window in groups.chunked(maxConcurrentSourceQueues)) {
            resolved += coroutineScope {
                window.map { queue -> async { resolveChapterQueue(queue, now) } }.awaitAll().flatten()
            }
        }
        return pending + resolved
    }

    private suspend fun resolveChapterQueue(
        chapters: List<PortableChapterBindingRecord>,
        now: Long,
    ): List<PortableChapterBindingRecord> {
        if (chapters.isEmpty()) return emptyList()
        val provider = when (chapters.first().ref.work.ecosystem) {
            PortableEcosystem.SUWAYOMI -> comics
            PortableEcosystem.LNREADER -> novels
        }
        val batch = provider as? PortableChapterBatchResolver
            ?: return chapters.map { resolveChapter(it, now) }
        val results = try {
            batch.resolveChapters(chapters.map(PortableChapterBindingRecord::ref))
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return chapters.map { chapter -> chapter.chapterFailure(now) }
        }
        val byRef = results.groupBy(ChapterResolution::ref)
        return chapters.map { chapter ->
            val result = byRef[chapter.ref]?.singleOrNull()
                ?: return@map chapter.copy(
                    resolution = conflict(),
                    attemptCount = chapter.attemptCount + 1,
                    updatedAt = now,
                )
            chapter.withResult(result, now)
        }
    }

    private suspend fun resolveChapter(
        chapter: PortableChapterBindingRecord,
        now: Long,
    ): PortableChapterBindingRecord {
        val provider = when (chapter.ref.work.ecosystem) {
            PortableEcosystem.SUWAYOMI -> comics
            PortableEcosystem.LNREADER -> novels
        }
        val result = try {
            provider.resolveChapter(chapter.ref)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return chapter.chapterFailure(now)
        }
        return chapter.withResult(result, now)
    }

    private fun PortableChapterBindingRecord.withResult(
        result: ChapterResolution,
        now: Long,
    ): PortableChapterBindingRecord {
        if (result.ref != ref || (result.resolution.state == PortableResolutionState.BOUND) != (result.localId != null)) {
            return copy(
                resolution = conflict(),
                attemptCount = attemptCount + 1,
                updatedAt = now,
            )
        }
        return copy(
            localReference = result.localId ?: localReference,
            resolution = result.resolution,
            attemptCount = attemptCount + 1,
            updatedAt = now,
        )
    }

    private fun PortableChapterBindingRecord.chapterFailure(now: Long) = copy(
        resolution = PortableResolution(
            PortableResolutionState.RETRYABLE_FAILURE,
            PortableResolutionReason.CHAPTER_RESOLUTION_FAILED,
        ),
        attemptCount = attemptCount + 1,
        updatedAt = now,
    )

    private fun PortableWorkBindingRecord.withResolution(
        value: PortableResolution,
        now: Long,
        incrementAttempt: Boolean = true,
    ) = copy(
        resolution = value,
        attemptCount = attemptCount + if (incrementAttempt) 1 else 0,
        updatedAt = now,
    )

    private data class DependencyKey(val ecosystem: PortableEcosystem, val value: String)

    private data class DependencyGate(
        val resolution: PortableResolution,
        val comicSourceIds: Set<String>? = null,
    ) {
        fun accepts(ref: PortableWorkRef): Boolean = when (ref) {
            is PortableWorkRef.Comic -> comicSourceIds?.contains(ref.sourceId.value) == true
            is PortableWorkRef.Novel -> comicSourceIds == null
        }
    }

    private data class SourceQueueKey(val ecosystem: PortableEcosystem, val value: String) {
        companion object {
            fun from(ref: PortableWorkRef): SourceQueueKey = when (ref) {
                is PortableWorkRef.Comic -> SourceQueueKey(ref.ecosystem, ref.sourceId.value)
                is PortableWorkRef.Novel -> SourceQueueKey(ref.ecosystem, ref.pluginId)
            }
        }
    }

    private companion object {
        const val TRUSTED = "TRUSTED"
        const val DEFAULT_SOURCE_QUEUES = 2
        const val MAX_SOURCE_QUEUES = 8
        const val DEFAULT_WORK_LIMIT = 1_000L
        const val MAX_WORK_LIMIT = 1_000L
    }
}

private fun missingDependency(ecosystem: PortableEcosystem) = PortableResolution(
    PortableResolutionState.PENDING_DEPENDENCY,
    if (ecosystem == PortableEcosystem.SUWAYOMI) {
        PortableResolutionReason.EXTENSION_NOT_FOUND
    } else {
        PortableResolutionReason.PLUGIN_NOT_FOUND
    },
)

private fun providerFailure(ecosystem: PortableEcosystem) =
    if (ecosystem == PortableEcosystem.SUWAYOMI) {
        PortableResolutionReason.SOURCE_OFFLINE
    } else {
        PortableResolutionReason.PLUGIN_NOT_FOUND
    }

private fun conflict() = PortableResolution(PortableResolutionState.CONFLICT)
