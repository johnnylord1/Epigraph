package epigraph.sync.core.portable

import epigraph.contract.NovelDependency
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CorePortableNovelManifest
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.portable.PortableNovelDependencyRecord
import epigraph.sync.portable.PortableBootstrapPhase
import epigraph.sync.portable.PortableBootstrapRecord
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBootstrapStore
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.SqlDelightPortableDependencyStore
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import yokai.data.Database
import yokai.data.DatabaseHandler

/** Imports only portable LNReader identities; provider metadata remains reconstructible locally. */
class PortableNovelManifestSync(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
    private val database: DatabaseHandler,
    private val hydration: PortableHydrationCoordinator? = null,
    private val pageSize: Long = DEFAULT_PAGE_SIZE,
) : CoreReplicaSyncPort {
    init {
        require(pageSize in 1..MAX_PAGE_SIZE)
    }

    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        if (!capabilities.supportsPortableSyncV3) return CoreReplicaSyncOutcome.DEFERRED
        val scopeId = "novels:profile:${credentials.profileId}"
        if (scopeId !in credentials.scopes) return CoreReplicaSyncOutcome.DEFERRED
        val previous = database.await(inTransaction = false) {
            SqlDelightPortableBootstrapStore(this)
                .load(credentials.serverId, credentials.profileId, PortableEcosystem.LNREADER)
        }
        var cursor = previous
            ?.takeIf { it.phase == PortableBootstrapPhase.RECEIVING_MANIFEST }
            ?.currentItem
            ?.let(::decodeCursor)
            ?.takeIf {
                it.nextOffset in 1 until it.totalCount && it.observedCount == it.nextOffset &&
                    localManifestIsIntact(credentials, it.observedAt, it.nextOffset)
            }
        val completed = previous
            ?.takeIf { it.phase in COMPLETE_MANIFEST_PHASES }
            ?.currentItem
            ?.let(::decodeCompletion)
            ?.takeIf {
                it.revision.isManifestRevision() &&
                    localManifestIsIntact(credentials, it.observedAt, it.workCount)
            }
        val observedAt = cursor?.observedAt
            ?: maxOf(nowEpochMillis, (previous?.updatedAt ?: 0) + 1)
        val progress = PortableBootstrapRecord(
            serverId = credentials.serverId,
            profileId = credentials.profileId,
            ecosystem = PortableEcosystem.LNREADER,
            bootstrapId = "portable-v3:${credentials.serverId}:${credentials.profileId}:novels",
            phase = PortableBootstrapPhase.RECEIVING_MANIFEST,
            attemptCount = (previous?.attemptCount ?: 0) + 1,
            updatedAt = maxOf(observedAt, nowEpochMillis),
        )
        val endpoint = try {
            endpoints.resolve(credentials).origin
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return CoreReplicaSyncOutcome.RETRY
        }
        val http = transports.create(credentials, endpoint).http
        while (true) {
            val offset = cursor?.nextOffset ?: 0
            if (offset >= MAX_WORKS) return CoreReplicaSyncOutcome.RETRY
            val response = credentials.withAccessTokenString { accessToken ->
                http.portableNovelManifest(
                    accessToken,
                    credentials.profileId,
                    pageSize,
                    offset,
                    cursor?.snapshotId,
                    cursor?.snapshotFingerprint,
                    ifNoneMatch = completed?.takeIf { offset == 0L }?.revision,
                )
            }
            val result = when (response) {
                is CoreHttpResult.Success -> response
                is CoreHttpResult.Failure -> {
                    if (response.statusCode == 304 && offset == 0L && completed != null) {
                        if (!localManifestIsIntact(credentials, completed.observedAt, completed.workCount)) {
                            return CoreReplicaSyncOutcome.RETRY
                        }
                        return hydrateAndFinish(
                            progress.copy(
                                phase = PortableBootstrapPhase.PARTIAL,
                                manifestFingerprint = previous.manifestFingerprint,
                                currentItem = encodeCompletion(completed),
                            ),
                            omittedCount = 0,
                            nowEpochMillis = nowEpochMillis,
                        )
                    }
                    if (offset > 0 && response.isExpiredSnapshot) {
                        saveCheckpoint(progress.copy(lastReason = response.errorEnvelope?.error?.code))
                        return CoreReplicaSyncOutcome.RETRY
                    }
                    return response.toOutcome()
                }
            }
            val page = result.value
            val revision = result.etag?.takeIf { it.isManifestRevision() }
            if (
                page.scopeId != scopeId ||
                page.page.offset != offset ||
                page.page.pageSize != pageSize ||
                page.page.totalCount !in 0..MAX_WORKS ||
                (cursor != null && (
                    cursor.totalCount != page.page.totalCount ||
                        cursor.manifestFingerprint != page.manifestFingerprint ||
                        cursor.snapshotId != page.snapshotId ||
                        cursor.snapshotFingerprint != page.snapshotFingerprint ||
                        (cursor.revision != null && cursor.revision != revision)
                    ))
            ) return CoreReplicaSyncOutcome.RETRY

            // The snapshot offsets count the published works. Omissions are reported separately.
            val itemCount = page.works.size.toLong()
            val end = offset + itemCount
            if (
                itemCount > pageSize ||
                end > page.page.totalCount ||
                (page.page.hasNextPage && (itemCount != pageSize || end >= page.page.totalCount)) ||
                (!page.page.hasNextPage && end != page.page.totalCount)
            ) return CoreReplicaSyncOutcome.RETRY
            val omittedCount = (cursor?.omittedCount ?: 0) + page.page.omittedCount
            val next = if (page.page.hasNextPage) {
                ManifestCursor(
                    snapshotId = page.snapshotId,
                    snapshotFingerprint = page.snapshotFingerprint,
                    manifestFingerprint = page.manifestFingerprint,
                    nextOffset = end,
                    totalCount = page.page.totalCount,
                    observedCount = end,
                    omittedCount = omittedCount,
                    observedAt = observedAt,
                    revision = revision,
                )
            } else {
                null
            }
            val completion = revision?.takeIf { next == null && omittedCount == 0L }?.let {
                ManifestCompletion(it, observedAt, page.page.totalCount)
            }
            val checkpoint = progress.copy(
                phase = if (next == null) PortableBootstrapPhase.HYDRATING_LIBRARY else progress.phase,
                manifestFingerprint = page.manifestFingerprint,
                currentItem = next?.let(::encodeCursor) ?: completion?.let(::encodeCompletion),
            )
            val prune = next == null && omittedCount == 0L
            val persisted = try {
                persistPage(credentials, page, observedAt, nowEpochMillis, checkpoint, prune)
            } catch (_: IncompleteManifest) {
                saveCheckpoint(progress)
                false
            }
            if (!persisted) {
                return CoreReplicaSyncOutcome.RETRY
            }
            if (next == null) return hydrateAndFinish(checkpoint, omittedCount, nowEpochMillis)
            cursor = next
        }
    }

    private suspend fun hydrateAndFinish(
        checkpoint: PortableBootstrapRecord,
        omittedCount: Long,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        val report = try {
            hydration?.hydrate(checkpoint.serverId, checkpoint.profileId, nowEpochMillis)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return CoreReplicaSyncOutcome.RETRY
        }
        val requiresUserAction = (report?.dependenciesRequiringUserAction ?: 0) > 0
        val hydrationComplete = report == null ||
            (report.pendingWorks == 0 && report.pendingChapters == 0 && !report.chaptersRemaining && !requiresUserAction)
        val phase = if (omittedCount == 0L && hydrationComplete) {
            PortableBootstrapPhase.COMPLETED
        } else {
            PortableBootstrapPhase.PARTIAL
        }
        saveCheckpoint(
            checkpoint.copy(
                phase = phase,
                lastReason = when {
                    requiresUserAction -> PortableBootstrapPhase.WAITING_TRUST.name
                    omittedCount > 0 -> PortableResolutionReason.WORK_RESOLUTION_UNSUPPORTED.name
                    else -> null
                },
            ),
        )
        return CoreReplicaSyncOutcome.APPLIED
    }

    private suspend fun saveCheckpoint(checkpoint: PortableBootstrapRecord) {
        database.await(inTransaction = true) { SqlDelightPortableBootstrapStore(this).upsert(checkpoint) }
    }

    private suspend fun localManifestIsIntact(
        credentials: CoreCredentialSession,
        observedAt: Long,
        expectedWorks: Long,
    ): Boolean = database.await(inTransaction = false) {
        completeMembershipCount(credentials, observedAt) == expectedWorks
    }

    private fun Database.completeMembershipCount(credentials: CoreCredentialSession, observedAt: Long): Long =
        aethon_syncQueries.countCompleteNovelManifestMemberships(
            credentials.serverId,
            credentials.profileId,
            observedAt,
        ).executeAsOne()

    private suspend fun persistPage(
        credentials: CoreCredentialSession,
        page: CorePortableNovelManifest,
        observedAt: Long,
        updatedAt: Long,
        checkpoint: PortableBootstrapRecord,
        prune: Boolean,
    ): Boolean = database.await(inTransaction = true) {
        val dependenciesByPlugin = page.novelDependencies.associateBy(NovelDependency::pluginId)
        if (dependenciesByPlugin.size != page.novelDependencies.size) return@await false
        if (page.works.map { it.portableId }.distinct().size != page.works.size) return@await false
        if (!page.works.all { work ->
            work.portableId == PortableIdentityV3.workId(work.reference) &&
                work.dependencyPluginId == work.reference.pluginId &&
                work.dependencyPluginId in dependenciesByPlugin
        }) return@await false
        val bindingStore = SqlDelightPortableBindingStore(this)
        val dependencyStore = SqlDelightPortableDependencyStore(this)
        val existingDependencies = dependencyStore.novels(credentials.serverId, credentials.profileId)
            .associateBy { it.dependency.pluginId }
        page.novelDependencies.forEach { dependency ->
            val existing = existingDependencies[dependency.pluginId]
            val trustState = portableDependencyTrustState(
                existingProvenanceUrl = existing?.dependency?.repository?.indexUrl,
                existingTrustState = existing?.trustState,
                incomingProvenanceUrl = dependency.repository?.indexUrl,
            )
            dependencyStore.upsertNovel(
                PortableNovelDependencyRecord(
                    credentials.serverId,
                    credentials.profileId,
                    dependency,
                    trustState,
                    PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
                    updatedAt,
                ),
            )
        }
        page.works.forEach { work ->
            val existing = bindingStore.work(work.reference)
            val unchanged = existing?.takeIf { it.dependencyKey == work.dependencyPluginId }
            bindingStore.upsertWork(
                PortableWorkBindingRecord(
                    portableId = work.portableId,
                    ref = work.reference,
                    dependencyKey = work.dependencyPluginId,
                    localReference = existing?.localReference,
                    resolution = unchanged?.resolution
                        ?: PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
                    titleHint = work.titleHint,
                    providerLabelHint = work.providerLabelHint,
                    attemptCount = unchanged?.attemptCount ?: 0,
                    updatedAt = unchanged?.updatedAt ?: updatedAt,
                ),
            )
            bindingStore.markManifestMembership(
                credentials.serverId,
                credentials.profileId,
                work.portableId,
                observedAt,
            )
        }
        if (!page.page.hasNextPage && completeMembershipCount(credentials, observedAt) != page.page.totalCount) {
            // Roll back the last page and restart without pruning an incomplete generation.
            throw IncompleteManifest()
        }
        if (prune) {
            aethon_syncQueries.deleteStalePortableManifestMembershipsForEcosystem(
                serverId = credentials.serverId,
                profileId = credentials.profileId,
                observedAt = observedAt,
                ecosystem = PortableEcosystem.LNREADER.name,
            )
        }
        SqlDelightPortableBootstrapStore(this).upsert(checkpoint)
        true
    }

    private fun encodeCompletion(completion: ManifestCompletion): String =
        Json.encodeToString(ManifestCompletion.serializer(), completion)

    private fun decodeCompletion(value: String): ManifestCompletion? =
        runCatching { Json.decodeFromString(ManifestCompletion.serializer(), value) }.getOrNull()

    private fun String.isManifestRevision(): Boolean = MANIFEST_REVISION.matches(this)

    private fun encodeCursor(cursor: ManifestCursor): String = Json.encodeToString(ManifestCursor.serializer(), cursor)

    private fun decodeCursor(value: String): ManifestCursor? =
        runCatching { Json.decodeFromString(ManifestCursor.serializer(), value) }.getOrNull()

    private fun CoreHttpResult.Failure.toOutcome(): CoreReplicaSyncOutcome =
        if (errorEnvelope?.error?.code == "CLIENT_RESPONSE_UNSUPPORTED") {
            CoreReplicaSyncOutcome.DEFERRED
        } else if (statusCode == 401 || statusCode == 403) {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        } else if (
            errorEnvelope?.error?.code == "PORTABLE_MANIFEST_SOURCE_CHANGED" ||
            statusCode == 408 || statusCode == 425 || statusCode == 429 || statusCode >= 500
        ) {
            CoreReplicaSyncOutcome.RETRY
        } else {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        }

    private val CoreHttpResult.Failure.isExpiredSnapshot: Boolean
        get() = errorEnvelope?.error?.code in setOf(
            "PORTABLE_MANIFEST_SNAPSHOT_EXPIRED",
            "PORTABLE_MANIFEST_SNAPSHOT_INVALID",
        )

    @Serializable
    private data class ManifestCursor(
        val snapshotId: String,
        val snapshotFingerprint: String,
        val manifestFingerprint: String,
        val nextOffset: Long,
        val totalCount: Long,
        val observedCount: Long,
        val omittedCount: Long,
        val observedAt: Long,
        val revision: String? = null,
    )

    @Serializable
    private data class ManifestCompletion(val revision: String, val observedAt: Long, val workCount: Long)

    private class IncompleteManifest : RuntimeException()

    private companion object {
        val MANIFEST_REVISION = Regex("W/\"novels-v1-[0-9a-f]{64}\"")
        val COMPLETE_MANIFEST_PHASES = setOf(
            PortableBootstrapPhase.HYDRATING_LIBRARY,
            PortableBootstrapPhase.COMPLETED,
            PortableBootstrapPhase.PARTIAL,
        )
        const val DEFAULT_PAGE_SIZE = 100L
        const val MAX_PAGE_SIZE = 250L
        const val MAX_WORKS = 50_000L
    }
}
