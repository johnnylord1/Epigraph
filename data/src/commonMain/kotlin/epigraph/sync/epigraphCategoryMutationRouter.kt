package epigraph.sync

import epigraph.contract.CategoryScope
import epigraph.contract.DeviceId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.sync.portable.SqlDelightPortableBindingStore
import kotlinx.coroutines.CancellationException
import tachiyomi.data.Aethon_category_identity
import yokai.data.Database

data class CategoryMutationResult(
    val emittedCommandCount: Int,
)

/**
 * Transaction-safe writer for category rename, reorder and delete.
 *
 * Only categories which already have an Epigraph identity are published: a local category gets
 * its identity together with its first synchronized assignment (see [EpigraphLibraryMutationRouter]
 * and [EpigraphBookMutationRouter]), and that first publication carries the current name/order.
 */
class EpigraphCategoryMutationRouter(
    private val coordinator: EpigraphMutationCoordinator,
    private val deviceId: DeviceId,
    private val mutationIds: ClientMutationIdFactory,
    private val scopeProvider: EpigraphSyncScopeProvider,
    private val clock: () -> Long = System::currentTimeMillis,
) {
    /**
     * Runs [apply] (the local `categories` update) and publishes the name/order of every synchronized
     * category in [touchedCategoryIds] whose state differs from the last published identity.
     */
    suspend fun updateCategories(
        touchedCategoryIds: Set<Long>,
        apply: suspend Database.() -> Unit,
    ): CategoryMutationResult {
        val scopes = pairedScopes()
        val now = timestamp()
        return coordinator.mutateLocalBatch(now) {
            apply()
            if (scopes == null) return@mutateLocalBatch LocalMutationResult(CategoryMutationResult(0), emptyList())
            val locals = categoriesQueries.findAll().executeAsList()
            val identities = locals.mapNotNull { category ->
                aethon_syncQueries.selectCategoryIdentityByLocalId(category._id).executeAsOneOrNull()
            }.associateBy { it.local_category_id }
            val comicRanks = comicRanks(locals.map { it._id }, identities)
            val positions = locals.syncPositions()

            val envelopes = locals
                .filter { it._id > 0 && it._id in touchedCategoryIds }
                .mapNotNull { category ->
                    val identity = identities[category._id] ?: return@mapNotNull null
                    val target = identity.target(scopes) ?: return@mapNotNull null
                    val position = if (target.scope == CategoryScope.MANGA) {
                        comicRanks[category._id] ?: return@mapNotNull null
                    } else {
                        positions[category._id] ?: return@mapNotNull null
                    }
                    val name = category.name
                    if (!name.isPublishableCategoryName(target.maxNameUtf8Bytes)) return@mapNotNull null
                    if (name == identity.name && position == identity.sort_order) return@mapNotNull null
                    aethon_syncQueries.upsertCategoryIdentity(
                        entityId = identity.entity_id,
                        localCategoryId = category._id,
                        contentScope = identity.content_scope,
                        name = name,
                        sortOrder = position,
                        updatedAt = now,
                    )
                    envelope(
                        target,
                        SyncCommand.UpsertCategory(
                            entityId = EpigraphEntityId(identity.entity_id),
                            name = name,
                            scope = target.scope,
                            position = position,
                        ),
                    )
                }
            LocalMutationResult(CategoryMutationResult(envelopes.size), envelopes)
        }
    }

    /**
     * Deletes one local category. The Core refuses to delete a category that still has live
     * assignments, so assignment tombstones are queued before the category [SyncCommand.DeleteEntity].
     */
    suspend fun deleteCategory(
        localCategoryId: Long,
        delete: suspend Database.() -> Unit,
    ): CategoryMutationResult {
        val scopes = pairedScopes()
        val now = timestamp()
        return coordinator.mutateLocalBatch(now) {
            if (scopes == null) {
                delete()
                return@mutateLocalBatch LocalMutationResult(CategoryMutationResult(0), emptyList())
            }
            val identity = aethon_syncQueries.selectCategoryIdentityByLocalId(localCategoryId).executeAsOneOrNull()
            val target = identity?.target(scopes)
            val envelopes = if (identity == null || target == null) {
                emptyList()
            } else {
                val categoryEntity = EpigraphEntityId(identity.entity_id)
                buildList {
                    when (target.scope) {
                        CategoryScope.BOOK -> addAll(bookAssignmentRewrites(localCategoryId, target))
                        else -> addAll(assignmentTombstones(localCategoryId, categoryEntity, target))
                    }
                    add(envelope(target, SyncCommand.DeleteEntity(categoryEntity)))
                }
            }
            delete()
            LocalMutationResult(CategoryMutationResult(envelopes.size), envelopes)
        }
    }

    private fun Database.assignmentTombstones(
        localCategoryId: Long,
        categoryEntity: EpigraphEntityId,
        target: CategoryTarget,
    ): List<SyncCommandEnvelope> {
        val novel = target.scope == CategoryScope.NOVEL
        val portableStore = SqlDelightPortableBindingStore(this)
        return aethon_syncQueries.selectMangaIdsByCategory(localCategoryId).executeAsList().mapNotNull { mangaId ->
            val identity = aethon_syncQueries
                .selectIdentityByLocalReference(if (novel) "NOVEL" else "MANGA", mangaId.toString())
                .executeAsOneOrNull()
                ?: return@mapNotNull null
            val portableWork = portableStore
                .workByLocalReference(mangaId.toString())
                ?.takeIf { it.resolution.state.name == "BOUND" }
                ?.ref
            // Legacy comic rows have no Core assignment; Suwayomi drops them with the category.
            if (!novel && portableWork !is PortableWorkRef.Comic) return@mapNotNull null
            val workEntity = portableWork?.let(PortableIdentityV3::workId)?.let(::EpigraphEntityId)
                ?: EpigraphEntityId(identity.entity_id)
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = target.scopeId,
                entityType = if (novel) NOVEL_CATEGORY_ASSIGNMENT else COMIC_CATEGORY_ASSIGNMENT,
                command = SyncCommand.SetCategoryAssignment(workEntity, categoryEntity, false, portableWork),
            )
        }
    }

    /** Book assignments are published as a full set per book; publish each set without [localCategoryId]. */
    private fun Database.bookAssignmentRewrites(
        localCategoryId: Long,
        target: CategoryTarget,
    ): List<SyncCommandEnvelope> =
        aethon_syncQueries.selectBookIdsByCategory(localCategoryId).executeAsList().map { bookId ->
            val remaining = local_booksQueries.findCategoryIds(bookId).executeAsList()
                .filter { it != localCategoryId }
                .distinct()
                .sorted()
                .mapNotNull { categoryId ->
                    aethon_syncQueries.selectCategoryIdentityByLocalId(categoryId).executeAsOneOrNull()
                        ?.let { EpigraphEntityId(it.entity_id) }
                }
            SyncCommandEnvelope(
                protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
                deviceId = deviceId,
                clientMutationId = mutationIds.next(),
                scopeId = target.scopeId,
                entityType = BOOK_CATEGORY_ASSIGNMENT,
                command = SyncCommand.SetBookCategoryAssignments(EpigraphEntityId(bookId), remaining),
            )
        }

    /**
     * Suwayomi reserves position 0 for its default category, so user categories of one profile are
     * ranked 1..n following the local order.
     */
    private fun comicRanks(
        orderedLocalIds: List<Long>,
        identities: Map<Long, Aethon_category_identity>,
    ): Map<Long, Long> = orderedLocalIds
        .mapNotNull { localId ->
            val identity = identities[localId]?.takeIf { it.content_scope == "MANGA" } ?: return@mapNotNull null
            if (suwayomiCategoryIdForEntity(identity.entity_id) == null) return@mapNotNull null
            val profile = suwayomiProfileIdForEntity(identity.entity_id) ?: return@mapNotNull null
            profile to localId
        }
        .groupBy({ it.first }, { it.second })
        .values
        .flatMap { ids -> ids.mapIndexed { index, localId -> localId to (index + 1).toLong() } }
        .toMap()

    private fun Aethon_category_identity.target(scopes: EpigraphSyncScopes): CategoryTarget? =
        when (content_scope) {
            "NOVEL" -> CategoryTarget(CategoryScope.NOVEL, scopes.novels, NOVEL_CATEGORY, null)
            "BOOK" -> CategoryTarget(CategoryScope.BOOK, BOOKS_SCOPE, BOOK_CATEGORY, null)
            "MANGA" -> {
                // A local-only comic category has no Suwayomi ID the Core could project.
                if (suwayomiCategoryIdForEntity(entity_id) == null) {
                    null
                } else {
                    CategoryTarget(
                        scope = CategoryScope.MANGA,
                        scopeId = suwayomiComicScopeForCategory(entity_id, scopes.comics),
                        entityType = COMIC_CATEGORY,
                        maxNameUtf8Bytes = SUWAYOMI_CATEGORY_NAME_MAX_BYTES,
                    )
                }
            }
            else -> null
        }

    private fun envelope(target: CategoryTarget, command: SyncCommand) = SyncCommandEnvelope(
        protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
        deviceId = deviceId,
        clientMutationId = mutationIds.next(),
        scopeId = target.scopeId,
        entityType = target.entityType,
        command = command,
    )

    /** Without a paired profile there is nowhere to publish; the edit stays local. */
    private suspend fun pairedScopes(): EpigraphSyncScopes? = try {
        scopeProvider.current()
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (_: Exception) {
        null
    }

    private fun timestamp(): Long = clock().also {
        require(it >= 0) { "mutation timestamp must be epoch milliseconds" }
    }

    private data class CategoryTarget(
        val scope: CategoryScope,
        val scopeId: SyncScopeId,
        val entityType: SyncEntityType,
        val maxNameUtf8Bytes: Int?,
    )

    private companion object {
        const val SUWAYOMI_CATEGORY_NAME_MAX_BYTES = 256
        val BOOKS_SCOPE = SyncScopeId("books:global")
        val BOOK_CATEGORY = SyncEntityType("book.category")
        val BOOK_CATEGORY_ASSIGNMENT = SyncEntityType("book.category_assignment")
        val NOVEL_CATEGORY = SyncEntityType("novel.category")
        val NOVEL_CATEGORY_ASSIGNMENT = SyncEntityType("novel.category_assignment")
        val COMIC_CATEGORY = SyncEntityType("comic.category")
        val COMIC_CATEGORY_ASSIGNMENT = SyncEntityType("comic.category_assignment")
    }
}

/** Mirrors `UpsertCategory` validation plus the Suwayomi byte limit, so a bad name never blocks the outbox. */
internal fun String.isPublishableCategoryName(maxUtf8Bytes: Int?): Boolean =
    isNotBlank() &&
        this == trim() &&
        length <= 512 &&
        none(Char::isISOControl) &&
        (maxUtf8Bytes == null || encodeToByteArray().size <= maxUtf8Bytes)

internal fun suwayomiComicScopeForCategory(entityId: String, fallback: SyncScopeId): SyncScopeId =
    suwayomiProfileIdForEntity(entityId)
        ?.takeIf { suwayomiCategoryIdForEntity(entityId) != null }
        ?.let { SyncScopeId("comics:profile:$it") }
        ?: fallback
