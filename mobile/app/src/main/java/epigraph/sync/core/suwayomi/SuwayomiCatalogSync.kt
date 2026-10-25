package epigraph.sync.core.suwayomi

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.protocol.SuwayomiCatalogOperation
import epigraph.sync.core.protocol.SuwayomiCatalogResponse
import epigraph.sync.core.protocol.SuwayomiCoreContentReference
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.replica.EpigraphCoreDomainProjection
import epigraph.sync.core.replica.CoreConfirmedRecord
import epigraph.sync.core.replica.CoreReplicaKey
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.work.CoreRemoteProjectionState
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.core.work.remoteProjectionState
import android.content.Context
import android.util.Log
import eu.kanade.tachiyomi.BuildConfig
import java.security.MessageDigest
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import tachiyomi.data.Aethon_category_identity
import yokai.data.Database
import yokai.data.DatabaseHandler
import yokai.data.memoColumnAdapter

/**
 * Reads the profile-scoped Suwayomi catalog without turning it into Syncd state.
 *
 * The bridge is paged and read-only. A page is never interpreted as a complete catalog, and this
 * class never deletes local rows because a request failed or because a later page was unavailable.
 * Chapters are deliberately excluded from periodic reconciliation; the internal Core source loads
 * them on demand when a title is opened, changed, downloaded, or explicitly refreshed.
 */
class SuwayomiCatalogSync(
    private val pages: SuwayomiCatalogPageSource,
    private val database: DatabaseHandler,
    private val projection: EpigraphCoreDomainProjection,
    private val covers: CoreCatalogCoverSink = DeferredCoreCatalogCoverSink,
    private val pageSize: Long = DEFAULT_PAGE_SIZE,
    private val projectionStatus: SuwayomiProjectionStatusSource = UnavailableSuwayomiProjectionStatusSource,
    private val stamps: CatalogApplyStampStore? = null,
) : CoreReplicaSyncPort {
    init {
        require(pageSize in 1..MAX_PAGE_SIZE) { "pageSize is outside the Core catalog limit" }
    }

    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        require(nowEpochMillis >= 0) { "sync timestamp must not be negative" }
        if (!capabilities.supportsSuwayomiProxy || !capabilities.supportsSuwayomiCatalog) {
            return CoreReplicaSyncOutcome.DEFERRED
        }

        val scopeId = "comics:profile:${credentials.profileId}"
        if (scopeId !in credentials.scopes) return CoreReplicaSyncOutcome.DEFERRED

        // Mutations drained in this run reach Suwayomi asynchronously. Until the desktop reports
        // its projection queue empty, a catalog read may predate them and would undo the user's
        // own favorite or category change, so retry instead of reconciling against it. Chapter
        // progress is not part of the catalog, so a desktop that counts it apart is not waited on
        // for it.
        if (EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) {
            when (val status = projectionStatus.status(credentials, scopeId)) {
                null -> Unit
                is CoreHttpResult.Success -> {
                    val catalogPending = status.value.suwayomiCatalogProjectionPending?.let { it > 0 }
                        ?: (status.value.remoteProjectionState() == CoreRemoteProjectionState.IN_PROGRESS)
                    if (catalogPending) return CoreReplicaSyncOutcome.RETRY
                }
                is CoreHttpResult.Failure -> return CoreReplicaSyncOutcome.RETRY
            }
        }

        // Both reads run at once; a library failure is still the one reported when both fail.
        val (libraryRead, categoriesRead) = coroutineScope {
            val library = async { readAll(credentials, SuwayomiCatalogOperation.LIBRARY) }
            val categories = async { readAll(credentials, SuwayomiCatalogOperation.CATEGORIES) }
            library.await() to categories.await()
        }
        val library = libraryRead.getOrElse { failure ->
            failure as CatalogSyncFailure
            reportCatalogFailure(SuwayomiCatalogOperation.LIBRARY, failure)
            return failure.outcome()
        }
        val remoteCategories = categoriesRead.getOrElse { failure ->
            failure as CatalogSyncFailure
            reportCatalogFailure(SuwayomiCatalogOperation.CATEGORIES, failure)
            return failure.outcome()
        }.filterNot { node -> node.long("id") == SUWAYOMI_DEFAULT_CATEGORY_ID }
        val categories = if (SuwayomiCategoryCreateHook.isEnabled(capabilities)) {
            database.await(inTransaction = true) {
                withoutCategoriesAwaitingBind(this, credentials, remoteCategories)
            }
        } else {
            remoteCategories
        }

        val mangaEntityIds = database.await(inTransaction = false) {
            library.mapNotNull { node ->
                node.long("id")?.let { mangaId ->
                    mangaId to resolveMangaEntityId(this, credentials, mangaId)
                }
            }.toMap()
        }
        val categoryEntityIds = database.await(inTransaction = true) {
            categories.mapNotNull { node ->
                node.long("id")?.let { categoryId ->
                    categoryId to resolveCategoryEntityId(this, credentials, categoryId, node.string("name"))
                }
            }.toMap()
        }
        val mangaRecords = library.mapNotNull { node ->
            node.long("id")?.let { mangaId ->
                entryRecord(
                    scopeId,
                    credentials,
                    mangaEntityIds.getValue(mangaId),
                    mangaId,
                    node,
                    nowEpochMillis,
                )
            }
        }
        val categoryRecords = categories.mapNotNull { node ->
            node.long("id")?.let { categoryId ->
                categoryRecord(
                    scopeId,
                    credentials,
                    categoryEntityIds.getValue(categoryId),
                    node,
                    nowEpochMillis,
                )
            }
        }
        val assignmentRecords = categories.flatMap { category ->
            val categoryId = category.long("id") ?: return@flatMap emptyList()
            val categoryEntityId = categoryEntityIds[categoryId] ?: return@flatMap emptyList()
            category.mangaNodes().mapNotNull { manga ->
                val mangaId = manga.long("id") ?: return@mapNotNull null
                val mangaEntityId = mangaEntityIds[mangaId] ?: return@mapNotNull null
                CoreConfirmedRecord(
                    key = CoreReplicaKey(
                        scopeId = scopeId,
                        entityType = "comic.category_assignment",
                        entityId = "$categoryEntityId:manga:$mangaId",
                    ),
                    serverVersion = nowEpochMillis,
                    lamport = 0,
                    record = buildJsonObject {
                        put("comicId", mangaEntityId)
                        put("categoryId", categoryEntityId)
                        put("coreServerId", credentials.serverId)
                        put("coreProfileId", credentials.profileId)
                    },
                )
            }
        }

        val stampKey = "${credentials.serverId}:${credentials.profileId}"
        val previousStamp = stamps?.get(stampKey)
        val (catalogDigest, recordDigests) = digests(
            SuwayomiCategoryCreateHook.isEnabled(capabilities),
            mangaRecords + categoryRecords + assignmentRecords,
        )
        // Applying only after both complete reads protects the local library from partial pages.
        // Reconciliation is intentionally limited to the authoritative library bit; local
        // metadata, chapters, progress and assets remain recoverable after an un-favorite.
        val unchanged = database.await(inTransaction = true) {
            // The same catalog applied to the same local library changes nothing, so it is only
            // re-applied periodically.
            val localSignature = localLibrarySignature(scopeId)
            if (
                unsettledComicEntityIds(scopeId, credentials).isEmpty() &&
                previousStamp?.covers(catalogDigest, localSignature, nowEpochMillis) == true
            ) {
                return@await null
            }
            // A record applied unchanged to this same local library since the last full apply
            // needs no second write: a read on the desktop changes one title, not the other few
            // hundred, and writing every title again took seconds. After a change to the local
            // library, only the records it no longer shows are written again.
            previousStamp?.unchangedRecords(localSignature, nowEpochMillis)
                ?: previousStamp?.recentRecords(nowEpochMillis)?.let { recent ->
                    stillShown(mangaRecords + categoryRecords + assignmentRecords, recordDigests, recent)
                }
                ?: emptySet()
        }
        val appliedStamp = if (unchanged == null) {
            previousStamp!!
        } else {
            fun CoreConfirmedRecord.changed() = recordDigests.getValue(key) !in unchanged
            // Titles with local work still in flight keep their local library bit and category
            // links; the next catalog read after that work settles reconciles them.
            val heldEntityIds = HashSet<String>()
            applyInBatches(scopeId, credentials, mangaRecords.filter { it.changed() }, heldEntityIds) { record ->
                record.key.entityId in heldEntityIds
            }
            // Restored titles are adopted just above, so a same-name phone folder only now counts as
            // holding comics. Its remote twin waits for the create hook to bind it by name instead
            // of arriving as a second folder with the same name.
            val deferredCategoryEntityIds = if (SuwayomiCategoryCreateHook.isEnabled(capabilities)) {
                val kept = database.await(inTransaction = true) {
                    withoutCategoriesAwaitingBind(this, credentials, categories).toSet()
                }
                categories.filterNot { it in kept }
                    .mapNotNullTo(HashSet()) { node -> node.long("id")?.let(categoryEntityIds::get) }
            } else {
                emptySet()
            }
            val appliedCategoryRecords = categoryRecords.filterNot { it.key.entityId in deferredCategoryEntityIds }
            val appliedAssignmentRecords = assignmentRecords.filterNot { record ->
                (record.record as JsonObject).getValue("categoryId").jsonPrimitive.content in deferredCategoryEntityIds
            }
            applyInBatches(scopeId, credentials, appliedCategoryRecords.filter { it.changed() }, heldEntityIds) { false }
            applyInBatches(scopeId, credentials, appliedAssignmentRecords.filter { it.changed() }, heldEntityIds) { record ->
                record.comicId() in heldEntityIds
            }
            database.await(inTransaction = true) {
                heldEntityIds += unsettledComicEntityIds(scopeId, credentials)
                projection.reconcileSuwayomiLibrary(
                    database = this,
                    serverId = credentials.serverId,
                    profileId = credentials.profileId,
                    observedEntityIds = mangaRecords.mapTo(mutableSetOf()) { it.key.entityId },
                    protectedEntityIds = heldEntityIds,
                )
                projection.reconcileSuwayomiCategoryAssignments(
                    database = this,
                    serverId = credentials.serverId,
                    profileId = credentials.profileId,
                    observedCategoryEntityIds = appliedCategoryRecords.mapTo(mutableSetOf()) { it.key.entityId },
                    observedAssignments = appliedAssignmentRecords.mapTo(mutableSetOf()) { record ->
                        val payload = record.record as JsonObject
                        payload.getValue("comicId").jsonPrimitive.content to
                            payload.getValue("categoryId").jsonPrimitive.content
                    },
                    protectedEntityIds = heldEntityIds,
                )
                // Held-back titles and folders are applied by a later run, never counted as applied.
                val appliedAssignmentKeys = appliedAssignmentRecords.mapTo(HashSet()) { it.key }
                val held = mangaRecords.filter { it.key.entityId in heldEntityIds }.mapTo(HashSet()) { it.key } +
                    categoryRecords.filter { it.key.entityId in deferredCategoryEntityIds }.map { it.key } +
                    assignmentRecords.map { it.key }.filterNot { it in appliedAssignmentKeys } +
                    appliedAssignmentRecords.filter { it.comicId() in heldEntityIds }.map { it.key }
                CatalogApplyStamp(
                    catalogDigest = if (held.isEmpty()) catalogDigest else "",
                    localSignature = localLibrarySignature(scopeId),
                    appliedAt = if (unchanged.isEmpty()) nowEpochMillis else previousStamp!!.appliedAt,
                    recordDigests = recordDigests.filterKeys { it !in held }.values.toSet(),
                )
            }
        }
        stamps?.put(stampKey, appliedStamp)

        try {
            covers.materialize(
                library.mapNotNull { node ->
                    node.long("id")?.let { mangaId ->
                        CoreCatalogCoverReference(thumbnailReference(credentials, mangaId))
                    }
                },
            )
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (failure: Throwable) {
            val failureType = failure::class.simpleName ?: "UnknownFailure"
            Log.w("EpigraphCoreCatalog", "cover materialization deferred: $failureType")
        }

        return CoreReplicaSyncOutcome.APPLIED
    }

    /**
     * Reads every page of [operation]. Once the first page gives the total, the remaining pages are
     * requested a few at a time instead of one after another; each round trip to the desktop costs
     * a few hundred milliseconds, which made a library of a few hundred titles take seconds. Pages
     * are still checked in offset order, exactly as a sequential read would check them.
     */
    /** [fetchAll], with a catalog failure as the result instead of thrown. */
    private suspend fun readAll(
        credentials: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
    ): Result<List<JsonObject>> = try {
        Result.success(fetchAll(credentials, operation))
    } catch (failure: CatalogSyncFailure) {
        Result.failure(failure)
    }

    private suspend fun fetchAll(
        credentials: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        mangaId: Long? = null,
    ): List<JsonObject> = coroutineScope {
        val nodes = ArrayList<JsonObject>()
        val observedIds = HashSet<Long>()
        var expectedTotal: Long? = null
        var offset = 0L
        var hasNext = true
        val permits = Semaphore(PARALLEL_PAGE_READS)
        val prefetched = HashMap<Long, Deferred<CoreHttpResult<SuwayomiCatalogResponse>>>()
        while (hasNext) {
            if (nodes.size >= MAX_ITEMS) throw CatalogSyncFailure.Protocol(ProtocolFailure.MAX_ITEMS)
            val response = when (
                val result = prefetched.remove(offset)?.await() ?: pages.read(
                    session = credentials,
                    operation = operation,
                    pageSize = pageSize,
                    offset = offset,
                    mangaId = mangaId,
                )
            ) {
                is CoreHttpResult.Success -> result.value
                is CoreHttpResult.Failure -> throw CatalogSyncFailure.Http(result)
            }
            validateResponse(response, credentials, operation, offset)
            val pageNodes = response.data.connectionNodes(operation)
            val total = response.page.totalCount
                ?: throw CatalogSyncFailure.Protocol(ProtocolFailure.MISSING_TOTAL)
            if (expectedTotal == null) {
                expectedTotal = total
                if (response.page.hasNextPage) {
                    var next = offset + pageSize
                    while (next < minOf(total, MAX_ITEMS.toLong()) && next <= Int.MAX_VALUE) {
                        val pageOffset = next
                        prefetched[pageOffset] = async {
                            permits.withPermit {
                                pages.read(
                                    session = credentials,
                                    operation = operation,
                                    pageSize = pageSize,
                                    offset = pageOffset,
                                    mangaId = mangaId,
                                )
                            }
                        }
                        next += pageSize
                    }
                }
            }
            if (expectedTotal != total || pageNodes.size.toLong() > response.page.pageSize) {
                throw CatalogSyncFailure.Protocol(ProtocolFailure.INCONSISTENT_PAGE)
            }
            pageNodes.forEach { node ->
                val id = node.long("id")?.takeIf { operation.acceptsId(it) }
                    ?: throw CatalogSyncFailure.Protocol(ProtocolFailure.INVALID_ID)
                if (!observedIds.add(id)) {
                    throw CatalogSyncFailure.Protocol(ProtocolFailure.DUPLICATE_ID)
                }
            }
            val observedEnd = offset + pageNodes.size
            if (observedEnd > total || (response.page.hasNextPage && pageNodes.isEmpty())) {
                throw CatalogSyncFailure.Protocol(ProtocolFailure.INVALID_PAGE_WINDOW)
            }
            if (!response.page.hasNextPage && observedEnd != total) {
                throw CatalogSyncFailure.Protocol(ProtocolFailure.INCOMPLETE_FINAL_PAGE)
            }
            nodes += pageNodes
            hasNext = response.page.hasNextPage
            if (hasNext) {
                val nextOffset = offset + response.page.pageSize
                if (nextOffset <= offset || nextOffset > Int.MAX_VALUE) {
                    throw CatalogSyncFailure.Protocol(ProtocolFailure.INVALID_NEXT_OFFSET)
                }
                offset = nextOffset
            }
        }
        prefetched.values.forEach { it.cancel() }
        if (nodes.size.toLong() != expectedTotal) {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.COUNT_MISMATCH)
        }
        nodes
    }

    private fun validateResponse(
        response: SuwayomiCatalogResponse,
        credentials: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        expectedOffset: Long,
    ) {
        if (response.schemaVersion != SUPPORTED_SCHEMA_VERSION) {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.SCHEMA)
        }
        if (response.scopeId != "comics:profile:${credentials.profileId}") {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.SCOPE)
        }
        if (response.operation != operation.wireName) {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.OPERATION)
        }
        if (response.page.offset != expectedOffset) {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.OFFSET)
        }
    }

    private fun entryRecord(
        scopeId: String,
        credentials: CoreCredentialSession,
        entityId: String,
        mangaId: Long,
        node: JsonObject,
        nowEpochMillis: Long,
    ): CoreConfirmedRecord {
        val thumbnail = node.string("thumbnailUrl")
        val providerKey = node.string("url")
        val catalogNode = if (thumbnail.isNullOrBlank()) {
            node.withIfPresent("providerKey", providerKey)
                .withIfPresent("url", node.string("realUrl"))
        } else {
            node.withIfPresent("providerKey", providerKey)
                .withIfPresent("url", node.string("realUrl"))
                .with(
                "thumbnailUrl",
                thumbnailReference(credentials, mangaId),
                )
        }
        return CoreConfirmedRecord(
            key = CoreReplicaKey(scopeId, "comic.entry", entityId),
            serverVersion = nowEpochMillis,
            lamport = 0,
            record = catalogNode
                .with("comicId", entityId)
                .with("suwayomiMangaId", mangaId.toString())
                .with("coreServerId", credentials.serverId)
                .with("coreProfileId", credentials.profileId),
        )
    }

    private fun categoryRecord(
        scopeId: String,
        credentials: CoreCredentialSession,
        entityId: String,
        node: JsonObject,
        nowEpochMillis: Long,
    ): CoreConfirmedRecord = CoreConfirmedRecord(
        key = CoreReplicaKey(scopeId, "comic.category", entityId),
        serverVersion = nowEpochMillis,
        lamport = 0,
        record = node
            .with("coreServerId", credentials.serverId)
            .with("coreProfileId", credentials.profileId),
    )

    /**
     * The digest of the whole catalog and a short digest of each record (a stamp keeps one per
     * record it applied), from a single serialization of every record.
     */
    private fun digests(
        categoryCreateHook: Boolean,
        records: List<CoreConfirmedRecord>,
    ): Pair<String, Map<CoreReplicaKey, String>> {
        val catalog = MessageDigest.getInstance("SHA-256")
        val single = MessageDigest.getInstance("SHA-256")
        catalog.update(if (categoryCreateHook) 1 else 0)
        val recordDigests = HashMap<CoreReplicaKey, String>(records.size * 2)
        records.forEach { record ->
            val type = record.key.entityType.toByteArray()
            val id = record.key.entityId.toByteArray()
            val body = record.record.toString().toByteArray()
            for (digest in arrayOf(catalog, single)) {
                digest.update(type)
                digest.update(0)
                digest.update(id)
                digest.update(0)
                digest.update(body)
            }
            catalog.update(0)
            recordDigests[record.key] = hex(single.digest(), RECORD_DIGEST_BYTES)
        }
        val catalogDigest = catalog.digest()
        return hex(catalogDigest, catalogDigest.size) to recordDigests
    }

    private fun hex(bytes: ByteArray, count: Int): String {
        val chars = CharArray(count * 2)
        for (index in 0 until count) {
            val value = bytes[index].toInt() and 0xff
            chars[index * 2] = HEX_DIGITS[value ushr 4]
            chars[index * 2 + 1] = HEX_DIGITS[value and 0x0f]
        }
        return String(chars)
    }

    /**
     * Upserts [records] a batch per transaction, so a full apply never holds the database long
     * enough to delay a progress write from the reader or from another sync. Every batch reads the
     * titles with local work in flight again, since that work may start while the apply runs.
     */
    private suspend fun applyInBatches(
        scopeId: String,
        credentials: CoreCredentialSession,
        records: List<CoreConfirmedRecord>,
        heldEntityIds: MutableSet<String>,
        isHeld: (CoreConfirmedRecord) -> Boolean,
    ) {
        records.chunked(APPLY_BATCH_SIZE).forEach { batch ->
            database.await(inTransaction = true) {
                heldEntityIds += unsettledComicEntityIds(scopeId, credentials)
                batch.filterNot(isHeld).forEach { record -> projection.upsert(this, record) }
            }
        }
    }

    private fun Database.unsettledComicEntityIds(scopeId: String, credentials: CoreCredentialSession): List<String> =
        aethon_syncQueries.selectUnsettledSuwayomiComicEntityIds(scopeId, credentials.profileId).executeAsList()

    /**
     * The digests among [recent] whose records the local library still shows, from three reads
     * instead of one projection per record. A title out of the library, a renamed or missing
     * folder, or a missing assignment is written again.
     */
    private fun Database.stillShown(
        records: List<CoreConfirmedRecord>,
        recordDigests: Map<CoreReplicaKey, String>,
        recent: Set<String>,
    ): Set<String> {
        val favorites = aethon_syncQueries.selectComicEntityFavorites().executeAsList()
            .associate { it.entity_id to it.favorite }
        val categories = aethon_syncQueries.selectComicCategoryStates().executeAsList()
            .associateBy { it.entity_id }
        val assignments = aethon_syncQueries.selectComicCategoryAssignmentEntityIds().executeAsList()
            .mapTo(HashSet()) { it.comic_entity_id to it.category_entity_id }
        return records.mapNotNullTo(HashSet()) { record ->
            val digest = recordDigests.getValue(record.key).takeIf { it in recent } ?: return@mapNotNullTo null
            val body = record.record as? JsonObject ?: return@mapNotNullTo null
            val shown = when (record.key.entityType) {
                "comic.entry" -> favorites[record.key.entityId]
                    ?.let { favorite -> favorite == (body.boolean("inLibrary") ?: favorite) } == true
                "comic.category" -> categories[record.key.entityId]?.let { local ->
                    local.name == body.string("name") && local.sort == (body.long("order")?.coerceAtLeast(0) ?: 0L)
                } == true
                "comic.category_assignment" -> (body.string("comicId") to body.string("categoryId")) in assignments
                else -> false
            }
            digest.takeIf { shown }
        }
    }

    private fun Database.localLibrarySignature(scopeId: String): String =
        aethon_syncQueries.selectComicLibrarySignature(scopeId).executeAsOne().toString()

    private fun CatalogSyncFailure.outcome(): CoreReplicaSyncOutcome = when (this) {
        is CatalogSyncFailure.Http -> if (result.statusCode == 401 || result.statusCode == 403) {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        } else if (result.statusCode == 408 || result.statusCode == 425 || result.statusCode == 429 || result.statusCode >= 500) {
            CoreReplicaSyncOutcome.RETRY
        } else {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        }
        // The connection may change between pages. Retry from a fresh snapshot; never apply a
        // partial set because reconciliation could otherwise demote valid Library rows.
        is CatalogSyncFailure.Protocol -> CoreReplicaSyncOutcome.RETRY
    }

    private fun reportCatalogFailure(
        operation: SuwayomiCatalogOperation,
        failure: CatalogSyncFailure,
    ) {
        if (!BuildConfig.DEBUG) return
        val reason = when (failure) {
            is CatalogSyncFailure.Http -> "http_${failure.result.statusCode}"
            is CatalogSyncFailure.Protocol -> "protocol_${failure.reason.name.lowercase()}"
        }
        runCatching {
            Log.d("EpigraphCoreSync", "catalog ${operation.wireName} failed: $reason")
        }
    }

    private sealed class CatalogSyncFailure(message: String) : Exception(message) {
        class Http(val result: CoreHttpResult.Failure) : CatalogSyncFailure("catalog http failure")
        class Protocol(val reason: ProtocolFailure) : CatalogSyncFailure("catalog protocol failure")
    }

    private enum class ProtocolFailure {
        MAX_ITEMS,
        MISSING_TOTAL,
        INCONSISTENT_PAGE,
        INVALID_ID,
        DUPLICATE_ID,
        INVALID_PAGE_WINDOW,
        INCOMPLETE_FINAL_PAGE,
        INVALID_NEXT_OFFSET,
        COUNT_MISMATCH,
        SCHEMA,
        SCOPE,
        OPERATION,
        OFFSET,
    }

    internal companion object {
        const val SUPPORTED_SCHEMA_VERSION = 1
        const val DEFAULT_PAGE_SIZE = 100L
        const val MAX_PAGE_SIZE = 250L
        const val MAX_ITEMS = 50_000
        const val PARALLEL_PAGE_READS = 4
        const val REAPPLY_INTERVAL_MS = 6 * 60 * 60 * 1_000L
        private const val APPLY_BATCH_SIZE = 50
        private const val RECORD_DIGEST_BYTES = 12
        private val HEX_DIGITS = "0123456789abcdef".toCharArray()
        const val SUWAYOMI_DEFAULT_CATEGORY_ID = 0L
        const val REMOTE_TYPE_SUWAYOMI_MANGA = "SUWAYOMI_MANGA"

        fun SuwayomiCatalogOperation.acceptsId(id: Long): Boolean = when (this) {
            SuwayomiCatalogOperation.CATEGORIES -> id >= SUWAYOMI_DEFAULT_CATEGORY_ID
            SuwayomiCatalogOperation.LIBRARY,
            SuwayomiCatalogOperation.CHAPTERS,
            -> id > 0
        }

        fun serverMangaEntityId(credentials: CoreCredentialSession, mangaId: Long): String =
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) {
                "suwayomi:profile:${credentials.profileId}:manga:$mangaId"
            } else {
                "suwayomi:server:${credentials.serverId}:profile:${credentials.profileId}:manga:$mangaId"
            }

        fun serverCategoryEntityId(credentials: CoreCredentialSession, categoryId: Long): String =
            suwayomiServerCategoryEntityId(credentials.serverId, credentials.profileId, categoryId)

        fun thumbnailReference(credentials: CoreCredentialSession, mangaId: Long): String =
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) {
                SuwayomiCoreThumbnailReference.forManga(credentials.profileId, mangaId)
            } else {
                SuwayomiCoreThumbnailReference.forManga(
                    credentials.serverId,
                    credentials.profileId,
                    mangaId,
                )
            }

        fun resolveMangaEntityId(
            database: yokai.data.Database,
            credentials: CoreCredentialSession,
            mangaId: Long,
        ): String {
            val serverScoped = serverMangaEntityId(credentials, mangaId)
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) return serverScoped
            if (database.aethon_syncQueries.selectIdentityByEntityId(serverScoped).executeAsOneOrNull() != null) {
                return serverScoped
            }
            // A desktop identity can change across reinstalls or data resets. Works materialized
            // under the previous server id would otherwise be stranded on a dead reference (the
            // bridge refuses mismatched servers) while this sync creates a duplicate row. Rebind
            // the proven stale row to the current server and reuse it instead.
            rebindStaleServerIdentity(database, credentials, mangaId)
            val rebound = database.aethon_syncQueries
                .selectCoreRemoteIdentity(
                    credentials.serverId,
                    credentials.profileId,
                    REMOTE_TYPE_SUWAYOMI_MANGA,
                    mangaId.toString(),
                )
                .executeAsOneOrNull()
            if (
                rebound != null &&
                database.aethon_syncQueries.selectIdentityByEntityId(rebound.entity_id).executeAsOneOrNull() != null
            ) {
                return rebound.entity_id
            }
            val legacy = "suwayomi:profile:${credentials.profileId}:manga:$mangaId"
            val identity = database.aethon_syncQueries.selectIdentityByEntityId(legacy).executeAsOneOrNull()
                ?: return serverScoped
            val existingBinding = database.aethon_syncQueries
                .selectCoreRemoteIdentityByEntityId(legacy)
                .executeAsOneOrNull()
            if (existingBinding != null &&
                existingBinding.server_id != LEGACY_UNBOUND_SERVER_ID &&
                existingBinding.server_id != credentials.serverId
            ) {
                return serverScoped
            }
            val localId = identity.local_reference.toLongOrNull() ?: return serverScoped
            val local = database.mangasQueries.findById(localId).executeAsOneOrNull() ?: return serverScoped
            val reference = SuwayomiCoreContentReference.parseManga(local.url)
            if (
                local.source != EpigraphCoreSource.ID ||
                reference == null ||
                reference.serverId != null ||
                reference.profileId != credentials.profileId ||
                reference.mangaId != mangaId
            ) {
                return serverScoped
            }
            return legacy
        }

        /**
         * Rebinds a bridge work that still points at a previous Core server identity. Every
         * write requires double proof: the current catalog observes (profile, mangaId) AND the
         * local row is a bridge row whose URL parses to the same pair. Without both proofs
         * nothing is touched.
         */
        private fun rebindStaleServerIdentity(
            database: yokai.data.Database,
            credentials: CoreCredentialSession,
            mangaId: Long,
        ) {
            val currentServerId = credentials.serverId
            if (currentServerId == LEGACY_UNBOUND_SERVER_ID) return
            if (
                database.aethon_syncQueries.selectCoreRemoteIdentity(
                    currentServerId,
                    credentials.profileId,
                    REMOTE_TYPE_SUWAYOMI_MANGA,
                    mangaId.toString(),
                ).executeAsOneOrNull() != null
            ) {
                return
            }
            val candidate = database.aethon_syncQueries
                .selectStaleSuwayomiMangaBindings(
                    profileId = credentials.profileId,
                    remoteId = mangaId.toString(),
                    currentServerId = currentServerId,
                )
                .executeAsList()
                .firstOrNull { row ->
                    val localId = row.local_reference.toLongOrNull() ?: return@firstOrNull false
                    val manga = database.mangasQueries.findById(localId).executeAsOneOrNull()
                        ?: return@firstOrNull false
                    if (manga.source != EpigraphCoreSource.ID) return@firstOrNull false
                    val reference = SuwayomiCoreContentReference.parseManga(manga.url)
                        ?: return@firstOrNull false
                    reference.profileId == credentials.profileId && reference.mangaId == mangaId
                } ?: return
            val localId = candidate.local_reference.toLongOrNull() ?: return
            database.mangasQueries.update(
                source = null,
                url = SuwayomiCoreContentReference.forManga(currentServerId, credentials.profileId, mangaId),
                artist = null,
                author = null,
                description = null,
                genre = null,
                title = null,
                status = null,
                thumbnailUrl = null,
                favorite = null,
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
                memo = memoColumnAdapter.encode(JsonObject(emptyMap())),
                mangaId = localId,
            )
            database.aethon_syncQueries.upsertCoreRemoteIdentity(
                entityId = candidate.entity_id,
                serverId = currentServerId,
                profileId = credentials.profileId,
                remoteType = REMOTE_TYPE_SUWAYOMI_MANGA,
                remoteId = mangaId.toString(),
                bindingStatus = "BOUND",
                updatedAt = System.currentTimeMillis(),
            )
        }

        /**
         * Drops unbound remote categories whose exact name matches a phone category that
         * [SuwayomiCategoryCreateHook] will bind to them (now, or after a re-pair drops its binding). Materializing them first would leave two
         * local categories with the same name, and the hook then refuses the bind for good.
         */
        fun withoutCategoriesAwaitingBind(
            database: yokai.data.Database,
            credentials: CoreCredentialSession,
            categories: List<JsonObject>,
        ): List<JsonObject> {
            // After a re-pair, a folder with comics still bound to the previous server loses that
            // binding in this read's reconcile and is bound by name on the next run, so it waits too.
            val currentPrefix = "suwayomi:server:${credentials.serverId}:"
            val rebinding = database.aethon_syncQueries.selectCategoryIdentitiesByContentScope("MANGA")
                .executeAsList()
                .filter { identity ->
                    credentials.serverId != LEGACY_UNBOUND_SERVER_ID &&
                        identity.entity_id.startsWith("suwayomi:server:") &&
                        !identity.entity_id.startsWith(currentPrefix) &&
                        ":profile:${credentials.profileId}:category:" in identity.entity_id &&
                        database.aethon_syncQueries.folderHoldsComics(identity.local_category_id).executeAsOne()
                }
                .map { it.local_category_id }
                .toSet()
            val rebindingNames = database.categoriesQueries.findAll().executeAsList()
                .filter { it._id in rebinding }
                .map { it.name }
            val awaitingNames = (
                database.aethon_syncQueries.selectUnpublishedComicCategories().executeAsList().map { it.name } +
                    rebindingNames
                )
                .filterTo(HashSet(), SuwayomiCategoryCreateHook::isPublishableName)
            if (awaitingNames.isEmpty()) return categories
            return categories.filterNot { node ->
                val categoryId = node.long("id") ?: return@filterNot false
                val name = node.string("name") ?: return@filterNot false
                name in awaitingNames &&
                    database.aethon_syncQueries
                        .selectCategoryIdentityByEntityId(resolveCategoryEntityId(database, credentials, categoryId, name))
                        .executeAsOneOrNull() == null
            }
        }

        fun resolveCategoryEntityId(
            database: yokai.data.Database,
            credentials: CoreCredentialSession,
            categoryId: Long,
            remoteName: String? = null,
        ): String {
            val serverScoped = serverCategoryEntityId(credentials, categoryId)
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) return serverScoped
            val legacyId = "suwayomi:profile:${credentials.profileId}:category:$categoryId"
            val legacy = database.aethon_syncQueries.selectCategoryIdentityByEntityId(legacyId).executeAsOneOrNull()
            val current = database.aethon_syncQueries.selectCategoryIdentityByEntityId(serverScoped).executeAsOneOrNull()
            if (current != null) {
                mergeLegacyCategoryDuplicate(database, legacy, current)
                return serverScoped
            }
            if (legacy != null &&
                legacy.content_scope == "MANGA" &&
                remoteName != null &&
                legacy.name.trim().equals(remoteName.trim(), ignoreCase = true)
            ) {
                // The table is unique on (local_category_id, content_scope), so the legacy row must
                // go before the server-scoped row takes its place.
                database.aethon_syncQueries.deleteCategoryIdentity(legacyId)
                database.aethon_syncQueries.upsertCategoryIdentity(
                    entityId = serverScoped,
                    localCategoryId = legacy.local_category_id,
                    contentScope = legacy.content_scope,
                    name = legacy.name,
                    sortOrder = legacy.sort_order,
                    updatedAt = legacy.updated_at,
                )
                return serverScoped
            }
            // A legacy identity is adopted only when the same remote category id carries the same
            // name, the same proof `joinableFolder` uses to join folders by name.
            return serverScoped
        }

        private fun mergeLegacyCategoryDuplicate(
            database: yokai.data.Database,
            legacy: Aethon_category_identity?,
            current: Aethon_category_identity,
        ) {
            if (legacy == null) return
            if (legacy.content_scope != "MANGA" || current.content_scope != "MANGA") return
            if (legacy.local_category_id == current.local_category_id) return
            if (!legacy.name.trim().equals(current.name.trim(), ignoreCase = true)) return
            val from = legacy.local_category_id
            val to = current.local_category_id
            for (mangaId in database.aethon_syncQueries.selectMangaIdsByCategory(from).executeAsList()) {
                val kept = database.categoriesQueries.findAllByMangaId(mangaId).executeAsList()
                    .filter { it._id != from }
                    .map { it._id }
                    .distinct()
                database.mangas_categoriesQueries.delete(mangaId)
                kept.forEach { categoryId -> database.mangas_categoriesQueries.insert(mangaId, categoryId) }
                if (to !in kept) {
                    database.mangas_categoriesQueries.insert(mangaId, to)
                }
            }
            database.aethon_syncQueries.deleteCategoryIdentity(legacy.entity_id)
            if (database.aethon_syncQueries.selectCategoryIdentitiesByLocalId(from).executeAsList().isEmpty()) {
                database.categoriesQueries.delete(from)
            }
        }

        fun JsonObject.connectionNodes(operation: SuwayomiCatalogOperation): List<JsonObject> {
            val key = when (operation) {
                SuwayomiCatalogOperation.LIBRARY -> "mangas"
                SuwayomiCatalogOperation.CATEGORIES -> "categories"
                SuwayomiCatalogOperation.CHAPTERS -> "chapters"
            }
            return (this[key] as? JsonObject)?.get("nodes")
                .asJsonArray()
                ?.mapNotNull { it as? JsonObject }
                .orEmpty()
        }

        fun JsonObject.mangaNodes(): List<JsonObject> =
            (this["mangas"] as? JsonObject)?.get("nodes")
                .asJsonArray()
                ?.mapNotNull { it as? JsonObject }
                .orEmpty()

        fun JsonObject.with(key: String, value: String): JsonObject = buildJsonObject {
            forEach { (existingKey, existingValue) -> put(existingKey, existingValue) }
            put(key, value)
        }

        fun JsonObject.withIfPresent(key: String, value: String?): JsonObject =
            value?.let { with(key, it) } ?: this

        fun JsonObject.long(key: String): Long? =
            this[key]?.jsonPrimitive?.contentOrNull?.toLongOrNull()

        fun JsonObject.string(key: String): String? =
            this[key]?.jsonPrimitive?.contentOrNull

        fun JsonObject.boolean(key: String): Boolean? =
            this[key]?.jsonPrimitive?.booleanOrNull

        fun JsonElement?.asJsonArray(): JsonArray? = this as? JsonArray

    }
}

internal fun suwayomiServerCategoryEntityId(serverId: String, profileId: String, categoryId: Long): String =
    if (serverId == LEGACY_UNBOUND_SERVER_ID) {
        "suwayomi:profile:$profileId:category:$categoryId"
    } else {
        "suwayomi:server:$serverId:profile:$profileId:category:$categoryId"
    }

private fun CoreConfirmedRecord.comicId(): String? =
    (record as? JsonObject)?.get("comicId")?.jsonPrimitive?.contentOrNull

/** The last catalog fully applied for one Core profile, and the local library it left behind. */
/**
 * The last catalog applied to a local library. [appliedAt] is when every record was last written,
 * so a full apply still runs every [SuwayomiCatalogSync.REAPPLY_INTERVAL_MS]; [recordDigests] are
 * the records applied since, which a run over the same library does not write again.
 */
data class CatalogApplyStamp(
    val catalogDigest: String,
    val localSignature: String,
    val appliedAt: Long,
    val recordDigests: Set<String> = emptySet(),
) {
    fun covers(digest: String, signature: String, nowEpochMillis: Long): Boolean =
        catalogDigest == digest && unchangedRecords(signature, nowEpochMillis) != null

    fun unchangedRecords(signature: String, nowEpochMillis: Long): Set<String>? =
        recentRecords(nowEpochMillis)?.takeIf { localSignature == signature }

    /** The records applied since the last full apply, whatever the local library looks like now. */
    fun recentRecords(nowEpochMillis: Long): Set<String>? = recordDigests.takeIf {
        nowEpochMillis - appliedAt in 0 until SuwayomiCatalogSync.REAPPLY_INTERVAL_MS
    }
}

/** Replaceable cache of [CatalogApplyStamp]s; losing it only costs one full apply. */
interface CatalogApplyStampStore {
    fun get(key: String): CatalogApplyStamp?
    fun put(key: String, stamp: CatalogApplyStamp)
    fun remove(key: String)
}

class SharedPreferencesCatalogApplyStampStore(context: Context) : CatalogApplyStampStore {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    override fun get(key: String): CatalogApplyStamp? {
        val parts = preferences.getString(key, null)?.split('\n') ?: return null
        if (parts.size != 3) return null
        val records = preferences.getString(key + RECORDS_SUFFIX, null)
            ?.split(',')
            ?.filterTo(HashSet()) { it.isNotEmpty() }
            .orEmpty()
        return CatalogApplyStamp(parts[1], parts[2], parts[0].toLongOrNull() ?: return null, records)
    }

    override fun put(key: String, stamp: CatalogApplyStamp) {
        preferences.edit()
            .putString(key, "${stamp.appliedAt}\n${stamp.catalogDigest}\n${stamp.localSignature}")
            .putString(key + RECORDS_SUFFIX, stamp.recordDigests.joinToString(","))
            .apply()
    }

    override fun remove(key: String) {
        preferences.edit().remove(key).remove(key + RECORDS_SUFFIX).apply()
    }

    private companion object {
        const val PREFERENCES = "epigraph_core_catalog_apply"
        const val RECORDS_SUFFIX = "#records"
    }
}

/** Desktop Suwayomi projection readiness for a comics scope; null when the Core cannot report it. */
fun interface SuwayomiProjectionStatusSource {
    suspend fun status(session: CoreCredentialSession, scopeId: String): CoreHttpResult<CoreSyncStatus>?
}

object UnavailableSuwayomiProjectionStatusSource : SuwayomiProjectionStatusSource {
    override suspend fun status(session: CoreCredentialSession, scopeId: String): CoreHttpResult<CoreSyncStatus>? =
        null
}

class CoreSuwayomiProjectionStatusSource(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
) : SuwayomiProjectionStatusSource {
    override suspend fun status(session: CoreCredentialSession, scopeId: String): CoreHttpResult<CoreSyncStatus> {
        val endpoint = runCatching { endpoints.resolve(session).origin }.getOrElse {
            return CoreHttpResult.Failure(503, null)
        }
        val http = transports.create(session, endpoint).http
        return session.withAccessTokenString { token -> http.syncStatus(token, scopeId) }
    }
}

fun interface SuwayomiCatalogPageSource {
    suspend fun read(
        session: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        pageSize: Long,
        offset: Long,
        mangaId: Long?,
    ): CoreHttpResult<SuwayomiCatalogResponse>
}

class CoreSuwayomiCatalogPageSource(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
) : SuwayomiCatalogPageSource {
    override suspend fun read(
        session: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        pageSize: Long,
        offset: Long,
        mangaId: Long?,
    ): CoreHttpResult<SuwayomiCatalogResponse> {
        val endpoint = runCatching { endpoints.resolve(session).origin }.getOrElse {
            return CoreHttpResult.Failure(503, null)
        }
        return transports.create(session, endpoint).suwayomi.catalog(
            session = session,
            operation = operation,
            pageSize = pageSize,
            offset = offset,
            mangaId = mangaId,
        )
    }
}
