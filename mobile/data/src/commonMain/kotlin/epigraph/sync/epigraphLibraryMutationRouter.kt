package epigraph.sync

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.CategoryScope
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.NovelEntrySnapshot
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.PortableWorkBindingRecord
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.put

/**
 * Identifies why a local database write is happening. Replay and source refresh writes are applied
 * locally, but must never be reflected back to the Core as new user mutations.
 */
enum class EpigraphMutationOrigin {
    LOCAL_USER,
    LOCAL_IMPORT,
    EXTERNAL_TRACKER,
    EXTERNAL_SOURCE,
    SOURCE_REFRESH,
    REMOTE_EPIGRAPH,
    ;

    val emitsOutbox: Boolean
        get() = this != SOURCE_REFRESH && this != REMOTE_EPIGRAPH
}

fun interface ClientMutationIdFactory {
    fun next(): ClientMutationId
}

data class LibraryMembershipMutation(
    val localMangaId: Long,
    val inLibrary: Boolean,
    val categoryIds: Set<Long>,
    val origin: EpigraphMutationOrigin,
    /**
     * Exact provider identity for a locally discovered work. Core-replicated rows already have
     * side-table identities; LNReader rows created on this device need their portable identity
     * materialized together with the first library mutation.
     */
    val portableWorkRef: PortableWorkRef? = null,
    /**
     * Sends the entry and every requested category assignment even when nothing changed locally.
     * Used when a newly paired or rewound Core does not hold a favorite this device already knows.
     */
    val republish: Boolean = false,
) {
    init {
        require(localMangaId > 0) { "local manga ID must be positive" }
        require(categoryIds.all { it > 0 }) { "local category IDs must be positive" }
        require(!republish || inLibrary) { "only library members can be republished" }
    }
}

data class LibraryMembershipMutationResult(
    val changed: Boolean,
    val membershipChanged: Boolean,
    val addedCategoryIds: Set<Long>,
    val removedCategoryIds: Set<Long>,
    val emittedCommandCount: Int,
)

/**
 * Transaction-safe writer for the first syncable Epigraph domain mutation.
 *
 * This class intentionally bypasses repository methods which catch SQL failures. Existing manga
 * and category IDs are used as-is; Epigraph identities are side-table lookups only.
 */
class EpigraphLibraryMutationRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val scopeId: SyncScopeId,
    private val mutationIds: ClientMutationIdFactory,
    private val comicScopeId: SyncScopeId = scopeId,
    private val scopeProvider: EpigraphSyncScopeProvider = EpigraphSyncScopeProvider {
        EpigraphSyncScopes(scopeId, comicScopeId)
    },
) {
    suspend fun setMembership(
        mutation: LibraryMembershipMutation,
        createdAtEpochMillis: Long,
    ): LibraryMembershipMutationResult {
        val currentScopes = scopeProvider.current()
        return coordinator.mutateLocalBatch(createdAtEpochMillis) {
        val manga = mangasQueries.findById(mutation.localMangaId).executeAsOneOrNull()
            ?: error("manga ${mutation.localMangaId} does not exist")

        // Novel rows live in the legacy `mangas` table too, but their Epigraph identity is typed
        // as NOVEL. Older Epigraph rows are typed as MANGA. Accept both so a library toggle works
        // after a Core bootstrap as well as for a locally imported comic.
        var identity = sequenceOf("NOVEL", "MANGA")
            .mapNotNull { contentType ->
                aethon_syncQueries
                    .selectIdentityByLocalReference(contentType, mutation.localMangaId.toString())
                    .executeAsOneOrNull()
            }
            .firstOrNull()
        val suppliedPortableWork = mutation.portableWorkRef
        val identityProvisioned = identity == null && suppliedPortableWork != null
        if (identityProvisioned) {
            // A work first added on this device: its portable identity is its Epigraph identity.
            val contentType = if (suppliedPortableWork is PortableWorkRef.Novel) "NOVEL" else "MANGA"
            aethon_syncQueries.upsertIdentity(
                entityId = PortableIdentityV3.workId(suppliedPortableWork!!),
                contentType = contentType,
                localReference = mutation.localMangaId.toString(),
                createdAt = createdAtEpochMillis,
                updatedAt = createdAtEpochMillis,
            )
            identity = aethon_syncQueries
                .selectIdentityByLocalReference(contentType, mutation.localMangaId.toString())
                .executeAsOne()
        }
        identity ?: error("manga ${mutation.localMangaId} has no Epigraph identity")
        require(
            suppliedPortableWork == null ||
                suppliedPortableWork is PortableWorkRef.Novel && identity.content_type == "NOVEL" ||
                suppliedPortableWork is PortableWorkRef.Comic && identity.content_type == "MANGA",
        ) { "portable work type does not match local content identity" }
        val workEntityId = EpigraphEntityId(identity.entity_id)
        val isNovel = identity.content_type == "NOVEL"
        val portableStore = SqlDelightPortableBindingStore(this)
        if (suppliedPortableWork != null) {
            val portableId = PortableIdentityV3.workId(suppliedPortableWork)
            portableStore.upsertWork(
                PortableWorkBindingRecord(
                    portableId = portableId,
                    ref = suppliedPortableWork,
                    dependencyKey = (suppliedPortableWork as? PortableWorkRef.Novel)?.pluginId,
                    localReference = mutation.localMangaId.toString(),
                    resolution = PortableResolution(PortableResolutionState.BOUND),
                    titleHint = manga.title.trim().takeIf(String::isNotBlank),
                    providerLabelHint = null,
                    attemptCount = 0,
                    updatedAt = createdAtEpochMillis,
                ),
            )
        }
        val portableWork = portableStore
            .workByLocalReference(mutation.localMangaId.toString())
            ?.takeIf { it.resolution.state.name == "BOUND" }
            ?.ref
        val syncEntityId = portableWork?.let(PortableIdentityV3::workId)?.let(::EpigraphEntityId) ?: workEntityId

        // Legacy Suwayomi comics (no portable binding) also travel through the causal Core path. A
        // canonical Core projects them to Suwayomi; the direct queue below stays for older Cores and
        // is discarded by the drainer once Core projection is active.
        val legacyComicProfile = if (!isNovel && portableWork == null) {
            suwayomiProfileIdForEntity(workEntityId.value)
                ?.takeIf { suwayomiMangaIdForEntity(workEntityId.value) != null }
                ?.takeIf { currentScopes.comics.value == "comics:profile:$it" }
        } else {
            null
        }
        val isLegacySuwayomiCategory: (EpigraphEntityId) -> Boolean = { category ->
            legacyComicProfile != null &&
                suwayomiCategoryIdForEntity(category.value) != null &&
                suwayomiProfileIdForEntity(category.value) == legacyComicProfile
        }

        val requestedCategoryIds = if (mutation.inLibrary) mutation.categoryIds else emptySet()
        val categoryList = categoriesQueries.findAll().executeAsList()
        val availableCategories = categoryList.associateBy { it._id }
        val categoryPositions = if (isNovel) booksAndNovelsPositions(requestedCategoryIds) else categoryList.syncPositions()
        val unknownCategories = requestedCategoryIds - availableCategories.keys
        require(unknownCategories.isEmpty()) {
            "unknown local categories: ${unknownCategories.sorted().joinToString()}"
        }

        val currentCategoryIds = categoriesQueries
            .findAllByMangaId(mutation.localMangaId)
            .executeAsList()
            .mapTo(linkedSetOf()) { it._id }
        val removedCategoryIds = (currentCategoryIds - requestedCategoryIds).toSortedSet()
        val addedCategoryIds = (requestedCategoryIds - currentCategoryIds).toSortedSet()
        val membershipChanged = manga.favorite != mutation.inLibrary
        val publishedCategoryIds = if (mutation.republish) requestedCategoryIds.toSortedSet() else addedCategoryIds

        // A locally-created category may already be assigned before its first Core mutation. Make
        // sure every category that will be sent with an entry has a stable identity, not only
        // categories in the add/remove diff.
        if (isNovel && mutation.origin.emitsOutbox) {
            requestedCategoryIds.forEach { categoryId ->
                if (aethon_syncQueries.selectCategoryIdentityByLocalIdAndScope(categoryId, "NOVEL").executeAsOneOrNull() == null) {
                    val category = availableCategories.getValue(categoryId)
                    val stableId = novelCategoryEntityId(categoryId)
                    aethon_syncQueries.upsertCategoryScope(categoryId, "NOVEL")
                    aethon_syncQueries.upsertCategoryIdentity(
                        entityId = stableId.value,
                        localCategoryId = categoryId,
                        contentScope = "NOVEL",
                        name = category.name,
                        sortOrder = categoryPositions[categoryId] ?: 0L,
                        updatedAt = createdAtEpochMillis,
                    )
                }
            }
        }

        val categoryEntities = if (mutation.origin.emitsOutbox) {
            (removedCategoryIds + publishedCategoryIds).mapNotNull { categoryId ->
                val categoryIdentity = aethon_syncQueries
                    .selectCategoryIdentityByLocalIdAndScope(categoryId, if (isNovel) "NOVEL" else "MANGA")
                    .executeAsOneOrNull()
                if (categoryIdentity != null) {
                    categoryId to EpigraphEntityId(categoryIdentity.entity_id)
                } else if (isNovel) {
                    // Categories created locally before the first Core bootstrap still need a
                    // deterministic identity. Publishing the category merge in the same batch
                    // makes the following assignment lossless and order-independent.
                    val stableId = novelCategoryEntityId(categoryId)
                    val category = availableCategories.getValue(categoryId)
                    aethon_syncQueries.upsertCategoryScope(categoryId, "NOVEL")
                    aethon_syncQueries.upsertCategoryIdentity(
                        entityId = stableId.value,
                        localCategoryId = categoryId,
                        contentScope = "NOVEL",
                        name = category.name,
                        sortOrder = categoryPositions[categoryId] ?: 0L,
                        updatedAt = createdAtEpochMillis,
                    )
                    categoryId to stableId
                } else {
                    // A local-only comics category has no safe Suwayomi ID yet. Keep the local
                    // assignment, but do not invent a remote category identity.
                    null
                }
            }.toMap()
        } else {
            emptyMap()
        }

        val novelCategories = if (isNovel && mutation.origin.emitsOutbox) {
            requestedCategoryIds.sorted().map { categoryId ->
                val category = availableCategories.getValue(categoryId)
                val categoryEntity = aethon_syncQueries
                    .selectCategoryIdentityByLocalIdAndScope(categoryId, "NOVEL")
                    .executeAsOneOrNull()
                    ?: error("category $categoryId has no Epigraph identity")
                SyncCommand.UpsertCategory(
                    entityId = EpigraphEntityId(categoryEntity.entity_id),
                    name = category.name,
                    scope = CategoryScope.NOVEL,
                    position = categoryPositions[categoryId] ?: 0L,
                )
            }
        } else {
            emptyList()
        }

        if (membershipChanged) {
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
                favorite = mutation.inLibrary,
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
                mangaId = mutation.localMangaId,
            )
        }
        removedCategoryIds.forEach { categoryId ->
            aethon_syncQueries.deleteMangaCategoryAssignment(mutation.localMangaId, categoryId)
        }
        addedCategoryIds.forEach { categoryId ->
            aethon_syncQueries.insertMangaCategoryAssignment(mutation.localMangaId, categoryId)
        }

        val commands = if (mutation.origin.emitsOutbox) {
            buildList {
                addAll(novelCategories)
                // The Core rejects deleting an entry while category assignments still point to
                // it. For removals emit assignment tombstones first; for additions create the
                // entry before assignments. This ordering is part of the protocol contract.
                removedCategoryIds.forEach { categoryId ->
                    categoryEntities[categoryId]?.let { category ->
                        if (isNovel || portableWork is PortableWorkRef.Comic || isLegacySuwayomiCategory(category)) {
                            add(SyncCommand.SetCategoryAssignment(syncEntityId, category, false, portableWork))
                        }
                    }
                }
                if (membershipChanged || identityProvisioned || mutation.republish) {
                    if (isNovel) {
                        add(
                            SyncCommand.SetNovelLibraryMembership(
                                entityId = syncEntityId,
                                inLibrary = mutation.inLibrary,
                                entry = if (mutation.inLibrary) {
                                    novelEntrySnapshot(
                                        manga,
                                        syncEntityId,
                                        portableWork as? PortableWorkRef.Novel,
                                        createdAtEpochMillis,
                                    )
                                } else {
                                    null
                                },
                                portableWorkRef = portableWork as? PortableWorkRef.Novel,
                            ),
                        )
                    } else {
                        (portableWork as? PortableWorkRef.Comic)?.let { comicWork ->
                            add(
                                SyncCommand.SetLibraryMembership(
                                    syncEntityId,
                                    mutation.inLibrary,
                                    comicWork,
                                    titleHint = manga.title.trim()
                                        .takeIf { mutation.inLibrary && it.isNotBlank() }
                                        ?.take(MAX_TITLE_HINT_LENGTH),
                                ),
                            )
                        }
                        if (portableWork == null && legacyComicProfile != null) {
                            add(SyncCommand.SetLibraryMembership(syncEntityId, mutation.inLibrary, null))
                        }
                    }
                }
                publishedCategoryIds.forEach { categoryId ->
                    categoryEntities[categoryId]?.let { category ->
                        if (isNovel || portableWork is PortableWorkRef.Comic || isLegacySuwayomiCategory(category)) {
                            add(SyncCommand.SetCategoryAssignment(syncEntityId, category, true, portableWork))
                        }
                    }
                }
            }
        } else {
            emptyList()
        }
        val envelopes = commands.map { command ->
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = if (isNovel) currentScopes.novels else currentScopes.comics,
                entityType = when (command) {
                    is SyncCommand.SetLibraryMembership -> COMIC_ENTRY
                    is SyncCommand.SetNovelLibraryMembership -> NOVEL_ENTRY
                    is SyncCommand.UpsertCategory ->
                        if (command.scope == CategoryScope.NOVEL) NOVEL_CATEGORY else COMIC_CATEGORY
                    is SyncCommand.SetCategoryAssignment ->
                        if (isNovel) NOVEL_CATEGORY_ASSIGNMENT else COMIC_CATEGORY_ASSIGNMENT
                    else -> error("unsupported library command ${command::class.simpleName}")
                },
                command = command,
            )
        }

        // V3 portable mutations are projected by Core only after its causal decision. Keep the
        // direct proxy queue solely for Legacy rows which have no portable binding yet.
        val suwayomiMutations = if (!isNovel && mutation.origin.emitsOutbox && portableWork == null) {
            val profileId = suwayomiProfileIdForEntity(workEntityId.value)
            val remoteMangaId = suwayomiMangaIdForEntity(workEntityId.value)
            if (profileId != null && remoteMangaId != null) {
                buildList<SuwayomiMutationIntent> {
                    if (membershipChanged) {
                        add(
                            SuwayomiMutationIntent(
                                operationId = mutationIds.next().value,
                                profileId = profileId,
                                operationName = "UpdateManga",
                                variablesJson = buildJsonObject {
                                    put("id", remoteMangaId)
                                    put("inLibrary", mutation.inLibrary)
                                }.toString(),
                                entityId = workEntityId.value,
                                createdAtEpochMillis = createdAtEpochMillis,
                            ),
                        )
                    }

                    val addCategoryIds = addedCategoryIds.mapNotNull { categoryId ->
                        categoryEntities[categoryId]?.value?.let(::suwayomiCategoryIdForEntity)
                    }
                    val removeCategoryIds = removedCategoryIds.mapNotNull { categoryId ->
                        categoryEntities[categoryId]?.value?.let(::suwayomiCategoryIdForEntity)
                    }
                    if (addCategoryIds.isNotEmpty() || removeCategoryIds.isNotEmpty()) {
                        add(
                            SuwayomiMutationIntent(
                                operationId = mutationIds.next().value,
                                profileId = profileId,
                                operationName = "UpdateMangaCategories",
                                variablesJson = buildJsonObject {
                                    put("mangaId", remoteMangaId)
                                    put("addTo", buildJsonArray {
                                        addCategoryIds.forEach { add(JsonPrimitive(it)) }
                                    })
                                    put("removeFrom", buildJsonArray {
                                        removeCategoryIds.forEach { add(JsonPrimitive(it)) }
                                    })
                                }.toString(),
                                entityId = workEntityId.value,
                                createdAtEpochMillis = createdAtEpochMillis,
                            ),
                        )
                    }
                }
            } else {
                emptyList()
            }
        } else {
            emptyList()
        }

        LocalMutationResult(
            value = LibraryMembershipMutationResult(
                changed = identityProvisioned || membershipChanged ||
                    removedCategoryIds.isNotEmpty() || addedCategoryIds.isNotEmpty(),
                membershipChanged = membershipChanged,
                addedCategoryIds = addedCategoryIds,
                removedCategoryIds = removedCategoryIds,
                emittedCommandCount = envelopes.size + suwayomiMutations.size,
            ),
            envelopes = envelopes,
            suwayomiMutations = suwayomiMutations,
            // A comic added to a local-only category is published when a sync run creates that
            // category on the Core, so start one now instead of waiting for the next scheduled run.
            wakesSync = !isNovel && mutation.origin.emitsOutbox &&
                addedCategoryIds.any { it !in categoryEntities },
        )
        }
    }

    /** Books and novels share the folder: a desktop Books category bound for books keeps its one id. */
    private fun yokai.data.Database.novelCategoryEntityId(categoryId: Long): EpigraphEntityId =
        EpigraphEntityId(
            aethon_syncQueries.selectCategoryIdentityByLocalIdAndScope(categoryId, "BOOK")
                .executeAsOneOrNull()?.entity_id
                ?: "novel-category-local-$categoryId",
        )

    private fun novelEntrySnapshot(
        manga: tachiyomi.data.Mangas,
        entityId: EpigraphEntityId,
        portableWork: PortableWorkRef.Novel?,
        now: Long,
    ): NovelEntrySnapshot? {
        val title = manga.title.trim().ifBlank { return null }
        val path = portableWork?.novelKey?.value ?: manga.url.trim().ifBlank { entityId.value }
        return NovelEntrySnapshot(
            identityKey = entityId.value,
            title = title,
            author = manga.author,
            description = manga.description,
            coverUrl = manga.thumbnail_url,
            path = path,
            status = manga.status.toString(),
            tags = manga.genre.orEmpty().split(',').map(String::trim).filter(String::isNotBlank),
            source = buildJsonObject {
                put("repositoryUrl", "https://local.epigraph")
                put("pluginId", portableWork?.pluginId ?: "hayai")
                put("sourceId", manga.source.toString())
            },
            addedAtMs = manga.date_added ?: now,
            updatedAtMs = now,
        )
    }

    private companion object {
        val COMIC_ENTRY = SyncEntityType("comic.entry")
        val COMIC_CATEGORY_ASSIGNMENT = SyncEntityType("comic.category_assignment")
        val COMIC_CATEGORY = SyncEntityType("comic.category")
        val NOVEL_ENTRY = SyncEntityType("novel.entry")
        val NOVEL_CATEGORY = SyncEntityType("novel.category")
        val NOVEL_CATEGORY_ASSIGNMENT = SyncEntityType("novel.category_assignment")
        const val MAX_TITLE_HINT_LENGTH = 512
    }
}
