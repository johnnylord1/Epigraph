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
import android.util.Log
import eu.kanade.tachiyomi.BuildConfig
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
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
        // own favorite or category change, so retry instead of reconciling against it.
        if (EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) {
            when (val status = projectionStatus.status(credentials, scopeId)) {
                null -> Unit
                is CoreHttpResult.Success ->
                    if (status.value.remoteProjectionState() == CoreRemoteProjectionState.IN_PROGRESS) {
                        return CoreReplicaSyncOutcome.RETRY
                    }
                is CoreHttpResult.Failure -> return CoreReplicaSyncOutcome.RETRY
            }
        }

        val library = try {
            fetchAll(credentials, SuwayomiCatalogOperation.LIBRARY)
        } catch (failure: CatalogSyncFailure) {
            reportCatalogFailure(SuwayomiCatalogOperation.LIBRARY, failure)
            return failure.outcome()
        }
        val categories = try {
            fetchAll(credentials, SuwayomiCatalogOperation.CATEGORIES)
        } catch (failure: CatalogSyncFailure) {
            reportCatalogFailure(SuwayomiCatalogOperation.CATEGORIES, failure)
            return failure.outcome()
        }.filterNot { node -> node.long("id") == SUWAYOMI_DEFAULT_CATEGORY_ID }

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
                    categoryId to resolveCategoryEntityId(this, credentials, categoryId)
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

        // Applying only after both complete reads protects the local library from partial pages.
        // Reconciliation is intentionally limited to the authoritative library bit; local
        // metadata, chapters, progress and assets remain recoverable after an un-favorite.
        database.await(inTransaction = true) {
            // Titles with local work still in flight keep their local library bit and category
            // links; the next catalog read after that work settles reconciles them.
            val protectedEntityIds = aethon_syncQueries
                .selectUnsettledSuwayomiComicEntityIds(scopeId, credentials.profileId)
                .executeAsList()
                .toHashSet()
            mangaRecords
                .filterNot { it.key.entityId in protectedEntityIds }
                .forEach { record -> projection.upsert(this, record) }
            categoryRecords.forEach { record -> projection.upsert(this, record) }
            assignmentRecords
                .filterNot { record -> record.comicId() in protectedEntityIds }
                .forEach { record -> projection.upsert(this, record) }
            projection.reconcileSuwayomiLibrary(
                database = this,
                serverId = credentials.serverId,
                profileId = credentials.profileId,
                observedEntityIds = mangaRecords.mapTo(mutableSetOf()) { it.key.entityId },
                protectedEntityIds = protectedEntityIds,
            )
            projection.reconcileSuwayomiCategoryAssignments(
                database = this,
                serverId = credentials.serverId,
                profileId = credentials.profileId,
                observedCategoryEntityIds = categoryRecords.mapTo(mutableSetOf()) { it.key.entityId },
                observedAssignments = assignmentRecords.mapTo(mutableSetOf()) { record ->
                    val payload = record.record as JsonObject
                    payload.getValue("comicId").jsonPrimitive.content to
                        payload.getValue("categoryId").jsonPrimitive.content
                },
                protectedEntityIds = protectedEntityIds,
            )
        }

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

    private suspend fun fetchAll(
        credentials: CoreCredentialSession,
        operation: SuwayomiCatalogOperation,
        mangaId: Long? = null,
    ): List<JsonObject> {
        val nodes = ArrayList<JsonObject>()
        val observedIds = HashSet<Long>()
        var expectedTotal: Long? = null
        var offset = 0L
        var hasNext = true
        while (hasNext) {
            if (nodes.size >= MAX_ITEMS) throw CatalogSyncFailure.Protocol(ProtocolFailure.MAX_ITEMS)
            val response = when (
                val result = pages.read(
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
            if (expectedTotal == null) expectedTotal = total
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
        if (nodes.size.toLong() != expectedTotal) {
            throw CatalogSyncFailure.Protocol(ProtocolFailure.COUNT_MISMATCH)
        }
        return nodes
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

    private companion object {
        const val SUPPORTED_SCHEMA_VERSION = 1
        const val DEFAULT_PAGE_SIZE = 100L
        const val MAX_PAGE_SIZE = 250L
        const val MAX_ITEMS = 50_000
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
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) {
                "suwayomi:profile:${credentials.profileId}:category:$categoryId"
            } else {
                "suwayomi:server:${credentials.serverId}:profile:${credentials.profileId}:category:$categoryId"
            }

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

        fun resolveCategoryEntityId(
            database: yokai.data.Database,
            credentials: CoreCredentialSession,
            categoryId: Long,
        ): String {
            val serverScoped = serverCategoryEntityId(credentials, categoryId)
            if (credentials.serverId == LEGACY_UNBOUND_SERVER_ID) return serverScoped
            if (database.aethon_syncQueries.selectCategoryIdentityByEntityId(serverScoped).executeAsOneOrNull() != null) {
                return serverScoped
            }
            // V1 category identities contain no server proof. Keep them as legacy_unbound instead
            // of silently assigning a category from another paired desktop with the same profile.
            return serverScoped
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

        fun JsonElement?.asJsonArray(): JsonArray? = this as? JsonArray

    }
}

private fun CoreConfirmedRecord.comicId(): String? =
    (record as? JsonObject)?.get("comicId")?.jsonPrimitive?.contentOrNull

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
