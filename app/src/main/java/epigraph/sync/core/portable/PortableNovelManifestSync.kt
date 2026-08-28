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
        val bootstrapId = "portable-v3:${credentials.serverId}:${credentials.profileId}:novels"
        val previousBootstrap = database.await(inTransaction = false) {
            SqlDelightPortableBootstrapStore(this)
                .load(credentials.serverId, credentials.profileId, PortableEcosystem.LNREADER)
        }
        val resumeCursor = previousBootstrap
            ?.takeIf { it.phase == PortableBootstrapPhase.RECEIVING_MANIFEST }
            ?.currentItem
            ?.let(::decodeCursor)
        val attemptCount = previousBootstrap?.attemptCount?.plus(1) ?: 1
        checkpoint(
            credentials,
            bootstrapId,
            PortableBootstrapPhase.NEGOTIATING,
            attemptCount,
            nowEpochMillis,
            currentItem = resumeCursor?.let(::encodeCursor),
        )
        val endpoint = try {
            endpoints.resolve(credentials).origin
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return CoreReplicaSyncOutcome.RETRY
        }
        checkpoint(
            credentials,
            bootstrapId,
            PortableBootstrapPhase.RECEIVING_MANIFEST,
            attemptCount,
            nowEpochMillis,
            currentItem = resumeCursor?.let(::encodeCursor),
        )
        val http = transports.create(credentials, endpoint).http
        var offset = resumeCursor?.nextOffset ?: 0L
        var expectedTotal = resumeCursor?.totalCount
        var expectedFingerprint = resumeCursor?.manifestFingerprint
        var expectedSnapshotId = resumeCursor?.snapshotId
        var expectedSnapshotFingerprint = resumeCursor?.snapshotFingerprint
        var observedCount = resumeCursor?.observedCount ?: 0L
        var omittedCount = resumeCursor?.omittedCount ?: 0L
        val observedAt = resumeCursor?.observedAt ?: nowEpochMillis
        do {
            if (observedCount >= MAX_WORKS) {
                return CoreReplicaSyncOutcome.RETRY
            }
            val response = credentials.withAccessTokenString { accessToken ->
                http.portableNovelManifest(
                    accessToken,
                    credentials.profileId,
                    pageSize,
                    offset,
                    expectedSnapshotId,
                    expectedSnapshotFingerprint,
                )
            }
            val page = when (response) {
                is CoreHttpResult.Success -> response.value
                is CoreHttpResult.Failure -> {
                    if (offset > 0 && response.isExpiredSnapshot) {
                        checkpoint(
                            credentials,
                            bootstrapId,
                            PortableBootstrapPhase.RECEIVING_MANIFEST,
                            attemptCount,
                            nowEpochMillis,
                            currentItem = null,
                            lastReason = response.errorEnvelope?.error?.code,
                        )
                    }
                    return response.toOutcome()
                }
            }
            if (
                page.scopeId != scopeId ||
                page.page.offset != offset ||
                page.page.pageSize != pageSize ||
                page.works.size.toLong() + page.page.omittedCount > pageSize
            ) {
                return CoreReplicaSyncOutcome.RETRY
            }
            if (expectedTotal == null) expectedTotal = page.page.totalCount
            if (expectedFingerprint == null) expectedFingerprint = page.manifestFingerprint
            if (expectedSnapshotId == null) expectedSnapshotId = page.snapshotId
            if (expectedSnapshotFingerprint == null) expectedSnapshotFingerprint = page.snapshotFingerprint
            if (
                expectedTotal != page.page.totalCount ||
                expectedFingerprint != page.manifestFingerprint ||
                expectedSnapshotId != page.snapshotId ||
                expectedSnapshotFingerprint != page.snapshotFingerprint
            ) {
                return CoreReplicaSyncOutcome.RETRY
            }
            val sourceItemCount = page.works.size.toLong() + page.page.omittedCount
            val observedEnd = offset + sourceItemCount
            if (
                observedEnd > page.page.totalCount ||
                (page.page.hasNextPage && sourceItemCount == 0L) ||
                (!page.page.hasNextPage && observedEnd != page.page.totalCount)
            ) {
                return CoreReplicaSyncOutcome.RETRY
            }
            if (!persistPage(credentials, page, observedAt, nowEpochMillis)) {
                return CoreReplicaSyncOutcome.RETRY
            }
            observedCount += sourceItemCount
            omittedCount += page.page.omittedCount
            if (page.page.hasNextPage) {
                val next = offset + pageSize
                if (next <= offset || next > Int.MAX_VALUE) return CoreReplicaSyncOutcome.RETRY
                offset = next
                checkpoint(
                    credentials,
                    bootstrapId,
                    PortableBootstrapPhase.RECEIVING_MANIFEST,
                    attemptCount,
                    nowEpochMillis,
                    manifestFingerprint = expectedSnapshotFingerprint,
                    currentItem = encodeCursor(
                        ManifestCursor(
                            snapshotId = requireNotNull(expectedSnapshotId),
                            snapshotFingerprint = requireNotNull(expectedSnapshotFingerprint),
                            manifestFingerprint = requireNotNull(expectedFingerprint),
                            nextOffset = offset,
                            totalCount = requireNotNull(expectedTotal),
                            observedCount = observedCount,
                            omittedCount = omittedCount,
                            observedAt = observedAt,
                        ),
                    ),
                )
            }
        } while (page.page.hasNextPage)

        if (observedCount != expectedTotal) return CoreReplicaSyncOutcome.RETRY
        checkpoint(
            credentials,
            bootstrapId,
            PortableBootstrapPhase.IMPORTING_REFERENCES,
            attemptCount,
            nowEpochMillis,
            manifestFingerprint = expectedFingerprint,
        )
        database.await(inTransaction = true) {
            aethon_syncQueries.deleteStalePortableManifestMembershipsForEcosystem(
                serverId = credentials.serverId,
                profileId = credentials.profileId,
                observedAt = observedAt,
                ecosystem = PortableEcosystem.LNREADER.name,
            )
        }
        checkpoint(
            credentials,
            bootstrapId,
            PortableBootstrapPhase.RESOLVING_DEPENDENCIES,
            attemptCount,
            nowEpochMillis,
            manifestFingerprint = expectedFingerprint,
        )
        var hydrationReport: PortableHydrationReport? = null
        try {
            if (hydration != null) {
                checkpoint(
                    credentials,
                    bootstrapId,
                    PortableBootstrapPhase.HYDRATING_LIBRARY,
                    attemptCount,
                    nowEpochMillis,
                    manifestFingerprint = expectedFingerprint,
                )
                hydrationReport = hydration.hydrate(credentials.serverId, credentials.profileId, nowEpochMillis)
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return CoreReplicaSyncOutcome.RETRY
        }
        val requiresUserAction = (hydrationReport?.dependenciesRequiringUserAction ?: 0) > 0
        val hydrationComplete = hydrationReport == null ||
            (hydrationReport.pendingWorks == 0 && hydrationReport.pendingChapters == 0 && !requiresUserAction)
        val phase = if (omittedCount == 0L && hydrationComplete) {
            PortableBootstrapPhase.COMPLETED
        } else {
            PortableBootstrapPhase.PARTIAL
        }
        checkpoint(
            credentials,
            bootstrapId,
            phase,
            attemptCount,
            nowEpochMillis,
            manifestFingerprint = expectedFingerprint,
            lastReason = if (requiresUserAction) {
                PortableBootstrapPhase.WAITING_TRUST.name
            } else if (omittedCount > 0) {
                PortableResolutionReason.WORK_RESOLUTION_UNSUPPORTED.name
            } else {
                null
            },
        )
        return CoreReplicaSyncOutcome.APPLIED
    }

    private suspend fun checkpoint(
        credentials: CoreCredentialSession,
        bootstrapId: String,
        phase: PortableBootstrapPhase,
        attemptCount: Long,
        updatedAt: Long,
        manifestFingerprint: String? = null,
        currentItem: String? = null,
        lastReason: String? = null,
    ) {
        database.await(inTransaction = true) {
            SqlDelightPortableBootstrapStore(this).upsert(
                PortableBootstrapRecord(
                    serverId = credentials.serverId,
                    profileId = credentials.profileId,
                    ecosystem = PortableEcosystem.LNREADER,
                    bootstrapId = bootstrapId,
                    phase = phase,
                    manifestFingerprint = manifestFingerprint,
                    currentItem = currentItem,
                    attemptCount = attemptCount,
                    lastReason = lastReason,
                    updatedAt = updatedAt,
                ),
            )
        }
    }

    private suspend fun persistPage(
        credentials: CoreCredentialSession,
        page: CorePortableNovelManifest,
        observedAt: Long,
        updatedAt: Long,
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
        true
    }

    private fun encodeCursor(cursor: ManifestCursor): String = Json.encodeToString(ManifestCursor.serializer(), cursor)

    private fun decodeCursor(value: String): ManifestCursor? =
        runCatching { Json.decodeFromString(ManifestCursor.serializer(), value) }.getOrNull()

    private fun CoreHttpResult.Failure.toOutcome(): CoreReplicaSyncOutcome =
        if (errorEnvelope?.error?.code == "CLIENT_RESPONSE_UNSUPPORTED") {
            CoreReplicaSyncOutcome.DEFERRED
        } else if (statusCode == 401 || statusCode == 403) {
            CoreReplicaSyncOutcome.NEEDS_USER_ACTION
        } else if (statusCode == 408 || statusCode == 425 || statusCode == 429 || statusCode >= 500) {
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
    )

    private companion object {
        const val DEFAULT_PAGE_SIZE = 100L
        const val MAX_PAGE_SIZE = 250L
        const val MAX_WORKS = 50_000L
    }
}
