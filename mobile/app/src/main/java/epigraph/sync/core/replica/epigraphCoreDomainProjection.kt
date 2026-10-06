package epigraph.sync.core.replica

import epigraph.contract.ContentType
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.source.NovelSource
import epigraph.contract.EpigraphEntityId
import epigraph.contract.DecimalSourceId
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.ReaderLocator
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.sync.portable.PortableChapterBindingRecord
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.TrackerSyncKeys
import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import android.util.Log
import eu.kanade.tachiyomi.BuildConfig
import java.security.MessageDigest
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import yokai.data.Database

/**
 * Projects the Core's confirmed records into the existing local library tables.
 *
 * Core records remain the source of truth. This class only applies records that have already been
 * authenticated and durably written by [SqlDelightCoreReplicaStore], and therefore never emits a
 * local outbox command. Unknown/future entity types are intentionally ignored so a newer Core can
 * still be paired with an older APK without corrupting its local library.
 */
class EpigraphCoreDomainProjection(
    private val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    },
    private val privateBookStorageDirectory: File? = null,
) : CoreReplicaProjection {
    override suspend fun replaceScope(
        database: Database,
        scopeId: String,
        previousRecords: List<CoreConfirmedRecord>,
        previousTombstones: List<CoreConfirmedTombstone>,
        records: List<CoreConfirmedRecord>,
        tombstones: List<CoreConfirmedTombstone>,
    ) {
        val currentKeys = (records.map { it.key } + tombstones.map { it.key }).toSet()

        // An authoritative snapshot is the only operation allowed to infer absence. Demote
        // entries that disappeared from the Core mirror, while keeping local chapter/cache data
        // so a later restore or source reinstall can recover it without data loss.
        previousRecords
            .filter { it.key !in currentKeys }
            .filterNot { it.key.entityType.isBookEntityType() }
            .forEach { stale -> removeStale(database, stale.key, stale.record as? JsonObject) }
        previousTombstones
            .filter { it.key !in currentKeys }
            .filterNot { it.key.entityType.isBookEntityType() }
            .forEach { stale -> removeStale(database, stale.key, null) }

        // Entries/categories/chapters must exist before progress and assignments are applied.
        records.sortedWith(compareBy({ phase(it.key.entityType) }, { it.key.entityId }))
            .forEach { upsert(database, it) }
        tombstones.forEach { tombstone ->
            val previous = previousRecords.firstOrNull { it.key == tombstone.key }
            delete(database, tombstone, previous)
        }
        reconcileOrphanedProfileComicProgress(database, scopeId, records)
    }

    /**
     * Early Syncd builds projected Suwayomi's numeric profile identities before portable comic
     * identities were available. A later Core repair could remove those rows without the mobile
     * replica still owning the corresponding confirmed record, leaving remote-only progress
     * visible forever. A complete comic snapshot is authoritative for that profile, so prune only
     * server-originated Suwayomi profile identities that it no longer contains. Portable `comic:`
     * identities and local/outbox-owned progress are deliberately outside this repair.
     */
    private fun reconcileOrphanedProfileComicProgress(
        database: Database,
        scopeId: String,
        records: List<CoreConfirmedRecord>,
    ) {
        val profileId = scopeId.removePrefix("comics:profile:")
            .takeIf { scopeId.startsWith("comics:profile:") && it.isNotBlank() }
            ?: return
        val observedComicIds = records.asSequence()
            .filter { it.key.entityType == "comic.history" || it.key.entityType == "comic.chapter_state" }
            .mapNotNull { (it.record as? JsonObject)?.string("comicId") }
            .toHashSet()
        val profileMarker = ":profile:$profileId:manga:"
        database.aethon_syncQueries.selectRemoteReaderProgressEntityIds().executeAsList()
            .asSequence()
            .filter { it.startsWith("suwayomi:") && profileMarker in it }
            .filterNot(observedComicIds::contains)
            .forEach { comicId ->
                val historyKey = CoreReplicaKey(scopeId, "comic.history", "comic.history::$comicId")
                if (!database.hasPendingLocalMutation(historyKey)) {
                    database.aethon_syncQueries.deleteReaderProgress(comicId)
                }
            }
    }

    override suspend fun upsert(database: Database, record: CoreConfirmedRecord) {
        if (database.hasBlockingLocalMutation(record.key, record.serverVersion)) return
        val obj = record.record as? JsonObject ?: return
        when (record.key.entityType) {
            "comic.entry" -> projectComicEntry(database, record.key.entityId, obj)
            "comic.category" -> projectCategory(database, record.key.entityId, obj, "MANGA")
            "comic.category_assignment" -> projectComicAssignment(database, obj, assigned = true)
            "comic.chapter_state" -> projectComicChapterState(database, record)
            "comic.history" -> projectComicHistory(database, record, obj)
            // Page bookmarks remain in the confirmed Core mirror until the reader exposes a
            // dedicated local page-bookmark table. They must still be accepted as valid records.
            "comic.page_bookmark" -> Unit
            "novel.entry" -> projectNovelEntry(database, record.key.entityId, obj)
            "novel.category" -> projectCategory(database, record.key.entityId, obj, "NOVEL")
            "novel.category_assignment" -> projectNovelAssignment(database, obj, assigned = true)
            "novel.chapter" -> projectNovelChapter(database, record.key.entityId, obj)
            "novel.progress" -> projectNovelProgress(database, record, obj)
            "novel.bookmark" -> projectNovelBookmark(database, obj, bookmarked = true)
            "book.entry" -> projectBookEntry(database, record.key.entityId, obj)
            "book.progress" -> projectBookProgress(database, record, obj)
            "book.bookmark" -> projectBookBookmark(database, record.key.entityId, obj)
            "book.highlight" -> projectBookHighlight(database, record.key.entityId, obj)
            "book.category" -> projectCategory(database, record.key.entityId, obj, "BOOK")
            "book.category_assignment" -> projectBookCategoryAssignment(database, obj, true)
            "comic.tracking", "novel.tracking" -> projectTracking(database, record.key, obj)
        }
    }

    /**
     * Reconciles only the library bit for a fully observed Suwayomi profile. Metadata, chapter
     * rows, reader progress and assets are deliberately retained so a library removal cannot
     * destroy offline state or make a later re-add lose its local identity.
     */
    fun reconcileSuwayomiLibrary(
        database: Database,
        serverId: String,
        profileId: String,
        observedEntityIds: Set<String>,
        protectedEntityIds: Set<String> = emptySet(),
    ) {
        require(serverId.isNotBlank()) { "Core server id must not be blank" }
        require(profileId.isNotBlank()) { "Suwayomi profile must not be blank" }
        val prefix = if (serverId == epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID) {
            "suwayomi:profile:$profileId:manga:"
        } else {
            "suwayomi:server:$serverId:profile:$profileId:manga:"
        }
        database.aethon_syncQueries
            .selectEntityIdsByContentTypeAndPrefix("MANGA", "$prefix%")
            .executeAsList()
            .asSequence()
            .filterNot(observedEntityIds::contains)
            .filterNot(protectedEntityIds::contains)
            .forEach { entityId ->
                val localId = localMangaId(database, entityId) ?: return@forEach
                database.mangasQueries.markNotFavorite(localId)
            }
    }

    /**
     * Removes only stale category links owned by the fully observed Core scope. Local assignments
     * and legacy-unbound identities remain intact because none of them can be attributed to this
     * server with sufficient evidence. A folder is only deleted when its comic category was deleted
     * on this server and nothing else lives in it; a previous server's binding never deletes one.
     */
    fun reconcileSuwayomiCategoryAssignments(
        database: Database,
        serverId: String,
        profileId: String,
        observedCategoryEntityIds: Set<String>,
        observedAssignments: Set<Pair<String, String>>,
        protectedEntityIds: Set<String> = emptySet(),
    ) {
        require(serverId.isNotBlank()) { "Core server id must not be blank" }
        require(profileId.isNotBlank()) { "Suwayomi profile must not be blank" }
        if (serverId == epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID) return

        val categoryPrefix = "suwayomi:server:$serverId:profile:$profileId:category:"
        val categoriesByLocalId = database.aethon_syncQueries
            .selectCategoryIdentitiesByEntityPrefix(categoryPrefix)
            .executeAsList()
            .associateBy { it.local_category_id }
        database.aethon_syncQueries
            .selectCoreRemoteIdentitiesByScopeAndType(serverId, profileId, "SUWAYOMI_MANGA")
            .executeAsList()
            .forEach remoteLoop@{ remote ->
                if (remote.entity_id in protectedEntityIds) return@remoteLoop
                val mangaId = localMangaId(database, remote.entity_id) ?: return@remoteLoop
                database.categoriesQueries.findAllByMangaId(mangaId).executeAsList()
                    .forEach categoryLoop@{ category ->
                        val identity = categoriesByLocalId[category._id] ?: return@categoryLoop
                        if ((remote.entity_id to identity.entity_id) !in observedAssignments) {
                            database.aethon_syncQueries.deleteMangaCategoryAssignment(mangaId, category._id)
                        }
                    }
            }

        // A complete catalog read is authoritative for Core-owned categories.
        database.aethon_syncQueries.selectCategoryIdentitiesByContentScope("MANGA")
            .executeAsList()
            .forEach { identity ->
                val id = identity.entity_id
                val belongsToCurrent = id.startsWith(categoryPrefix)
                val belongsToPreviousServer = id.startsWith("suwayomi:server:") &&
                    ":profile:$profileId:category:" in id &&
                    !belongsToCurrent
                when {
                    // Re-pairing to another Core (or a reinstalled desktop) says nothing about the
                    // user's folder: only the binding to the old server is dropped. The folder and its
                    // assignments stay; a folder holding comics is created on the new server by
                    // SuwayomiCategoryCreateHook, any other joins a same-named category.
                    belongsToPreviousServer -> database.aethon_syncQueries.deleteCategoryIdentity(id)
                    belongsToCurrent && id !in observedCategoryEntityIds -> {
                        // Deleted on the desktop (or gone after a Suwayomi restore). A folder that also
                        // belongs to the novel or book library, or holds novels or books, outlives its
                        // comic category: it only loses the comic binding and the Suwayomi comics.
                        val local = identity.local_category_id
                        val sharedWithOtherLibrary = database.aethon_syncQueries
                            .selectCategoryIdentitiesByLocalId(local)
                            .executeAsList()
                            .any { it.entity_id != id } ||
                            database.aethon_syncQueries.folderHoldsNovelsOrBooks(local).executeAsOne()
                        if (sharedWithOtherLibrary) {
                            database.aethon_syncQueries
                                .selectCoreRemoteIdentitiesByScopeAndType(serverId, profileId, "SUWAYOMI_MANGA")
                                .executeAsList()
                                .filterNot { it.entity_id in protectedEntityIds }
                                .mapNotNull { localMangaId(database, it.entity_id) }
                                .forEach { mangaId ->
                                    database.aethon_syncQueries.deleteMangaCategoryAssignment(mangaId, local)
                                }
                            database.aethon_syncQueries.deleteCategoryIdentity(id)
                        } else {
                            database.categoriesQueries.delete(local)
                        }
                    }
                }
            }
    }

    override suspend fun delete(
        database: Database,
        tombstone: CoreConfirmedTombstone,
        previousRecord: CoreConfirmedRecord?,
    ) {
        if (
            tombstone.key.entityType == "book.entry" &&
            database.hasBlockingBookMutationTree(tombstone.key, tombstone.serverVersion)
        ) return
        if (database.hasBlockingLocalMutation(tombstone.key, tombstone.serverVersion)) return
        val previous = previousRecord?.record as? JsonObject
        when (tombstone.key.entityType) {
            "comic.entry" -> demoteEntry(database, tombstone.key.entityId)
            "comic.category_assignment" -> previous?.let { projectComicAssignment(database, it, false) }
            "comic.chapter_state" -> {
                database.aethon_syncQueries.deleteChapterBindingByEntityId(
                    previous?.string("chapterId") ?: tombstone.key.entityId,
                )
            }
            "comic.history" -> {
                val comicId = previous?.string("comicId")
                    ?: tombstone.key.entityId.removePrefix("comic.history::")
                database.aethon_syncQueries.deleteReaderProgress(comicId)
            }
            "novel.entry" -> demoteEntry(database, tombstone.key.entityId)
            "book.entry" -> removeBookEntry(database, tombstone.key.entityId)
            "novel.category" -> removeCategoryBinding(database, tombstone.key.entityId, "NOVEL")
            "book.category" -> removeCategoryBinding(database, tombstone.key.entityId, "BOOK")
            "novel.category_assignment" -> previous?.let { projectNovelAssignment(database, it, false) }
            "book.category_assignment" -> previous?.let { projectBookCategoryAssignment(database, it, false) }
            "novel.progress" -> {
                database.aethon_syncQueries.deleteReaderProgress(
                    canonicalNovelProgressId(tombstone.key.entityId),
                )
            }
            "book.progress" -> {
                removeBookProgress(database, tombstone.key.entityId)
            }
            "book.bookmark" -> database.local_booksQueries.deleteBookmark(tombstone.key.entityId)
            "book.highlight" -> database.local_booksQueries.deleteHighlight(tombstone.key.entityId)
            "novel.bookmark" -> previous?.let { projectNovelBookmark(database, it, bookmarked = false) }
            "novel.chapter" -> {
                database.aethon_syncQueries.deleteChapterBindingByEntityId(tombstone.key.entityId)
            }
            "comic.tracking", "novel.tracking" -> removeTracking(database, tombstone.key, previous)
        }
    }

    private fun phase(entityType: String): Int = when (entityType) {
        "comic.entry", "comic.category", "novel.entry", "book.entry", "novel.category", "book.category" -> 0
        "comic.chapter_state", "novel.chapter" -> 1
        "comic.category_assignment", "novel.category_assignment", "book.category_assignment" -> 2
        "comic.history", "comic.page_bookmark", "novel.progress", "novel.bookmark", "book.progress", "book.bookmark", "book.highlight" -> 3
        "comic.tracking", "novel.tracking" -> 3
        else -> 4
    }

    private fun removeStale(database: Database, stale: CoreReplicaKey, previous: JsonObject?) {
        if (database.hasPendingLocalMutation(stale)) return
        when (stale.entityType) {
            "comic.entry" -> demoteEntry(database, stale.entityId)
            "comic.category_assignment" -> previous?.let { projectComicAssignment(database, it, false) }
            "comic.chapter_state" -> {
                database.aethon_syncQueries.deleteChapterBindingByEntityId(
                    previous?.string("chapterId") ?: stale.entityId,
                )
            }
            "comic.history" -> {
                val comicId = previous?.string("comicId")
                    ?: stale.entityId.removePrefix("comic.history::")
                database.aethon_syncQueries.deleteReaderProgress(comicId)
            }
            "novel.entry" -> demoteEntry(database, stale.entityId)
            "book.entry" -> removeBookEntry(database, stale.entityId)
            "novel.category" -> removeCategoryBinding(database, stale.entityId, "NOVEL")
            "book.category" -> removeCategoryBinding(database, stale.entityId, "BOOK")
            "novel.category_assignment" -> previous?.let { projectNovelAssignment(database, it, false) }
            "book.category_assignment" -> previous?.let { projectBookCategoryAssignment(database, it, false) }
            "novel.progress" -> {
                database.aethon_syncQueries.deleteReaderProgress(canonicalNovelProgressId(stale.entityId))
            }
            "book.progress" -> {
                removeBookProgress(database, stale.entityId)
            }
            "book.bookmark" -> database.local_booksQueries.deleteBookmark(stale.entityId)
            "book.highlight" -> database.local_booksQueries.deleteHighlight(stale.entityId)
            "novel.bookmark" -> previous?.let { projectNovelBookmark(database, it, bookmarked = false) }
            "comic.tracking", "novel.tracking" -> removeTracking(database, stale, previous)
        }
    }

    /**
     * Applies one non-secret tracker binding to `manga_sync`. The insert replaces the
     * `(manga_id, sync_id)` row, so replaying the same record is idempotent. Records whose work is
     * not on this device, whose tracker is unknown to this build, or whose fields are malformed are
     * skipped without failing the rest of the snapshot; unknown extra fields are ignored.
     */
    private fun projectTracking(database: Database, key: CoreReplicaKey, record: JsonObject) {
        val target = trackingTarget(database, key, record) ?: return
        val remoteId = record.long("remoteId") ?: return
        val title = record.string("title") ?: return
        val remoteUrl = record.string("remoteUrl") ?: return
        val status = record.long("status") ?: return
        val progress = record.double("progress")?.takeIf(Double::isFinite) ?: return
        val totalChapters = record.long("totalChapters") ?: return
        val score = record.double("score")?.takeIf(Double::isFinite) ?: return
        database.manga_syncQueries.insert(
            mangaId = target.first,
            syncId = target.second,
            remoteId = remoteId,
            libraryId = record.long("libraryId"),
            title = title,
            lastChapterRead = progress,
            totalChapters = totalChapters,
            status = status,
            score = score,
            remoteUrl = remoteUrl,
            startDate = record.long("startedAtMs") ?: 0L,
            finishDate = record.long("finishedAtMs") ?: 0L,
        )
    }

    private fun removeTracking(database: Database, key: CoreReplicaKey, previous: JsonObject?) {
        val (mangaId, syncId) = trackingTarget(database, key, previous) ?: return
        database.manga_syncQueries.deleteForManga(mangaId, syncId)
    }

    /** Resolves `<entityType>::<workId>::<trackerKey>` to the local `(manga_id, sync_id)`. */
    private fun trackingTarget(
        database: Database,
        key: CoreReplicaKey,
        record: JsonObject?,
    ): Pair<Long, Long>? {
        val trackerKey = record?.string("trackerKey") ?: key.entityId.substringAfterLast("::")
        val syncId = TrackerSyncKeys.syncIdFor(trackerKey) ?: return null
        val prefix = "${key.entityType}::"
        val suffix = "::$trackerKey"
        if (!key.entityId.startsWith(prefix) || !key.entityId.endsWith(suffix)) return null
        val workId = key.entityId.substring(prefix.length, key.entityId.length - suffix.length)
        if (workId.isBlank()) return null
        val recordWorkId = record?.string(if (key.entityType == "comic.tracking") "comicId" else "novelId")
        if (recordWorkId != null && recordWorkId != workId) return null

        val portableLocalId = SqlDelightPortableBindingStore(database).work(workId)
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            ?.localReference?.toLongOrNull()?.takeIf { it > 0 }
        val mangaId = portableLocalId
            ?: if (key.entityType == "novel.tracking") localMangaId(database, workId) else null
        mangaId ?: return null
        database.mangasQueries.findById(mangaId).executeAsOneOrNull() ?: return null
        return mangaId to syncId
    }

    /** Projects a Core comic entry into the existing local manga/library row. */
    private fun projectComicEntry(database: Database, entityId: String, record: JsonObject) {
        val comicId = record.string("comicId") ?: record.string("mangaId") ?: entityId
        val coreReference = verifiedCoreMangaReference(entityId, record)
        val previousLocalId = localMangaId(database, entityId) ?: localMangaId(database, comicId)
        val carriesPortableRef = record.containsKey("portableWorkRef")
        val portableRef = portableComicReference(record)?.takeIf { ref ->
            !carriesPortableRef || PortableIdentityV3.workId(ref).let { portableId ->
                entityId == portableId && comicId == portableId
            }
        }
        val portableStore = SqlDelightPortableBindingStore(database)
        val portableBinding = portableRef?.let(portableStore::work)
        val boundPortableLocal = portableBinding
                ?.takeIf { binding ->
                    binding.resolution.state == PortableResolutionState.BOUND &&
                        binding.localReference != null
                }
                ?.localReference
                ?.toLongOrNull()
                ?.takeIf { it > 0 }
                ?.let { database.mangasQueries.findById(it).executeAsOneOrNull() }
                ?.takeIf { manga ->
                    val ref = portableRef
                    manga.source == ref.sourceId.toLong() && manga.url == ref.mangaKey.value ||
                        manga.source == EpigraphCoreSource.ID
                }
        val exactSourceLocal = portableRef?.let { ref ->
            database.aethon_syncQueries.selectMangaByExactSourceBinding(
                sourceId = ref.sourceId.value,
                providerKey = ref.mangaKey.value,
                excludedEntityId = entityId,
            ).executeAsList().firstOrNull()
        }
        // A title restored natively on this phone (e.g. from the same J2K/Mihon backup the desktop
        // imported) has no Core identity yet. An exact (source id, provider key) row that no other
        // identity owns is the same work, so adopt it instead of adding a duplicate bridge row.
        val unownedNativeLocal = portableRef
            ?.takeIf { boundPortableLocal == null && exactSourceLocal == null && previousLocalId == null }
            ?.let { ref ->
                database.mangasQueries.findByUrlAndSource(ref.mangaKey.value, ref.sourceId.toLong())
                    .executeAsList()
                    .filter { manga ->
                        manga.source != EpigraphCoreSource.ID &&
                            database.aethon_syncQueries.selectIdentityByLocalReference(
                                contentType = "MANGA",
                                localReference = manga._id.toString(),
                            ).executeAsOneOrNull() == null
                    }
                    .maxByOrNull { manga -> manga.favorite }
            }
        val portableLocal = boundPortableLocal ?: exactSourceLocal ?: unownedNativeLocal
        val portableOwner = portableLocal?.let { manga ->
            database.aethon_syncQueries.selectIdentityByLocalReference(
                contentType = "MANGA",
                localReference = manga._id.toString(),
            ).executeAsOneOrNull()
        }
        // Suwayomi's numeric manga id can change after a profile restore. An exact portable
        // source/key binding proves that the current catalog row and the previous server identity
        // represent the same work. Transfer identity ownership before projection so the existing
        // native row, chapters and categories survive without violating the unique local binding.
        val transferredOwner = portableOwner?.takeIf { owner ->
            previousLocalId == null && owner.entity_id != entityId
        }
        val transferredProgress = transferredOwner?.let { owner ->
            database.aethon_syncQueries.selectReaderProgress(owner.entity_id).executeAsOneOrNull()
        }
        transferredOwner?.let { owner ->
            database.aethon_syncQueries.deleteIdentityByEntityId(owner.entity_id)
        }
        // A portable binding may still point at the row owned by a previously paired Core. This
        // also happens for native extension rows after a re-pair: the old server identity owns the
        // native row while the current server identity already owns the row created during the
        // first snapshot. Reassigning the current identity to the old row would violate
        // UNIQUE(content_type, local_reference), so the current server-scoped identity wins and
        // the old row's categories/chapter state are merged into it below.
        val stalePortableBinding = portableLocal?.takeIf { manga ->
            val owner = database.aethon_syncQueries.selectIdentityByLocalReference(
                contentType = "MANGA",
                localReference = manga._id.toString(),
            ).executeAsOneOrNull()
            previousLocalId != null &&
                manga._id != previousLocalId &&
                owner != null &&
                owner.entity_id != entityId
        }
        val effectivePortableLocal = portableLocal.takeUnless { stalePortableBinding != null }
        val existingLocalId = effectivePortableLocal?._id ?: previousLocalId
        val existingTitle = existingLocalId?.let { localId ->
            database.mangasQueries.findById(localId).executeAsOneOrNull()?.title
        }
        val title = record.string("title")?.takeIf { it.isNotBlank() } ?: existingTitle ?: return
        // The Core catalog sends both the provider-owned extension key (`providerKey`, Suwayomi's
        // `url`) and its web representation (`url`, Suwayomi's `realUrl`). The local extension
        // resolves its own key format, so the preserved binding (and any later relink) must use
        // the key, not the web URL — sources such as Comick reject absolute web URLs and would
        // surface zero chapters.
        val providerKey = record.string("providerKey")?.takeIf(String::isNotBlank)
        val originalUrl = providerKey
            ?: record.string("url")
            ?: record.string("path")
            ?: record.string("identityKey")
            ?: comicId
        val localSourceId = (record["source"] as? JsonObject)
            ?.string("id")
            ?.toLongOrNull()
            ?: record.string("sourceId")?.toLongOrNull()
        val existingLocal = existingLocalId?.let { localId ->
            database.mangasQueries.findById(localId).executeAsOneOrNull()
        }
        // A rebound entity keeps its historical server-scoped id, so verifiedCoreMangaReference
        // can legitimately return null here. Never downgrade an existing authenticated bridge
        // reference to a raw provider path in that case.
        val preservedBridgeUrl = existingLocal
            ?.takeIf { manga -> manga.source == EpigraphCoreSource.ID }
            ?.url
            ?.takeIf { value -> SuwayomiCoreContentReference.parseManga(value) != null }
        val url = coreReference?.let {
            it.serverId?.let { serverId ->
                SuwayomiCoreContentReference.forManga(serverId, it.profileId, it.mangaId)
            } ?: SuwayomiCoreContentReference.forManga(it.profileId, it.mangaId)
        } ?: preservedBridgeUrl ?: originalUrl
        val preservedLocalBinding = existingLocal?.takeIf { manga ->
            localSourceId != null &&
                manga.source == localSourceId &&
                manga.source != EpigraphCoreSource.ID
        }
        val localId = ensureManga(
            database = database,
            entityId = entityId,
            contentType = "MANGA",
            source = effectivePortableLocal?.source
                ?: preservedLocalBinding?.source
                ?: if (coreReference != null) EpigraphCoreSource.ID else stableSourceId(record, comicId),
            url = effectivePortableLocal?.url ?: preservedLocalBinding?.url ?: url,
            title = title,
            author = record.string("author"),
            description = record.string("description"),
            genre = record.strings("tags").ifEmpty {
                record.string("genre")?.split(',').orEmpty().map(String::trim)
            }.filter(String::isNotBlank).joinToString(", ").ifBlank { null },
            thumbnailUrl = coreReference?.let {
                it.serverId?.let { serverId ->
                    SuwayomiCoreThumbnailReference.forManga(serverId, it.profileId, it.mangaId)
                } ?: SuwayomiCoreThumbnailReference.forManga(it.profileId, it.mangaId)
            } ?: record.string("coverUrl") ?: record.string("thumbnailUrl"),
            dateAdded = record.long("addedAtMs") ?: now(record),
            lastUpdate = record.long("updatedAtMs") ?: now(record),
            // A complete catalog row remains usable as last-known-good metadata after unpairing.
            initialized = true,
            preferredLocalId = existingLocalId,
        ) ?: return

        transferredOwner?.let { owner ->
            database.aethon_syncQueries.upsertEntityAlias(
                aliasEntityId = owner.entity_id,
                canonicalEntityId = entityId,
                receivedAt = now(record),
            )
            portableBinding?.let { binding ->
                portableStore.upsertWork(
                    binding.copy(
                        localReference = localId.toString(),
                        resolution = PortableResolution(PortableResolutionState.BOUND),
                        updatedAt = now(record),
                    ),
                )
            }
        }
        transferredProgress?.let { progress ->
            database.aethon_syncQueries.upsertRemoteReaderProgress(
                entityId = entityId,
                chapterEntityId = null,
                locatorJson = progress.locator_json,
                chapterOrdinal = progress.chapter_ordinal,
                progression = progress.progression,
                serverRevision = progress.server_revision,
                updatedAt = progress.updated_at,
            )
        }

        if (stalePortableBinding != null && stalePortableBinding._id != localId) {
            database.categoriesQueries.findAllByMangaId(stalePortableBinding._id).executeAsList().forEach { category ->
                database.aethon_syncQueries.insertMangaCategoryAssignment(localId, category._id)
            }
            database.chaptersQueries
                .getChaptersByMangaId(stalePortableBinding._id, 0)
                .executeAsList()
                .forEach { chapter ->
                    val current = database.chaptersQueries
                        .getChaptersByUrlAndMangaId(chapter.url, localId, 0)
                        .executeAsList()
                        .firstOrNull()
                    if (current == null) {
                        database.chaptersQueries.update(
                            chapterId = chapter._id,
                            mangaId = localId,
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
                    } else if (
                        chapter.read && !current.read ||
                        chapter.bookmark && !current.bookmark ||
                        chapter.last_page_read > current.last_page_read
                    ) {
                        database.chaptersQueries.update(
                            chapterId = current._id,
                            mangaId = null,
                            url = null,
                            name = null,
                            scanlator = null,
                            read = current.read || chapter.read,
                            bookmark = current.bookmark || chapter.bookmark,
                            lastPageRead = maxOf(current.last_page_read, chapter.last_page_read),
                            pagesLeft = null,
                            chapterNumber = null,
                            sourceOrder = null,
                            dateFetch = null,
                            dateUpload = null,
                            memo = null,
                        )
                    }
                }
            portableBinding?.let { binding ->
                portableStore.upsertWork(
                    binding.copy(
                        localReference = localId.toString(),
                        resolution = PortableResolution(PortableResolutionState.BOUND),
                        updatedAt = now(record),
                    ),
                )
            }
            demoteManga(database, stalePortableBinding._id)
        }

        if (previousLocalId != null && previousLocalId != localId) {
            database.categoriesQueries.findAllByMangaId(previousLocalId).executeAsList().forEach { category ->
                database.aethon_syncQueries.insertMangaCategoryAssignment(localId, category._id)
            }
            database.mangasQueries.findById(previousLocalId).executeAsOneOrNull()
                ?.takeIf { it.source == EpigraphCoreSource.ID }
                ?.let { demoteManga(database, previousLocalId) }
        }

        if (coreReference != null) {
            database.aethon_syncQueries.upsertCoreRemoteIdentity(
                entityId = entityId,
                serverId = coreReference.serverId ?: epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID,
                profileId = coreReference.profileId,
                remoteType = "SUWAYOMI_MANGA",
                remoteId = coreReference.mangaId.toString(),
                bindingStatus = if (coreReference.serverId == null) "LEGACY_UNBOUND" else "BOUND",
                updatedAt = now(record),
            )
            preserveOriginalSourceBinding(database, entityId, record, originalUrl, coreReference)
        }

        // Core snapshots normally contain only library entries. Keeping this field optional lets
        // older Core versions send metadata-only records without accidentally removing a local
        // favorite when the field is absent.
        record.boolean("inLibrary")?.let { inLibrary ->
            database.mangasQueries.update(
                source = null,
                url = null,
                artist = null,
                author = null,
                description = null,
                genre = null,
                title = null,
                status = null,
                thumbnailUrl = null,
                favorite = inLibrary,
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
                mangaId = localId,
            )
        }
    }

    private fun projectComicAssignment(database: Database, record: JsonObject, assigned: Boolean) {
        val comicId = record.string("comicId") ?: record.string("mangaId") ?: return
        val categoryId = record.string("categoryId") ?: return
        val mangaId = portableComicLocalMangaId(database, comicId, record)
            ?: localMangaId(database, comicId)
            ?: return
        val category = database.aethon_syncQueries
            .selectCategoryIdentityByEntityId(categoryId)
            .executeAsOneOrNull()
            ?: return
        if (assigned) {
            database.aethon_syncQueries.insertMangaCategoryAssignment(mangaId, category.local_category_id)
        } else {
            database.aethon_syncQueries.deleteMangaCategoryAssignment(mangaId, category.local_category_id)
        }
    }

    /**
     * A state for a title that is already bound can name a chapter fetched after the last
     * hydration; bind the local row now instead of parking the state until the next pass.
     */
    private fun bindFetchedLocalChapter(
        database: Database,
        store: SqlDelightPortableBindingStore,
        work: PortableWorkBindingRecord,
        chapter: PortableChapterBindingRecord,
        updatedAt: Long,
    ): PortableChapterBindingRecord {
        if (chapter.resolution.state == PortableResolutionState.BOUND ||
            work.resolution.state != PortableResolutionState.BOUND
        ) {
            return chapter
        }
        val ref = chapter.ref as? PortableChapterRef.Comic ?: return chapter
        val mangaId = work.localReference?.toLongOrNull() ?: return chapter
        val local = database.chaptersQueries
            .getChaptersByUrlAndMangaId(ref.chapterKey.value, mangaId, 0)
            .executeAsList()
            .firstOrNull() ?: return chapter
        val bound = chapter.copy(
            localReference = local._id.toString(),
            resolution = PortableResolution(PortableResolutionState.BOUND),
            updatedAt = updatedAt,
        )
        store.upsertChapter(bound)
        return bound
    }

    /**
     * Projects the future Core comic chapter-state entity. The payload deliberately accepts both
     * the protocol names and the legacy local names so a bridge can evolve without a client-only
     * migration.
     */
    private fun projectComicChapterState(database: Database, record: CoreConfirmedRecord) {
        val obj = record.record as? JsonObject ?: return
        val comicId = obj.string("comicId") ?: obj.string("mangaId") ?: return
        val portableWork = obj["portableWorkRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableWorkRef.Comic>(element) }.getOrNull()
        }
        val portableChapter = obj["portableChapterRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableChapterRef.Comic>(element) }.getOrNull()
        }
        val carriesPortableRefs = obj.containsKey("portableWorkRef") || obj.containsKey("portableChapterRef")
        val portableWorkId = portableWork?.let(PortableIdentityV3::workId)
        val portableChapterId = portableChapter?.let(PortableIdentityV3::chapterId)
        val validPortableRefs = portableWork != null &&
            portableChapter != null &&
            portableChapter.work == portableWork &&
            comicId == portableWorkId &&
            obj.string("chapterId") == portableChapterId
        if (carriesPortableRefs && !validPortableRefs) return
        if (validPortableRefs) {
            val store = SqlDelightPortableBindingStore(database)
            var workBinding = store.work(requireNotNull(portableWork))
            if (workBinding == null) {
                workBinding = PortableWorkBindingRecord(
                    portableId = requireNotNull(portableWorkId),
                    ref = portableWork,
                    dependencyKey = null,
                    localReference = null,
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    titleHint = null,
                    providerLabelHint = null,
                    attemptCount = 0,
                    updatedAt = obj.long("updatedAtMs") ?: now(obj),
                )
                store.upsertWork(workBinding)
            }
            markPortableStateMembership(database, record, requireNotNull(portableWorkId))
            var chapterBinding = store.chapter(requireNotNull(portableChapterId))
            if (chapterBinding == null) {
                chapterBinding = PortableChapterBindingRecord(
                    portableChapterId = portableChapterId,
                    portableWorkId = portableWorkId,
                    ref = portableChapter,
                    localReference = null,
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    attemptCount = 0,
                    updatedAt = obj.long("updatedAtMs") ?: now(obj),
                )
                store.upsertChapter(chapterBinding)
            }
            chapterBinding = bindFetchedLocalChapter(
                database, store, workBinding, chapterBinding, obj.long("updatedAtMs") ?: now(obj),
            )
            applyComicProgress(
                database = database,
                comicId = portableWorkId,
                chapterEntityId = portableChapterId,
                localChapterId = chapterBinding.localReference?.toLongOrNull(),
                record = obj,
                serverRevision = record.serverVersion,
                updatedAt = obj.long("updatedAtMs") ?: now(obj),
            )
            removeLegacySyntheticComicChapter(
                database = database,
                record = obj,
                canonicalLocalChapterId = chapterBinding.localReference?.toLongOrNull(),
            )
            return
        }
        val chapterEntityId = obj.string("chapterId") ?: record.key.entityId
        val existingBinding = database.aethon_syncQueries
            .selectChapterBindingByEntityId(chapterEntityId)
            .executeAsOneOrNull()
        val explicitPath = obj.string("url") ?: obj.string("path")
        // A chapter-state entity is allowed to contain only reader state. Such a record must
        // never materialize catalog data from its technical entity id: doing so used to create
        // duplicate, zero-number chapters beside the real source chapters.
        if (existingBinding == null && explicitPath == null) {
            applyComicProgress(
                database = database,
                comicId = comicId,
                chapterEntityId = null,
                localChapterId = null,
                record = obj,
                serverRevision = record.serverVersion,
                updatedAt = obj.long("updatedAtMs") ?: now(obj),
            )
            return
        }
        val mangaId = localMangaId(database, comicId) ?: return
        val path = explicitPath ?: existingBinding?.normalized_url ?: chapterEntityId
        val coreReference = verifiedProjectedCoreManga(database, comicId)
        val localUrl = coreReference
            ?.let { reference ->
                chapterEntityId.toLongOrNull()?.takeIf { it > 0 }?.let { chapterId ->
                    reference.serverId?.let { serverId ->
                        SuwayomiCoreContentReference.forChapter(serverId, reference.profileId, chapterId)
                    } ?: SuwayomiCoreContentReference.forChapter(reference.profileId, chapterId)
                }
            }
            ?: path
        val title = obj.string("title")?.takeIf { it.isNotBlank() } ?: path
        val ordinal = obj.double("chapterNumber") ?: obj.double("chapterOrderKey") ?: 0.0
        val localChapterId = existingBinding?.local_chapter_id ?: ensureChapterBinding(
                database = database,
                chapterEntityId = chapterEntityId,
                workEntityId = comicId,
                mangaId = mangaId,
                localUrl = localUrl,
                normalizedUrl = path,
                title = title,
                ordinal = ordinal,
                scanlator = obj.string("scanlator"),
                dateFetch = obj.long("updatedAtMs") ?: now(obj),
                dateUpload = obj.long("releaseTimeMs") ?: obj.long("dateUpload") ?: 0L,
            )
        applyComicProgress(
            database = database,
            comicId = comicId,
            chapterEntityId = chapterEntityId,
            localChapterId = localChapterId,
            record = obj,
            serverRevision = record.serverVersion,
            updatedAt = obj.long("updatedAtMs") ?: now(obj),
        )
    }

    /**
     * Removes only the exact synthetic chapter created by pre-portable Core snapshots. Real
     * source chapters are never touched: the legacy row must use the technical entity id as both
     * URL and title and have chapter number zero.
     */
    private fun removeLegacySyntheticComicChapter(
        database: Database,
        record: JsonObject,
        canonicalLocalChapterId: Long?,
    ) {
        val serverId = record.string("coreServerId") ?: return
        val profileId = record.string("coreProfileId") ?: return
        val chapterId = record.long("suwayomiChapterId") ?: return
        if (chapterId <= 0L) return
        val legacyEntityId = "suwayomi:server:$serverId:profile:$profileId:chapter:$chapterId"
        val legacyBinding = database.aethon_syncQueries
            .selectChapterBindingByEntityId(legacyEntityId)
            .executeAsOneOrNull()
            ?: return
        if (legacyBinding.local_chapter_id == canonicalLocalChapterId) return
        val legacyChapter = database.chaptersQueries
            .getChaptersById(legacyBinding.local_chapter_id)
            .executeAsOneOrNull()
            ?: return
        val isSynthetic = legacyChapter.url == legacyEntityId &&
            legacyChapter.name == legacyEntityId &&
            legacyChapter.chapter_number == 0.0
        if (!isSynthetic) return
        database.aethon_syncQueries.deleteChapterBindingByEntityId(legacyEntityId)
        database.chaptersQueries.delete(legacyBinding.local_chapter_id)
    }

    /** Maps the currently supported Core comic.history records to the normal chapter reader. */
    private fun projectComicHistory(
        database: Database,
        recordKey: CoreConfirmedRecord,
        record: JsonObject,
    ) {
        val comicId = record.string("comicId") ?: return
        val portableWork = record["portableWorkRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableWorkRef.Comic>(element) }.getOrNull()
        }
        val portableChapter = record["portableChapterRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableChapterRef.Comic>(element) }.getOrNull()
        }
        val carriesPortableRefs = record.containsKey("portableWorkRef") || record.containsKey("portableChapterRef")
        val portableWorkId = portableWork?.let(PortableIdentityV3::workId)
        val portableChapterId = portableChapter?.let(PortableIdentityV3::chapterId)
        val validPortableRefs = portableWork != null &&
            portableChapter != null &&
            portableChapter.work == portableWork &&
            comicId == portableWorkId &&
            record.string("chapterId") == portableChapterId
        if (carriesPortableRefs && !validPortableRefs) return
        if (validPortableRefs) {
            val store = SqlDelightPortableBindingStore(database)
            var workBinding = store.work(requireNotNull(portableWork))
            if (workBinding == null) {
                workBinding = PortableWorkBindingRecord(
                    portableId = requireNotNull(portableWorkId),
                    ref = portableWork,
                    dependencyKey = null,
                    localReference = null,
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    titleHint = null,
                    providerLabelHint = null,
                    attemptCount = 0,
                    updatedAt = record.long("readAtMs") ?: now(record),
                )
                store.upsertWork(workBinding)
            }
            markPortableStateMembership(database, recordKey, requireNotNull(portableWorkId))
            var chapterBinding = store.chapter(requireNotNull(portableChapterId))
            if (chapterBinding == null) {
                chapterBinding = PortableChapterBindingRecord(
                    portableChapterId = portableChapterId,
                    portableWorkId = requireNotNull(portableWorkId),
                    ref = portableChapter,
                    localReference = null,
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    attemptCount = 0,
                    updatedAt = record.long("readAtMs") ?: now(record),
                )
                store.upsertChapter(chapterBinding)
            }
            chapterBinding = bindFetchedLocalChapter(
                database, store, workBinding, chapterBinding, record.long("readAtMs") ?: now(record),
            )
            applyComicProgress(
                database = database,
                comicId = portableWorkId,
                chapterEntityId = portableChapterId,
                localChapterId = chapterBinding.localReference?.toLongOrNull(),
                record = record,
                serverRevision = recordKey.serverVersion,
                updatedAt = record.long("readAtMs") ?: now(record),
            )
            return
        }
        // The server-scoped identity may not exist yet: the Core catalog sync that materializes
        // the local manga runs after the replica apply, so progress is keyed by the work id with
        // a fallback identity until the entry projection binds a real local manga id.
        val chapterEntityId = record.string("chapterId")
        val binding = chapterEntityId?.let {
            database.aethon_syncQueries.selectChapterBindingByEntityId(it).executeAsOneOrNull()
        }
        applyComicProgress(
            database = database,
            comicId = comicId,
            chapterEntityId = binding?.chapter_entity_id,
            localChapterId = binding?.local_chapter_id,
            record = record,
            serverRevision = recordKey.serverVersion,
            updatedAt = record.long("readAtMs") ?: now(record),
        )
    }

    private fun applyComicProgress(
        database: Database,
        comicId: String,
        chapterEntityId: String?,
        localChapterId: Long?,
        record: JsonObject,
        serverRevision: Long,
        updatedAt: Long,
    ) {
        // Reader progress is keyed by the work identity. Ensure the identity row exists even for
        // pending portable works that have no local manga yet: local_reference falls back to the
        // portable id until an entry projection or hydration binds a real local manga id.
        val identity = database.aethon_syncQueries.selectIdentityByEntityId(comicId).executeAsOneOrNull()
        val localManga = identity?.local_reference?.toLongOrNull()?.takeIf { it > 0 }
            ?: localMangaId(database, comicId)
        database.aethon_syncQueries.upsertIdentity(
            entityId = comicId,
            contentType = "MANGA",
            localReference = localManga?.toString() ?: comicId,
            createdAt = identity?.created_at ?: updatedAt,
            updatedAt = updatedAt,
        )
        // chapter_entity_id must reference an existing chapter binding; pending portable chapters
        // have none, so the progress row stays keyed by the work until the chapter binds locally.
        val resolvedChapterEntityId = chapterEntityId?.let {
            database.aethon_syncQueries.selectChapterBindingByEntityId(it).executeAsOneOrNull()?.chapter_entity_id
        }
        val previousProgression = database.aethon_syncQueries
            .selectReaderProgress(comicId)
            .executeAsOneOrNull()
            ?.progression
        val progression = (
            record.double("progressPercent")
                ?: record.double("progress")
                ?: previousProgression
                ?: 0.0
            )
            .coerceIn(0.0, 1.0)
        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = comicId,
            chapterEntityId = resolvedChapterEntityId,
            locatorJson = CoreReplicaPayloadHasher.canonicalJson(record),
            chapterOrdinal = record.double("chapterNumber") ?: record.double("chapterOrderKey"),
            progression = progression,
            serverRevision = serverRevision,
            updatedAt = updatedAt,
        )

        localChapterId?.let { chapterId ->
            val pageIndex = record.long("pageIndex") ?: record.long("lastPageRead")
            val pageCount = record.long("pageCount")
            val lastPageRead = pageIndex ?: if (pageCount != null) {
                (progression * pageCount).toLong().coerceAtMost(pageCount)
            } else {
                null
            }
            val pagesLeft = pageCount?.let { count ->
                (count - (lastPageRead ?: 0L)).coerceAtLeast(0L)
            }
            // Page indexes count from zero: reaching the last page finishes the chapter, as in the
            // reader and in Suwayomi. History alone never marks a finished chapter unread again.
            val finished = progression >= 1.0 ||
                (pageIndex != null && pageCount != null && pageCount > 0 && pageIndex >= pageCount - 1)
            val read = record.boolean("read") ?: true.takeIf { finished }
            val bookmark = record.boolean("bookmark") ?: record.boolean("bookmarked")
            database.chaptersQueries.update(
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

    private fun ensureChapterBinding(
        database: Database,
        chapterEntityId: String,
        workEntityId: String,
        mangaId: Long,
        localUrl: String,
        normalizedUrl: String,
        title: String,
        ordinal: Double,
        scanlator: String?,
        dateFetch: Long,
        dateUpload: Long,
    ): Long {
        val existing = database.aethon_syncQueries
            .selectChapterBindingByEntityId(chapterEntityId)
            .executeAsOneOrNull()
        val localChapterId = existing?.local_chapter_id
            ?: database.aethon_syncQueries
                .selectChapterBindingByWorkAndUrl(workEntityId, normalizedUrl)
                .executeAsOneOrNull()
                ?.local_chapter_id
            ?: run {
                database.chaptersQueries.insert(
                    mangaId = mangaId,
                    url = localUrl,
                    name = title,
                    scanlator = scanlator,
                    read = false,
                    bookmark = false,
                    lastPageRead = 0,
                    pagesLeft = 0,
                    chapterNumber = ordinal,
                    sourceOrder = 0,
                    dateFetch = dateFetch,
                    dateUpload = dateUpload,
                    memo = JsonObject(emptyMap()),
                )
                database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
            }
        database.chaptersQueries.update(
            chapterId = localChapterId,
            mangaId = mangaId,
            url = localUrl,
            name = title,
            scanlator = scanlator,
            read = null,
            bookmark = null,
            lastPageRead = null,
            pagesLeft = null,
            chapterNumber = ordinal,
            sourceOrder = null,
            dateFetch = dateFetch,
            dateUpload = dateUpload,
            memo = null,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = chapterEntityId,
            workEntityId = workEntityId,
            localChapterId = localChapterId,
            normalizedUrl = normalizedUrl,
            ordinal = ordinal,
            updatedAt = dateFetch,
        )
        return localChapterId
    }

    private fun verifiedCoreMangaReference(
        entityId: String,
        record: JsonObject,
    ): SuwayomiCoreContentReference.Manga? {
        val reference = parseCoreMangaEntityId(entityId) ?: return null
        val payloadId = record.long("suwayomiMangaId")?.takeIf { it > 0 } ?: return null
        val comicId = record.string("comicId") ?: return null
        val recordServerId = record.string("coreServerId")
        val recordProfileId = record.string("coreProfileId")
        val verified = reference.takeIf {
            it.mangaId == payloadId &&
                comicId == entityId &&
                (it.serverId == null || it.serverId == recordServerId) &&
                it.profileId == (recordProfileId ?: it.profileId)
        } ?: return null
        return if (
            verified.serverId == null &&
            !recordServerId.isNullOrBlank() &&
            recordServerId != LEGACY_UNBOUND_SERVER_ID
        ) {
            SuwayomiCoreContentReference.Manga(recordServerId, verified.profileId, verified.mangaId)
        } else {
            verified
        }
    }

    private fun verifiedProjectedCoreManga(
        database: Database,
        entityId: String,
    ): SuwayomiCoreContentReference.Manga? {
        val reference = parseCoreMangaEntityId(entityId) ?: return null
        val localId = localMangaId(database, entityId) ?: return null
        val manga = database.mangasQueries.findById(localId).executeAsOneOrNull() ?: return null
        return reference.takeIf { manga.source == EpigraphCoreSource.ID }
    }

    private fun parseCoreMangaEntityId(entityId: String): SuwayomiCoreContentReference.Manga? {
        val marker = ":manga:"
        val markerIndex = entityId.lastIndexOf(marker)
        if (markerIndex < 0) return null
        val mangaId = entityId.substring(markerIndex + marker.length).toLongOrNull()?.takeIf { it > 0 }
            ?: return null
        val serverPrefix = "suwayomi:server:"
        val profileMarker = ":profile:"
        if (entityId.startsWith(serverPrefix)) {
            val profileMarkerIndex = entityId.indexOf(profileMarker, serverPrefix.length)
            if (profileMarkerIndex <= serverPrefix.length || profileMarkerIndex >= markerIndex) return null
            val serverId = entityId.substring(serverPrefix.length, profileMarkerIndex)
            val profileId = entityId.substring(profileMarkerIndex + profileMarker.length, markerIndex)
            if (serverId.isBlank() || profileId.isBlank()) return null
            return SuwayomiCoreContentReference.Manga(serverId, profileId, mangaId)
        }
        val legacyPrefix = "suwayomi:profile:"
        if (!entityId.startsWith(legacyPrefix) || markerIndex <= legacyPrefix.length) return null
        val profileId = entityId.substring(legacyPrefix.length, markerIndex)
        if (profileId.isBlank()) return null
        return SuwayomiCoreContentReference.Manga(null, profileId, mangaId)
    }

    private fun preserveOriginalSourceBinding(
        database: Database,
        entityId: String,
        record: JsonObject,
        originalUrl: String,
        coreReference: SuwayomiCoreContentReference.Manga,
    ) {
        val source = record["source"] as? JsonObject
        val sourceId = source?.string("id") ?: record.string("sourceId") ?: return
        if (sourceId.isBlank() || originalUrl.isBlank()) return
        val pluginPackage = source?.string("packageName")
            ?: source?.string("pkgName")
            ?: (source?.get("extension") as? JsonObject)?.string("pkgName")
            ?: record.string("extensionPackageName")
            ?: "unknown"
        val existing = database.aethon_syncQueries.selectBindingsByEntityId(entityId).executeAsList()
        val authority = coreReference.serverId?.let { "$it:${coreReference.profileId}" }
            ?: "legacy:${coreReference.profileId}"
        val digest = MessageDigest.getInstance("SHA-256")
            .digest("$authority\u0000$sourceId\u0000$originalUrl".toByteArray())
            .joinToString("") { byte -> "%02x".format(byte) }
        database.aethon_syncQueries.insertBinding(
            bindingId = "aethon-core:$digest",
            entityId = entityId,
            ecosystem = "SUWAYOMI",
            repository = "aethon-core:$authority",
            pluginPackage = pluginPackage,
            sourceId = sourceId,
            normalizedUrl = originalUrl,
            isPrimary = existing.none { it.is_primary },
            createdAt = now(record),
        )
    }

    private fun projectNovelEntry(database: Database, entityId: String, record: JsonObject) {
        val novelId = record.string("novelId") ?: entityId
        val title = record.string("title")?.takeIf { it.isNotBlank() } ?: return
        val url = record.string("path") ?: record.string("identityKey") ?: novelId
        val source = novelPluginSourceId(record) ?: stableSourceId(record)
        val localId = ensureManga(
            database = database,
            entityId = novelId,
            contentType = "NOVEL",
            source = source,
            url = url,
            title = title,
            author = record.string("author"),
            description = record.string("description"),
            genre = record.strings("tags").joinToString(", ").ifBlank { null },
            thumbnailUrl = record.string("coverUrl"),
            dateAdded = record.long("addedAtMs") ?: now(record),
            lastUpdate = record.long("updatedAtMs") ?: now(record),
        ) ?: return
        database.aethon_syncQueries.upsertIdentity(
            entityId = novelId,
            contentType = "NOVEL",
            localReference = localId.toString(),
            createdAt = now(record),
            updatedAt = now(record),
        )
    }

    private fun projectBookEntry(database: Database, entityId: String, record: JsonObject) {
        val subtype = record.string("subtype")?.lowercase()
        val contentType = if (subtype == "pdf") ContentType.PDF else ContentType.EPUB
        // Desktop Core identifies publications as e.g. `epub:sha256:<hash>`
        // and `pdf:sha256:<hash>`.  Local storage is content-addressed by the
        // raw SHA-256, so normalize both wire forms before looking up or
        // creating the local publication.  Falling back to the entity id also
        // supports older snapshots that omitted assetFingerprint but used the
        // canonical book id.
        val fingerprint = sequenceOf(
            record.string("assetFingerprint"),
            entityId,
        ).mapNotNull(::normalizeBookFingerprint).firstOrNull()
        val identity = database.aethon_syncQueries.selectIdentityByEntityId(entityId).executeAsOneOrNull()
        val existing = fingerprint?.let {
            database.local_booksQueries.findBySha256(it).executeAsOneOrNull()
        }
        val localReference = existing?.book_id ?: identity?.local_reference ?: entityId
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = contentType.name,
            localReference = localReference,
            createdAt = record.long("createdAtMs") ?: now(record),
            updatedAt = record.long("bookUpdatedAtMs") ?: now(record),
        )

        // Old desktop records without an immutable hash remain in the confirmed mirror, but
        // cannot safely become a local publication. A later metadata refresh can materialize it.
        if (fingerprint == null) return
        val root = privateBookStorageDirectory?.absoluteFile
        val privatePath = existing?.private_path ?: root?.let {
            expectedBookPath(it, contentType, fingerprint)
        } ?: return
        val title = record.string("title")?.takeIf(String::isNotBlank) ?: existing?.display_name ?: return
        val updatedAt = record.long("bookUpdatedAtMs") ?: now(record)
        val importedAt = record.long("createdAtMs") ?: existing?.imported_at ?: updatedAt
        val mimeType = record.string("mimeType") ?: existing?.mime_type ?: when (contentType) {
            ContentType.PDF -> "application/pdf"
            else -> "application/epub+zip"
        }
        val byteSize = record.long("byteSize")?.coerceAtLeast(0) ?: existing?.byte_size ?: 0
        // Core records written by older desktop builds may not contain structure counts. Keep a
        // truthful fallback (one publication chapter; PDF page count is refined after download)
        // so the library can still render a chapter badge instead of hiding it.
        val chapterCount = record.long("tocCount")
            ?: record.long("spineCount")
            ?: record.long("sectionCount")
            ?: existing?.chapter_count
            ?: 1L
        val normalizedChapterCount = chapterCount.coerceAtLeast(1L)
        val pageCount = (record.long("pageCount") ?: existing?.page_count)?.takeIf { it > 0 }
        val cover = record.bookCoverDescriptor()
        val clearsCover = record.boolean("hasCover") == false
        val coverPath = when {
            cover == null && !clearsCover -> existing?.cover_path
            cover != null && existing?.cover_asset_sha256 == cover.sha256 &&
                existing.cover_asset_byte_size == cover.byteSize &&
                existing.cover_asset_mime_type == cover.mimeType &&
                existing.cover_path?.let(::File)?.isFile == true -> existing.cover_path
            else -> null
        }
        val coverSha256 = cover?.sha256 ?: existing?.cover_asset_sha256?.takeUnless { clearsCover }
        val coverByteSize = cover?.byteSize ?: existing?.cover_asset_byte_size?.takeUnless { clearsCover }
        val coverMimeType = cover?.mimeType ?: existing?.cover_asset_mime_type?.takeUnless { clearsCover }

        if (existing == null) {
            database.local_booksQueries.insert(
                bookId = localReference,
                contentType = contentType.name,
                sha256 = fingerprint,
                displayName = title,
                author = record.string("author"),
                description = record.string("description"),
                coverPath = null,
                coverAssetSha256 = cover?.sha256,
                coverAssetByteSize = cover?.byteSize,
                coverAssetMimeType = cover?.mimeType,
                privatePath = privatePath,
                mimeType = mimeType,
                byteSize = byteSize,
                chapterCount = normalizedChapterCount,
                pageCount = pageCount,
                importedAt = importedAt,
                updatedAt = updatedAt,
            )
        } else {
            database.local_booksQueries.updateMetadata(
                displayName = title,
                author = record.string("author") ?: existing.author,
                description = record.string("description") ?: existing.description,
                coverPath = coverPath,
                updatedAt = updatedAt,
                bookId = existing.book_id,
            )
            database.local_booksQueries.updateCover(
                coverPath = coverPath,
                coverAssetSha256 = coverSha256,
                coverAssetByteSize = coverByteSize,
                coverAssetMimeType = coverMimeType,
                updatedAt = updatedAt,
                bookId = existing.book_id,
            )
            database.local_booksQueries.updateAsset(
                privatePath = privatePath,
                mimeType = mimeType,
                byteSize = byteSize,
                updatedAt = updatedAt,
                bookId = existing.book_id,
            )
            database.local_booksQueries.updateStructure(
                chapterCount = normalizedChapterCount,
                pageCount = pageCount,
                updatedAt = updatedAt,
                bookId = existing.book_id,
            )
        }
        val publicationAvailable = File(privatePath).isFile
        database.aethon_syncQueries.insertAssetManifest(
            sha256 = fingerprint,
            contentType = contentType.name,
            byteSize = byteSize,
            mimeType = mimeType,
            localUri = privatePath.takeIf { publicationAvailable },
            remoteAvailable = true,
            state = if (publicationAvailable) "AVAILABLE" else "PENDING_DOWNLOAD",
            updatedAt = updatedAt,
        )
        database.aethon_syncQueries.linkEntityAsset(
            entityId = entityId,
            sha256 = fingerprint,
            role = "PUBLICATION",
            relativePath = "",
            ordinal = 0,
        )
        if (cover != null || clearsCover) {
            database.aethon_syncQueries.deleteEntityAssetsByRole(entityId, "COVER")
        }
        cover?.let { descriptor ->
            val coverAvailable = coverPath?.let(::File)?.isFile == true
            database.aethon_syncQueries.insertAssetManifest(
                sha256 = descriptor.sha256,
                contentType = "BOOK_COVER",
                byteSize = descriptor.byteSize,
                mimeType = descriptor.mimeType,
                localUri = coverPath.takeIf { coverAvailable },
                remoteAvailable = true,
                state = if (coverAvailable) "AVAILABLE" else "PENDING_DOWNLOAD",
                updatedAt = updatedAt,
            )
            database.aethon_syncQueries.linkEntityAsset(
                entityId = entityId,
                sha256 = descriptor.sha256,
                role = "COVER",
                relativePath = "",
                ordinal = 0,
            )
        }
    }

    private fun normalizeBookFingerprint(value: String?): String? {
        val normalized = value?.trim()?.lowercase()?.removePrefix("sha256:")
            ?: return null
        val raw = normalized.substringAfter(":sha256:", normalized)
        return raw.takeIf(SHA_256::matches)
    }

    /**
     * A novel or book category deleted on another device unbinds its Books & novels folder from that
     * library; the folder goes once no library still binds it (a desktop Books category is deleted
     * from the book and the novel library).
     */
    private fun removeCategoryBinding(database: Database, entityId: String, scope: String) {
        val identity = database.aethon_syncQueries
            .selectCategoryIdentityByEntityIdAndScope(entityId, scope)
            .executeAsOneOrNull()
            ?: return
        database.aethon_syncQueries.deleteCategoryIdentityInScope(entityId, scope)
        val local = identity.local_category_id
        if (database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(local).executeAsList().isEmpty()) {
            database.categoriesQueries.delete(local)
        }
    }

    private fun projectCategory(database: Database, entityId: String, record: JsonObject, scope: String) {
        val name = record.string("name")?.takeIf { it.isNotBlank() } ?: return
        val position = record.long("order")?.coerceAtLeast(0) ?: 0
        val previous = database.aethon_syncQueries
            .selectCategoryIdentityByEntityIdAndScope(entityId, scope)
            .executeAsOneOrNull()
        val localId = ensureCategory(database, entityId, name, scope, position, now(record))
        val shared = database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(localId).executeAsList().size > 1
        if (shared) {
            // A folder shared by several libraries follows one library's category only where that
            // category itself changed. Re-projecting an unchanged record (a snapshot after re-pair,
            // or a joined same-named category) must not undo the name or order another library set.
            if (previous == null) return
            database.categoriesQueries.update(
                id = localId,
                name = name.takeIf { it != previous.name },
                sort = position.takeIf { it != previous.sort_order },
                flags = null,
                mangaOrder = null,
            )
            return
        }
        database.categoriesQueries.update(
            id = localId,
            name = name,
            sort = position,
            flags = null,
            mangaOrder = null,
        )
    }

    private fun projectNovelAssignment(database: Database, record: JsonObject, assigned: Boolean) {
        val novelId = record.string("novelId") ?: return
        val categoryId = record.string("categoryId") ?: return
        val mangaId = localMangaId(database, novelId) ?: return
        // A Books category may still be bound only in the book library; it is the same folder.
        val category = sequenceOf("NOVEL", "BOOK")
            .firstNotNullOfOrNull {
                database.aethon_syncQueries.selectCategoryIdentityByEntityIdAndScope(categoryId, it).executeAsOneOrNull()
            }
            ?: return
        if (assigned) {
            database.aethon_syncQueries.insertMangaCategoryAssignment(mangaId, category.local_category_id)
        } else {
            database.aethon_syncQueries.deleteMangaCategoryAssignment(mangaId, category.local_category_id)
        }
    }

    private fun projectBookCategoryAssignment(database: Database, record: JsonObject, assigned: Boolean) {
        val remoteBookId = record.string("bookId") ?: return
        val localBookId = localBookId(database, remoteBookId) ?: return
        if (database.local_booksQueries.findById(localBookId).executeAsOneOrNull() == null) return
        val carriesCompleteSet = record["categoryIds"] is JsonArray
        val remoteCategoryIds = record.strings("categoryIds").ifEmpty {
            record.string("categoryId")?.let(::listOf).orEmpty()
        }
        val synchronizedCategories = database.aethon_syncQueries
            .selectCategoryIdentitiesByContentScope("BOOK")
            .executeAsList()
        val categoriesByRemoteId = synchronizedCategories.associateBy { it.entity_id }
        val desiredLocalIds = if (assigned) {
            remoteCategoryIds.mapNotNull { categoriesByRemoteId[it]?.local_category_id }.toSet()
        } else {
            emptySet()
        }
        synchronizedCategories.forEach { category ->
            if (category.local_category_id in desiredLocalIds) {
                database.local_booksQueries.insertCategory(localBookId, category.local_category_id)
            } else if (!assigned || carriesCompleteSet || category.entity_id in remoteCategoryIds) {
                database.local_booksQueries.deleteCategory(localBookId, category.local_category_id)
            }
        }
    }

    private fun projectNovelChapter(database: Database, entityId: String, record: JsonObject) {
        val novelId = record.string("novelId") ?: return
        val mangaId = localMangaId(database, novelId) ?: return
        val path = record.string("path") ?: return
        val title = record.string("title")?.takeIf { it.isNotBlank() } ?: path
        val ordinal = record.double("chapterOrderKey") ?: 0.0
        val existing = database.aethon_syncQueries.selectChapterBindingByEntityId(entityId).executeAsOneOrNull()
        val localChapterId = existing?.local_chapter_id ?: database.aethon_syncQueries
            .selectChapterBindingByWorkAndUrl(novelId, path)
            .executeAsOneOrNull()
            ?.local_chapter_id
            ?: run {
                database.chaptersQueries.insert(
                    mangaId = mangaId,
                    url = path,
                    name = title,
                    scanlator = null,
                    read = !(record.boolean("unread") ?: true),
                    bookmark = false,
                    lastPageRead = 0,
                    pagesLeft = 100,
                    chapterNumber = ordinal,
                    sourceOrder = 0,
                    dateFetch = now(record),
                    dateUpload = record.long("releaseTimeMs") ?: 0,
                    memo = JsonObject(emptyMap()),
                )
                database.chaptersQueries.selectLastInsertedRowId().executeAsOne()
            }
        database.chaptersQueries.update(
            chapterId = localChapterId,
            mangaId = mangaId,
            url = path,
            name = title,
            scanlator = null,
            read = record.boolean("unread")?.not(),
            bookmark = null,
            lastPageRead = null,
            pagesLeft = null,
            chapterNumber = ordinal,
            sourceOrder = null,
            dateFetch = null,
            dateUpload = record.long("releaseTimeMs"),
            memo = null,
        )
        database.aethon_syncQueries.upsertChapterBinding(
            chapterEntityId = entityId,
            workEntityId = novelId,
            localChapterId = localChapterId,
            normalizedUrl = path,
            ordinal = ordinal,
            updatedAt = now(record),
        )
    }

    private fun projectNovelProgress(database: Database, recordKey: CoreConfirmedRecord, record: JsonObject) {
        val portableWork = record["portableWorkRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableWorkRef.Novel>(element) }.getOrNull()
        }
        val portableChapter = record["portableChapterRef"]?.let { element ->
            runCatching { json.decodeFromJsonElement<PortableChapterRef.Novel>(element) }.getOrNull()
        }
        val portableStore = SqlDelightPortableBindingStore(database)
        val carriesPortableRefs = record.containsKey("portableWorkRef") || record.containsKey("portableChapterRef")
        val portableWorkId = portableWork?.let(PortableIdentityV3::workId)
        val portableChapterId = portableChapter?.let(PortableIdentityV3::chapterId)
        val validPortableRefs = portableWork != null &&
            portableChapter != null &&
            portableChapter.work == portableWork &&
            portableWorkId == canonicalNovelProgressId(recordKey.key.entityId) &&
            portableChapterId == record.string("chapterId")
        if (carriesPortableRefs && !validPortableRefs) return
        var portableWorkBinding = if (validPortableRefs) portableStore.work(requireNotNull(portableWork)) else null
        if (validPortableRefs && portableWorkBinding == null) {
            portableWorkBinding = PortableWorkBindingRecord(
                portableId = requireNotNull(portableWorkId),
                ref = requireNotNull(portableWork),
                dependencyKey = portableWork.pluginId,
                localReference = null,
                resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = record.long("updatedAtMs") ?: now(record),
            )
            portableStore.upsertWork(portableWorkBinding)
        }
        if (validPortableRefs) {
            markPortableStateMembership(database, recordKey, requireNotNull(portableWorkId))
        }
        val localNovelReference = portableWorkBinding?.localReference
        val localNovelEntityId = localNovelReference?.let { localReference ->
            database.aethon_syncQueries
                .selectIdentityByLocalReference("NOVEL", localReference)
                .executeAsOneOrNull()
                ?.entity_id
        }
        val novelId = if (validPortableRefs) {
            requireNotNull(portableWorkId)
        } else {
            localNovelEntityId ?: record.string("novelId") ?: canonicalNovelProgressId(recordKey.key.entityId)
        }
        val chapterId = record.string("chapterId")
        val binding = chapterId?.takeUnless { validPortableRefs }?.let {
            database.aethon_syncQueries.selectChapterBindingByEntityId(it).executeAsOneOrNull()
        }
        val portableChapterBinding = if (validPortableRefs && portableWorkBinding != null) {
            var existing = portableStore.chapter(requireNotNull(portableChapterId))
            if (existing == null) {
                existing = PortableChapterBindingRecord(
                    portableChapterId = portableChapterId,
                    portableWorkId = requireNotNull(portableWorkId),
                    ref = requireNotNull(portableChapter),
                    localReference = null,
                    resolution = PortableResolution(PortableResolutionState.PENDING_PROVIDER),
                    attemptCount = 0,
                    updatedAt = record.long("updatedAtMs") ?: now(record),
                )
                portableStore.upsertChapter(existing)
            }
            existing
        } else {
            null
        }
        val progression = (record.double("progressPercent") ?: 0.0).coerceIn(0.0, 1.0)
        val locatorPosition = parseNovelLocator(record.string("locator"))
        val typedLocator = ReaderLocator.Novel(
            entityId = EpigraphEntityId(novelId),
            chapterId = record.string("chapterId")
                ?: binding?.chapter_entity_id
                ?: portableChapterId
                ?: return,
            blockIndex = locatorPosition.first,
            textOffset = locatorPosition.second,
            progression = progression,
            chapterOrderKey = record.double("chapterOrderKey"),
            portableWork = portableWork,
            portableChapter = portableChapter,
        )
        val updatedAt = record.long("updatedAtMs") ?: now(record)
        // Reader progress is keyed by the work identity. Progress can outlive its entry (a novel
        // removed on another device keeps its position) and a pending portable novel has no local
        // row yet, so make sure the identity exists; local_reference falls back to the novel id
        // until an entry projection binds a real local manga id.
        if (database.aethon_syncQueries.selectIdentityByEntityId(novelId).executeAsOneOrNull() == null) {
            database.aethon_syncQueries.upsertIdentity(
                entityId = novelId,
                contentType = "NOVEL",
                localReference = novelId,
                createdAt = updatedAt,
                updatedAt = updatedAt,
            )
        }
        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = novelId,
            chapterEntityId = binding?.chapter_entity_id,
            locatorJson = json.encodeToString(ReaderLocator.serializer(), typedLocator),
            chapterOrdinal = record.double("chapterOrderKey"),
            progression = progression,
            serverRevision = recordKey.serverVersion,
            updatedAt = updatedAt,
        )
        val localChapterId = binding?.local_chapter_id ?: portableChapterBinding?.localReference?.toLongOrNull()
        localChapterId?.let { chapterLocalId ->
            val lastPage = (progression * 100.0).toInt().coerceIn(0, 100)
            database.chaptersQueries.update(
                chapterId = chapterLocalId,
                mangaId = null,
                url = null,
                name = null,
                scanlator = null,
                // Read/unread is authoritative in novel.chapter; progress never infers it.
                read = null,
                bookmark = null,
                lastPageRead = lastPage.toLong(),
                pagesLeft = (100 - lastPage).toLong(),
                chapterNumber = null,
                sourceOrder = null,
                dateFetch = null,
                dateUpload = null,
                memo = null,
            )
        }
    }

    private fun projectNovelBookmark(database: Database, record: JsonObject, bookmarked: Boolean) {
        val novelId = record.string("novelId") ?: return
        val chapterId = record.string("chapterId") ?: return
        val legacyBinding = database.aethon_syncQueries
            .selectChapterBindingByEntityId(chapterId)
            .executeAsOneOrNull()
            ?.takeIf { it.work_entity_id == novelId }
        val portableBinding = SqlDelightPortableBindingStore(database).chapter(chapterId)
            ?.takeIf { it.portableWorkId == novelId }
        val localChapterId = legacyBinding?.local_chapter_id
            ?: portableBinding?.localReference?.toLongOrNull()
            ?: return
        if (database.chaptersQueries.getChaptersById(localChapterId).executeAsOneOrNull() == null) return
        database.chaptersQueries.update(
            chapterId = localChapterId,
            mangaId = null,
            url = null,
            name = null,
            scanlator = null,
            read = null,
            bookmark = bookmarked,
            lastPageRead = null,
            pagesLeft = null,
            chapterNumber = null,
            sourceOrder = null,
            dateFetch = null,
            dateUpload = null,
            memo = null,
        )
    }

    private fun parseNovelLocator(locator: String?): Pair<Int, Int> {
        val parts = locator?.split(':').orEmpty()
        if (parts.size != 3 || parts[0] != "block") return 0 to 0
        return (parts[1].toIntOrNull()?.coerceAtLeast(0) ?: 0) to
            (parts[2].toIntOrNull()?.coerceAtLeast(0) ?: 0)
    }

    private fun canonicalNovelProgressId(entityId: String): String =
        entityId.removePrefix("novel.progress::")

    private fun projectBookProgress(database: Database, recordKey: CoreConfirmedRecord, record: JsonObject) {
        val remoteBookId = record.string("bookId")
            ?: recordKey.key.entityId.removePrefix("book.progress::")
        val localBookId = localBookId(database, remoteBookId) ?: return
        val book = database.local_booksQueries.findById(localBookId).executeAsOneOrNull() ?: return
        val contentType = if (record.string("renderer")?.equals("pdf", true) == true) ContentType.PDF else ContentType.EPUB
        val progression = (record.double("progressPercent") ?: 0.0).coerceIn(0.0, 1.0)
        // A malformed position is skipped like other unusable records instead of failing the
        // whole snapshot, which would stop every other book from syncing.
        val locator = runCatching {
            when (contentType) {
                ContentType.PDF -> {
                    val totalPages = record.long("totalPages")?.takeIf { it in 1..Int.MAX_VALUE }?.toInt()
                    ReaderLocator.Pdf(
                        entityId = EpigraphEntityId(localBookId),
                        pageIndex = record.pdfPageIndex(totalPages),
                        totalPages = totalPages,
                        documentProgression = progression,
                    )
                }
                else -> ReaderLocator.Epub(
                    entityId = EpigraphEntityId(localBookId),
                    cfi = record.bookLocation(),
                    progression = progression,
                )
            }
        }.getOrNull() ?: return
        database.aethon_syncQueries.upsertIdentity(
            entityId = remoteBookId,
            contentType = contentType.name,
            localReference = localBookId,
            createdAt = now(record),
            updatedAt = record.long("lastReadAtMs") ?: now(record),
        )
        database.local_booksQueries.upsertConfirmedProgress(
            bookId = book.book_id,
            locatorJson = json.encodeToString(ReaderLocator.serializer(), locator),
            progression = progression,
            updatedAt = record.long("lastReadAtMs") ?: now(record),
        )
        database.aethon_syncQueries.upsertRemoteReaderProgress(
            entityId = remoteBookId,
            chapterEntityId = null,
            locatorJson = CoreReplicaPayloadHasher.canonicalJson(record),
            chapterOrdinal = null,
            progression = progression,
            serverRevision = recordKey.serverVersion,
            updatedAt = record.long("lastReadAtMs") ?: now(record),
        )
    }

    private fun projectBookBookmark(database: Database, entityId: String, record: JsonObject) {
        val remoteBookId = record.string("bookId") ?: return
        val localBookId = localBookId(database, remoteBookId) ?: return
        val book = database.local_booksQueries.findById(localBookId).executeAsOneOrNull() ?: return
        val progression = (record.double("progressPercent") ?: 0.0).coerceIn(0.0, 1.0)
        val locator = runCatching {
            if (book.content_type == ContentType.PDF.name) {
                ReaderLocator.Pdf(
                    entityId = EpigraphEntityId(localBookId),
                    pageIndex = record.pdfPageIndex(book.page_count?.takeIf { it in 1..Int.MAX_VALUE }?.toInt()),
                    documentProgression = progression,
                )
            } else {
                ReaderLocator.Epub(
                    entityId = EpigraphEntityId(localBookId),
                    cfi = record.bookLocation(),
                    progression = progression,
                )
            }
        }.getOrNull() ?: return
        val savedAt = record.long("savedAtMs") ?: now(record)
        database.local_booksQueries.upsertBookmark(
            bookmarkId = entityId,
            bookId = localBookId,
            locatorJson = json.encodeToString(ReaderLocator.serializer(), locator),
            label = record.string("label"),
            note = record.string("note"),
            createdAt = record.long("createdAtMs") ?: savedAt,
            updatedAt = record.long("updatedAtMs") ?: savedAt,
        )
    }

    private fun projectBookHighlight(database: Database, entityId: String, record: JsonObject) {
        val remoteBookId = record.string("bookId") ?: return
        val localBookId = localBookId(database, remoteBookId) ?: return
        if (database.local_booksQueries.findById(localBookId).executeAsOneOrNull() == null) return
        val start = record["startLocatorJson"]?.let { locator ->
            runCatching { json.decodeFromJsonElement(ReaderLocator.serializer(), locator) }.getOrNull()
        }?.forBook(localBookId) ?: return
        val end = record["endLocatorJson"]?.let { locator ->
            runCatching { json.decodeFromJsonElement(ReaderLocator.serializer(), locator) }.getOrNull()
        }?.forBook(localBookId) ?: return
        if (start.contentType != end.contentType) return
        val selectedText = record.string("selectedText") ?: return
        val createdAt = record.long("createdAtMs") ?: now(record)
        database.local_booksQueries.upsertHighlight(
            highlightId = entityId,
            bookId = localBookId,
            startLocatorJson = json.encodeToString(ReaderLocator.serializer(), start),
            endLocatorJson = json.encodeToString(ReaderLocator.serializer(), end),
            selectedText = selectedText,
            colorArgb = record.long("colorArgb") ?: 0,
            note = record.string("note"),
            createdAt = createdAt,
            updatedAt = record.long("updatedAtMs") ?: createdAt,
        )
    }

    /**
     * Core `book.*` records carry the 1-based PDF page number that Epigraph desktop reads and
     * writes; the Android reader counts from zero. Clamp to the last page when the count is known.
     */
    private fun JsonObject.pdfPageIndex(totalPages: Int?): Int {
        val index = ((long("pageIndex") ?: 1L) - 1L).coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
        return totalPages?.let { index.coerceAtMost(it - 1) } ?: index
    }

    private fun JsonObject.bookLocation(): String? =
        sequenceOf(string("location"), string("href")).firstOrNull { !it.isNullOrBlank() }

    private fun ReaderLocator.forBook(bookId: String): ReaderLocator = when (this) {
        is ReaderLocator.Epub -> copy(entityId = EpigraphEntityId(bookId))
        is ReaderLocator.Pdf -> copy(entityId = EpigraphEntityId(bookId))
        else -> this
    }

    private fun removeBookProgress(database: Database, entityId: String) {
        val remoteBookId = entityId.removePrefix("book.progress::")
        localBookId(database, remoteBookId)?.let(database.local_booksQueries::deleteProgress)
        database.aethon_syncQueries.deleteReaderProgress(remoteBookId)
    }

    private fun removeBookEntry(database: Database, entityId: String) {
        val localBookId = localBookId(database, entityId) ?: return
        // The database membership is removed, but immutable bytes are retained for later GC.
        database.local_booksQueries.deleteById(localBookId)
    }

    private fun localBookId(database: Database, entityId: String): String? =
        database.aethon_syncQueries.selectIdentityByEntityId(entityId).executeAsOneOrNull()?.local_reference

    private fun Database.hasPendingLocalMutation(key: CoreReplicaKey): Boolean {
        val canonicalEntityId = when (key.entityType) {
            "book.progress" -> key.entityId.removePrefix("book.progress::")
            else -> key.entityId
        }
        return aethon_syncQueries.hasPendingMutationForEntity(
            scopeId = key.scopeId,
            entityType = key.entityType,
            entityId = canonicalEntityId,
        ).executeAsOne() || (
            canonicalEntityId != key.entityId &&
                aethon_syncQueries.hasPendingMutationForEntity(
                    scopeId = key.scopeId,
                    entityType = key.entityType,
                    entityId = key.entityId,
                ).executeAsOne()
            )
    }

    private fun Database.hasBlockingLocalMutation(key: CoreReplicaKey, observedServerVersion: Long): Boolean {
        val canonicalEntityId = when (key.entityType) {
            "book.progress" -> key.entityId.removePrefix("book.progress::")
            else -> key.entityId
        }
        return aethon_syncQueries.hasBlockingMutationForObservedVersion(
            scopeId = key.scopeId,
            entityType = key.entityType,
            entityId = canonicalEntityId,
            observedServerVersion = observedServerVersion,
        ).executeAsOne() || (
            canonicalEntityId != key.entityId &&
                aethon_syncQueries.hasBlockingMutationForObservedVersion(
                    scopeId = key.scopeId,
                    entityType = key.entityType,
                    entityId = key.entityId,
                    observedServerVersion = observedServerVersion,
                ).executeAsOne()
            )
    }

    private fun Database.hasBlockingBookMutationTree(
        entryKey: CoreReplicaKey,
        observedServerVersion: Long,
    ): Boolean {
        val bookId = entryKey.entityId
        val localId = localBookId(this, bookId) ?: bookId
        val keys = buildList {
            add(entryKey)
            add(CoreReplicaKey(entryKey.scopeId, "book.progress", bookId))
            add(CoreReplicaKey(entryKey.scopeId, "book.progress", "book.progress::$bookId"))
            add(CoreReplicaKey(entryKey.scopeId, "book.category_assignment", bookId))
            local_booksQueries.findBookmarks(localId).executeAsList().forEach { bookmark ->
                add(CoreReplicaKey(entryKey.scopeId, "book.bookmark", bookmark.bookmark_id))
            }
            local_booksQueries.findHighlights(localId).executeAsList().forEach { highlight ->
                add(CoreReplicaKey(entryKey.scopeId, "book.highlight", highlight.highlight_id))
            }
        }
        return keys.any { key -> hasBlockingLocalMutation(key, observedServerVersion) }
    }

    private fun String.isBookEntityType(): Boolean = startsWith("book.")

    private fun expectedBookPath(root: File, contentType: ContentType, sha256: String): String {
        val extension = if (contentType == ContentType.PDF) "pdf" else "epub"
        return File(File(root, extension), "$sha256.$extension").absolutePath
    }

    private fun ensureManga(
        database: Database,
        entityId: String,
        contentType: String,
        source: Long,
        url: String,
        title: String,
        author: String?,
        description: String?,
        genre: String?,
        thumbnailUrl: String?,
        dateAdded: Long,
        lastUpdate: Long,
        initialized: Boolean = true,
        preferredLocalId: Long? = null,
    ): Long? {
        val identity = database.aethon_syncQueries.selectIdentityByEntityId(entityId).executeAsOneOrNull()
        val existingId = identity?.local_reference?.toLongOrNull()?.takeIf { it > 0 }
        val localId = preferredLocalId
            ?: existingId
            ?: database.mangasQueries.findByUrlAndSource(url, source).executeAsOneOrNull()?.let { it._id }
        var resolvedId = localId ?: run {
            database.mangasQueries.insert(
                source = source,
                url = url,
                artist = null,
                author = author,
                description = description,
                genre = genre,
                title = title,
                status = 0,
                thumbnailUrl = thumbnailUrl,
                favorite = true,
                lastUpdate = lastUpdate,
                initialized = initialized,
                viewer = 0,
                hideTitle = false,
                chapterFlags = 0,
                dateAdded = dateAdded,
                filteredScanlators = null,
                memo = JsonObject(emptyMap()),
                updateStrategy = 0,
                coverLastModified = lastUpdate,
                nextUpdate = 0,
                fetchInterval = 0,
            )
            database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        }
        val resolvedOwner = database.aethon_syncQueries.selectIdentityByLocalReference(
            contentType = contentType,
            localReference = resolvedId.toString(),
        ).executeAsOneOrNull()
        if (resolvedOwner != null && resolvedOwner.entity_id != entityId) {
            val identityOwnedId = existingId?.takeIf { candidateId ->
                database.mangasQueries.findById(candidateId).executeAsOneOrNull() != null &&
                    database.aethon_syncQueries.selectIdentityByLocalReference(
                        contentType = contentType,
                        localReference = candidateId.toString(),
                    ).executeAsOneOrNull()?.entity_id == entityId
            }
            if (identityOwnedId == null) {
                if (BuildConfig.DEBUG) {
                    runCatching {
                        Log.w(
                            "EpigraphCoreSync",
                            "catalog identity ownership conflict: entity=$entityId owner=${resolvedOwner.entity_id}",
                        )
                    }
                }
                return null
            }
            resolvedId = identityOwnedId
        }
        if (contentType == "NOVEL") {
            resolvedId = adoptNovelTwin(database, resolvedId, url, source)
        }
        database.mangasQueries.update(
            source = source,
            url = url,
            artist = null,
            author = author,
            description = description,
            genre = genre,
            title = title,
            status = null,
            thumbnailUrl = thumbnailUrl,
            favorite = true,
            lastUpdate = lastUpdate,
            initialized = initialized,
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
            mangaId = resolvedId,
        )
        database.aethon_syncQueries.upsertIdentity(
            entityId = entityId,
            contentType = contentType,
            localReference = resolvedId.toString(),
            createdAt = dateAdded,
            updatedAt = lastUpdate,
        )
        return resolvedId
    }

    /**
     * Re-keying a placeholder to the installed plugin's source id must not leave it next to the row
     * LNReader hydration already created for the same novel: move the identity onto that row and
     * hide the placeholder as a replica repair, never as a user-authored removal.
     */
    private fun adoptNovelTwin(database: Database, localId: Long, url: String, source: Long): Long {
        val current = database.mangasQueries.findById(localId).executeAsOneOrNull() ?: return localId
        if (current.url == url && current.source == source) return localId
        val twin = database.mangasQueries.findByUrlAndSource(url, source).executeAsList().firstOrNull { row ->
            row._id != localId &&
                database.aethon_syncQueries.selectIdentityByLocalReference("NOVEL", row._id.toString())
                    .executeAsOneOrNull() == null
        } ?: return localId
        val assigned = database.categoriesQueries.findAllByMangaId(twin._id).executeAsList().mapTo(HashSet()) { it._id }
        database.categoriesQueries.findAllByMangaId(localId).executeAsList().forEach { category ->
            if (category._id !in assigned) database.mangas_categoriesQueries.insert(twin._id, category._id)
        }
        database.mangasQueries.update(
            source = null, url = null, artist = null, author = null, description = null, genre = null,
            title = null, status = null, thumbnailUrl = null, favorite = false, lastUpdate = null,
            initialized = null, viewer = null, hideTitle = null, chapterFlags = null, dateAdded = null,
            filteredScanlators = null, updateStrategy = null, coverLastModified = null, nextUpdate = null,
            fetchInterval = null, memo = null, mangaId = localId,
        )
        return twin._id
    }

    private fun ensureCategory(
        database: Database,
        entityId: String,
        name: String,
        scope: String,
        position: Long,
        updatedAt: Long,
    ): Long {
        val existing = database.aethon_syncQueries
            .selectCategoryIdentityByEntityIdAndScope(entityId, scope)
            .executeAsOneOrNull()
        // The desktop publishes one Books category to the book and the novel library under one id:
        // the second library binds the Books & novels folder the first one already chose.
        val sibling = when (scope) {
            "NOVEL" -> "BOOK"
            "BOOK" -> "NOVEL"
            else -> null
        }?.let { other ->
            database.aethon_syncQueries.selectCategoryIdentityByEntityIdAndScope(entityId, other).executeAsOneOrNull()
        }
        val localId = existing?.local_category_id
            ?: sibling?.local_category_id
            ?: joinableFolder(database, entityId, name, scope)
            ?: run {
                database.categoriesQueries.insert(
                    name = name,
                    sort = position,
                    flags = 0,
                    mangaOrder = "a",
                )
                database.categoriesQueries.selectLastInsertedRowId().executeAsOne()
            }
        if (existing == null &&
            database.aethon_syncQueries.selectCategoryIdentityByLocalIdAndScope(localId, scope).executeAsOneOrNull() != null
        ) {
            // The folder already went out to this library under another id (made on the phone before
            // the desktop republished it); keep that binding rather than break the unique folder key.
            return localId
        }
        database.aethon_syncQueries.upsertCategoryScope(localId, scope)
        database.aethon_syncQueries.upsertCategoryIdentity(
            entityId = entityId,
            localCategoryId = localId,
            contentScope = scope,
            name = name,
            sortOrder = position,
            updatedAt = updatedAt,
        )
        return localId
    }

    /**
     * Comics and Books & novels keep separate folder lists on both devices, so a comic category only
     * joins a Comics folder and a novel or book category only a Books & novels folder of the same
     * name (novels and books share that list). Nothing is merged where it could lose an assignment:
     * - a folder that already holds comics or books of [scope] without being bound in [scope] keeps
     *   them local (comics are bound by [epigraph.sync.core.suwayomi.SuwayomiCategoryCreateHook],
     *   books on their next edit);
     * - a folder bound in [scope] is only taken over when that binding is left over from an earlier
     *   pairing: a novel or book category neither in the confirmed replica nor queued, or a comic
     *   category of another server on a folder without comics (with comics, the folder is bound
     *   by name through the create hook, which also publishes its assignments).
     */
    private fun joinableFolder(database: Database, entityId: String, name: String, scope: String): Long? {
        val entityType = when (scope) {
            "MANGA" -> "comic.category"
            "NOVEL" -> "novel.category"
            "BOOK" -> "book.category"
            else -> return null
        }
        val wanted = name.trim()
        val folders = if (scope == "MANGA") {
            database.categoriesQueries.findAllComics().executeAsList()
        } else {
            database.categoriesQueries.findAllBooks().executeAsList()
        }.filter { it._id > 0 }
        val candidates = folders.filter { it.name.trim() == wanted } +
            folders.filter { it.name.trim() != wanted && it.name.trim().equals(wanted, ignoreCase = true) }
        for (folder in candidates) {
            val bound = database.aethon_syncQueries
                .selectCategoryIdentityByLocalIdAndScope(folder._id, scope)
                .executeAsOneOrNull()
            if (bound == null) {
                val holdsUnpublished = when (scope) {
                    "MANGA" -> database.aethon_syncQueries.folderHoldsComics(folder._id).executeAsOne()
                    "BOOK" -> database.aethon_syncQueries.folderHoldsBooks(folder._id).executeAsOne()
                    else -> false
                }
                if (holdsUnpublished) continue
                return folder._id
            }
            val stale = if (scope == "MANGA") {
                val boundServer = suwayomiServerOf(bound.entity_id)
                boundServer != null &&
                    boundServer != suwayomiServerOf(entityId) &&
                    !database.aethon_syncQueries.folderHoldsComics(folder._id).executeAsOne()
            } else {
                !database.aethon_syncQueries.isCategoryEntityLive(entityType, bound.entity_id).executeAsOne()
            }
            if (stale) {
                database.aethon_syncQueries.deleteCategoryIdentityInScope(bound.entity_id, scope)
                return folder._id
            }
        }
        return null
    }

    private fun suwayomiServerOf(entityId: String): String? =
        entityId.takeIf { it.startsWith("suwayomi:server:") }
            ?.removePrefix("suwayomi:server:")
            ?.substringBefore(":profile:")

    private fun localMangaId(database: Database, entityId: String): Long? =
        database.aethon_syncQueries.selectIdentityByEntityId(entityId).executeAsOneOrNull()
            ?.local_reference?.toLongOrNull()?.takeIf { it > 0 }

    private fun demoteEntry(database: Database, entityId: String) {
        val localId = localMangaId(database, entityId) ?: return
        demoteManga(database, localId)
    }

    private fun demoteManga(database: Database, localId: Long) {
        database.mangasQueries.update(
            source = null, url = null, artist = null, author = null, description = null, genre = null,
            title = null, status = null, thumbnailUrl = null, favorite = false, lastUpdate = null,
            initialized = null, viewer = null, hideTitle = null, chapterFlags = null, dateAdded = null,
            filteredScanlators = null, updateStrategy = null, coverLastModified = null, nextUpdate = null,
            fetchInterval = null, memo = null, mangaId = localId,
        )
    }

    private fun portableComicReference(record: JsonObject): PortableWorkRef.Comic? {
        record["portableWorkRef"]?.let { element ->
            return runCatching { json.decodeFromJsonElement<PortableWorkRef.Comic>(element) }.getOrNull()
        }
        val source = record["source"] as? JsonObject
        val sourceId = source?.string("id") ?: record.string("sourceId") ?: return null
        val providerKey = record.string("providerKey") ?: return null
        return runCatching {
            PortableWorkRef.Comic(DecimalSourceId(sourceId), ProviderOwnedKey(providerKey))
        }.getOrNull()
    }

    private fun portableComicLocalMangaId(
        database: Database,
        comicId: String,
        record: JsonObject,
    ): Long? {
        val ref = portableComicReference(record) ?: return null
        if (PortableIdentityV3.workId(ref) != comicId) return null
        val binding = SqlDelightPortableBindingStore(database).work(ref)
            ?.takeIf { it.resolution.state == PortableResolutionState.BOUND }
            ?: return null
        val localId = binding.localReference?.toLongOrNull()?.takeIf { it > 0 } ?: return null
        return database.mangasQueries.findById(localId).executeAsOneOrNull()
            ?.takeIf { manga -> manga.source == ref.sourceId.toLong() && manga.url == ref.mangaKey.value }
            ?._id
    }

    private fun markPortableStateMembership(
        database: Database,
        record: CoreConfirmedRecord,
        portableId: String,
    ) {
        val serverId = record.originServerId ?: return
        val profileId = record.key.scopeId.substringAfter(":profile:", "")
            .substringBefore(':')
            .takeIf { it.isNotBlank() }
            ?: return
        SqlDelightPortableBindingStore(database).markManifestMembership(
            serverId = serverId,
            profileId = profileId,
            portableId = portableId,
            observedAt = record.serverVersion,
        )
    }

    // The id the installed LNReader plugin gets here, so the synced novel opens with it.
    private fun novelPluginSourceId(record: JsonObject): Long? {
        val source = record["source"] as? JsonObject ?: return null
        val pluginId = source.string("pluginId")?.takeIf { it.isNotBlank() } ?: return null
        val lang = source.string("lang")?.takeIf { it.isNotBlank() } ?: return null
        // LNReader names the language ("Português"); an ISO code is already what plugins use.
        val code = lang.takeIf { it.length <= 3 && it.all(Char::isLowerCase) }
            ?: NovelPluginManager.langFromLnReaderLang(lang)
        return NovelSource.sourceIdFor(pluginId, code)
    }

    private fun stableSourceId(record: JsonObject, fallbackSeed: String? = null): Long {
        val source = record["source"] as? JsonObject
        val explicit = source?.let {
            it.string("sourceId") ?: it.string("id") ?: it.string("pluginId")
        } ?: record.string("sourceId")
        explicit?.toLongOrNull()?.takeIf { it > 0 }?.let { return it }
        val seed = explicit
            ?: record.string("identityKey")
            ?: record.string("novelId")
            ?: record.string("comicId")
            ?: fallbackSeed
            ?: "epigraph"
        val digest = MessageDigest.getInstance("SHA-256").digest(seed.toByteArray())
        var value = 0L
        repeat(8) { value = (value shl 8) or (digest[it].toLong() and 0xff) }
        return (value and Long.MAX_VALUE).coerceAtLeast(1)
    }

    private fun now(record: JsonObject): Long =
        record.long("updatedAtMs") ?: record.long("addedAtMs") ?: record.long("lastReadAtMs") ?: 0L

    private fun JsonObject.string(key: String): String? =
        (this[key] as? JsonPrimitive)?.contentOrNull
    private fun JsonObject.long(key: String): Long? = string(key)?.toLongOrNull()
    private fun JsonObject.double(key: String): Double? =
        (this[key] as? JsonPrimitive)?.doubleOrNull
    private fun JsonObject.boolean(key: String): Boolean? =
        (this[key] as? JsonPrimitive)?.booleanOrNull
    private fun JsonObject.strings(key: String): List<String> =
        (this[key] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            .orEmpty()

    private fun JsonObject.bookCoverDescriptor(): BookCoverDescriptor? {
        val sha256 = string("coverAssetSha256")?.lowercase()?.takeIf(SHA_256::matches) ?: return null
        val byteSize = long("coverAssetByteSize")?.takeIf { it in 1..MAX_COVER_ASSET_BYTES } ?: return null
        val mimeType = string("coverAssetMimeType")?.lowercase()?.takeIf(COVER_MIME_TYPES::contains) ?: return null
        return BookCoverDescriptor(sha256, byteSize, mimeType)
    }

    private data class BookCoverDescriptor(
        val sha256: String,
        val byteSize: Long,
        val mimeType: String,
    )

    private companion object {
        val SHA_256 = Regex("[0-9a-f]{64}")
        const val MAX_COVER_ASSET_BYTES = 8L * 1024L * 1024L
        val COVER_MIME_TYPES = setOf("image/jpeg", "image/png", "image/webp")
    }
}
