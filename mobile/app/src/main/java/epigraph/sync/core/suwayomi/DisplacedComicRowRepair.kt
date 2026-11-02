package epigraph.sync.core.suwayomi

import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import tachiyomi.data.Aethon_portable_chapter_binding
import tachiyomi.data.Aethon_portable_work_binding
import tachiyomi.data.SelectDisplacedComicRows
import yokai.data.Database
import yokai.data.DatabaseHandler

/**
 * Gives back the rows portable comic entries took from the catalog, which doubled the library.
 *
 * A portable entry used to claim its work's row from the catalog identity that owned it, dropping
 * that identity and the source bindings tied to it, and then gave the row the work's id or a source
 * made up from the title. The catalog could no longer find the row and added a second one, so the
 * title shows twice and its reading state sits on the row no source can list.
 *
 * Reading state, categories and trackers move to the row that stays, and the other leaves the
 * library. A row with no second row goes back to the identity or source it came from. Nothing here
 * reaches the outbox: the works stay in the library, so the Core has nothing to learn. The pass is
 * idempotent and runs in batches: a transaction per title reruns the library queries once per title,
 * and one for a whole large library holds every write back for minutes on a phone.
 */
class DisplacedComicRowRepair(
    private val database: DatabaseHandler,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    suspend fun repair(): Int {
        val displaced = database.awaitList {
            aethon_syncQueries.selectDisplacedComicRows(EpigraphCoreSource.ID)
        }
        val displacedIds = displaced.mapTo(HashSet()) { it.manga_id }
        return displaced.chunked(BATCH_SIZE).sumOf { batch ->
            database.await(inTransaction = true) {
                repairDisplacedComicRows(this, batch, displacedIds, clock())
            }
        }
    }

    private companion object {
        const val BATCH_SIZE = 50
    }
}

internal fun repairDisplacedComicRows(
    database: Database,
    rows: List<SelectDisplacedComicRows>,
    displacedIds: Set<Long>,
    now: Long,
): Int {
    return rows.count { row ->
        val binding = database.aethon_syncQueries.selectPortableWorkBinding(row.entity_id).executeAsOneOrNull()
        val catalogId = catalogEntityId(row.url)
        val twin = twinOf(database, binding, catalogId, displacedIds)
        when {
            twin != null -> {
                mergeIntoTwin(database, row, binding, twin, now)
                true
            }
            catalogId != null -> {
                returnToCatalog(database, row, catalogId, now)
                true
            }
            else -> restoreSource(database, row, binding)
        }
    }
}

private fun catalogEntityId(url: String): String? {
    val reference = SuwayomiCoreContentReference.parseManga(url) ?: return null
    return reference.serverId?.let { serverId ->
        "suwayomi:server:$serverId:profile:${reference.profileId}:manga:${reference.mangaId}"
    } ?: "suwayomi:profile:${reference.profileId}:manga:${reference.mangaId}"
}

private fun twinOf(
    database: Database,
    binding: Aethon_portable_work_binding?,
    catalogId: String?,
    displacedIds: Set<Long>,
): Long? {
    val bound = binding?.takeIf { it.resolution_state == PortableResolutionState.BOUND.name }
        ?.local_reference?.toLongOrNull()
    val native = binding?.source_id?.toLongOrNull()
        ?.let { source -> database.mangasQueries.findByUrlAndSource(binding.provider_key, source).executeAsList() }
        .orEmpty()
        .map { it._id }
    val catalog = catalogId
        ?.let { database.aethon_syncQueries.selectIdentityByEntityId(it).executeAsOneOrNull() }
        ?.local_reference?.toLongOrNull()
    return (listOfNotNull(bound) + native + listOfNotNull(catalog)).firstOrNull { id ->
        id !in displacedIds && database.mangasQueries.findById(id).executeAsOneOrNull() != null
    }
}

private fun mergeIntoTwin(
    database: Database,
    row: SelectDisplacedComicRows,
    binding: Aethon_portable_work_binding?,
    twin: Long,
    now: Long,
) {
    val queries = database.aethon_syncQueries
    database.categoriesQueries.findAllByMangaId(row.manga_id).executeAsList().forEach { category ->
        queries.insertMangaCategoryAssignment(twin, category._id)
    }
    moveTrackers(database, row.manga_id, twin)
    moveChapters(database, row, twin, now)

    // The portable identity stays: reader progress and chapter bindings hang from it.
    val owner = queries.selectIdentityByLocalReference("MANGA", twin.toString()).executeAsOneOrNull()
    queries.upsertIdentity(
        entityId = row.entity_id,
        contentType = "MANGA",
        localReference = if (owner == null) twin.toString() else row.entity_id,
        createdAt = now,
        updatedAt = now,
    )
    if (owner != null && owner.entity_id != row.entity_id) {
        queries.upsertEntityAlias(row.entity_id, owner.entity_id, now)
    }
    if (binding?.local_reference == row.manga_id.toString()) {
        // Hydration favorites every bound row, so a binding left here would bring the title back.
        queries.upsertPortableWorkBinding(
            portableId = binding.portable_id,
            ecosystem = binding.ecosystem,
            sourceId = binding.source_id,
            pluginId = binding.plugin_id,
            providerKey = binding.provider_key,
            dependencyKey = binding.dependency_key,
            localReference = twin.toString(),
            resolutionState = binding.resolution_state,
            resolutionReason = binding.resolution_reason,
            titleHint = binding.title_hint,
            providerLabelHint = binding.provider_label_hint,
            attemptCount = binding.attempt_count,
            updatedAt = now,
        )
    }

    val displaced = database.mangasQueries.findById(row.manga_id).executeAsOne()
    val kept = database.mangasQueries.findById(twin).executeAsOne()
    val gainsLibrary = displaced.favorite && !kept.favorite
    updateManga(
        database,
        mangaId = twin,
        favorite = true.takeIf { gainsLibrary },
        dateAdded = displaced.date_added.takeIf { gainsLibrary },
        viewer = displaced.viewer.takeIf { kept.viewer == 0L },
    )
    updateManga(database, mangaId = row.manga_id, favorite = false)
}

private fun moveTrackers(database: Database, from: Long, to: Long) {
    val held = database.manga_syncQueries.getAllByMangaId(to).executeAsList().mapTo(HashSet()) { it.sync_id }
    database.manga_syncQueries.getAllByMangaId(from).executeAsList()
        .filter { it.sync_id !in held }
        .forEach { tracker ->
            database.manga_syncQueries.update(
                mangaId = to,
                syncId = null,
                remoteId = null,
                libraryId = null,
                title = null,
                lastChapterRead = null,
                totalChapters = null,
                status = null,
                score = null,
                remoteUrl = null,
                startDate = null,
                finishDate = null,
                id = tracker._id,
            )
        }
}

/**
 * A chapter the twin also has folds into it. One with reading state the twin lacks moves there, so
 * the state outlives the row; its Core URL goes when the source's list arrives, which carries that
 * state over by chapter number. Any other chapter stays behind on the row leaving the library.
 */
private fun moveChapters(database: Database, row: SelectDisplacedComicRows, twin: Long, now: Long) {
    val kept = database.chaptersQueries.getChaptersByMangaId(twin, 0).executeAsList()
    val keptByUrl = kept.groupBy { it.url }
    val keptByNumber = kept.filter { it.chapter_number >= 0 }.groupBy { it.chapter_number }
    val history = database.historyQueries.getByMangaId(row.manga_id).executeAsList()
        .associateBy { it.history_chapter_id }
    val portable = database.aethon_syncQueries.selectPortableChaptersForWork(row.entity_id).executeAsList()
        .filter { it.resolution_state == PortableResolutionState.BOUND.name }
        .groupBy { it.local_reference }

    database.chaptersQueries.getChaptersByMangaId(row.manga_id, 0).executeAsList().forEach { chapter ->
        val matches = keptByUrl[chapter.url] ?: keptByNumber[chapter.chapter_number].orEmpty()
        val portableChapters = portable[chapter._id.toString()].orEmpty()
        if (matches.isEmpty()) {
            val hasState = chapter.read || chapter.bookmark || chapter.last_page_read > 0 || chapter._id in history
            if (hasState) moveChapter(database, chapter._id, twin)
            // The chapter list brings the real chapter; this marks the work as waiting for it.
            portableChapters.forEach { bindPortableChapter(database, it, null, now) }
            return@forEach
        }
        matches.forEach { match ->
            database.chaptersQueries.foldProgressInto(fromChapterId = chapter._id, chapterId = match._id)
        }
        val standIn = matches.first()._id
        history[chapter._id]?.let {
            database.historyQueries.mergeIntoChapter(
                historyChapterId = standIn,
                historyLastRead = it.history_last_read ?: 0L,
                historyTimeRead = it.history_time_read ?: 0L,
            )
        }
        portableChapters.forEach { bindPortableChapter(database, it, standIn, now) }
        database.chaptersQueries.delete(chapter._id)
    }
}

private fun moveChapter(database: Database, chapterId: Long, mangaId: Long) {
    database.chaptersQueries.update(
        chapterId = chapterId,
        mangaId = mangaId,
        url = null,
        name = null,
        scanlator = null,
        read = null,
        bookmark = null,
        lastPageRead = null,
        pagesLeft = null,
        chapterNumber = null,
        sourceOrder = null,
        dateFetch = null,
        dateUpload = null,
        memo = null,
    )
}

private fun bindPortableChapter(
    database: Database,
    chapter: Aethon_portable_chapter_binding,
    localChapterId: Long?,
    now: Long,
) {
    database.aethon_syncQueries.upsertPortableChapterBinding(
        portableChapterId = chapter.portable_chapter_id,
        portableWorkId = chapter.portable_work_id,
        providerKey = chapter.provider_key,
        localReference = localChapterId?.toString(),
        resolutionState = if (localChapterId != null) {
            PortableResolutionState.BOUND.name
        } else {
            PortableResolutionState.PENDING_PROVIDER.name
        },
        resolutionReason = PortableResolutionReason.CHAPTER_NOT_FOUND.name.takeIf { localChapterId == null },
        attemptCount = chapter.attempt_count,
        updatedAt = now,
    )
}

private fun returnToCatalog(database: Database, row: SelectDisplacedComicRows, catalogId: String, now: Long) {
    val queries = database.aethon_syncQueries
    // Frees the row first: an identity is unique per local row, and progress stays on the work.
    queries.upsertIdentity(row.entity_id, "MANGA", row.entity_id, now, now)
    queries.upsertIdentity(catalogId, "MANGA", row.manga_id.toString(), now, now)
    queries.upsertEntityAlias(row.entity_id, catalogId, now)
    updateManga(database, mangaId = row.manga_id, source = EpigraphCoreSource.ID)
}

private fun restoreSource(
    database: Database,
    row: SelectDisplacedComicRows,
    binding: Aethon_portable_work_binding?,
): Boolean {
    val source = binding?.source_id?.toLongOrNull() ?: return false
    updateManga(database, mangaId = row.manga_id, source = source, url = binding.provider_key)
    return true
}

private fun updateManga(
    database: Database,
    mangaId: Long,
    source: Long? = null,
    url: String? = null,
    favorite: Boolean? = null,
    dateAdded: Long? = null,
    viewer: Long? = null,
) {
    database.mangasQueries.update(
        source = source,
        url = url,
        artist = null,
        author = null,
        description = null,
        genre = null,
        title = null,
        status = null,
        thumbnailUrl = null,
        favorite = favorite,
        lastUpdate = null,
        initialized = null,
        viewer = viewer,
        hideTitle = null,
        chapterFlags = null,
        dateAdded = dateAdded,
        filteredScanlators = null,
        updateStrategy = null,
        coverLastModified = null,
        nextUpdate = null,
        fetchInterval = null,
        memo = null,
        mangaId = mangaId,
    )
}
