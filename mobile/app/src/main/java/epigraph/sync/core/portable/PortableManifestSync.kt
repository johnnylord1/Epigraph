package epigraph.sync.core.portable

import android.util.Log
import epigraph.contract.ComicDependency
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableEcosystem
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CorePortableManifest
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.portable.PortableComicDependencyRecord
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

/**
 * Imports portable provider references without projecting them into the Epigraph Library.
 *
 * V2 remains responsible for the current UI while the V3 dependency graph resolves. Each page is
 * committed with a resumable snapshot cursor, but stale memberships are removed only after the
 * complete immutable snapshot has been received.
 */
class PortableManifestSync(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
    private val database: DatabaseHandler,
    private val hydration: PortableHydrationCoordinator? = null,
    private val pageSize: Long = DEFAULT_PAGE_SIZE,
) : CoreReplicaSyncPort {
    init {
        require(pageSize in 1..MAX_PAGE_SIZE) { "portable manifest page size is outside the Core limit" }
    }

    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        require(nowEpochMillis >= 0) { "sync timestamp must not be negative" }
        if (!capabilities.supportsPortableSyncV3) return CoreReplicaSyncOutcome.DEFERRED
        val scopeId = "comics:profile:${credentials.profileId}"
        if (scopeId !in credentials.scopes) return CoreReplicaSyncOutcome.DEFERRED
        val bootstrapId = "portable-v3:${credentials.serverId}:${credentials.profileId}:comics"
        val previousBootstrap = database.await(inTransaction = false) {
            SqlDelightPortableBootstrapStore(this)
                .load(credentials.serverId, credentials.profileId, PortableEcosystem.SUWAYOMI)
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
        } catch (error: Throwable) {
            Log.w(LOG_TAG, "portable manifest endpoint failed: ${error::class.simpleName}")
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
        var expectedFingerprint = resumeCursor?.runtimeFingerprint
        var expectedSnapshotId = resumeCursor?.snapshotId
        var expectedSnapshotFingerprint = resumeCursor?.snapshotFingerprint
        var observedCount = resumeCursor?.observedCount ?: 0L
        var omittedCount = resumeCursor?.omittedCount ?: 0L
        val observedAt = resumeCursor?.observedAt ?: nowEpochMillis
        var hasNext = true
        while (hasNext) {
            if (observedCount >= MAX_WORKS) {
                return CoreReplicaSyncOutcome.RETRY
            }
            val response = credentials.withAccessTokenString { accessToken ->
                http.portableManifest(
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
                    Log.w(
                        LOG_TAG,
                        "portable manifest request failed: status=${response.statusCode} " +
                            "code=${response.errorEnvelope?.error?.code ?: "none"}",
                    )
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
                        // The cursor was dropped, so the next attempt starts a fresh snapshot.
                        return CoreReplicaSyncOutcome.RETRY
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
            if (expectedFingerprint == null) expectedFingerprint = page.runtimeFingerprint
            if (expectedSnapshotId == null) expectedSnapshotId = page.snapshotId
            if (expectedSnapshotFingerprint == null) expectedSnapshotFingerprint = page.snapshotFingerprint
            if (
                expectedTotal != page.page.totalCount ||
                expectedFingerprint != page.runtimeFingerprint ||
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
            if (page.snapshotExpiresAtMs <= page.generatedAtMs) return CoreReplicaSyncOutcome.RETRY
            if (!persistPage(credentials, page, observedAt, nowEpochMillis)) {
                return CoreReplicaSyncOutcome.RETRY
            }
            observedCount += sourceItemCount
            omittedCount += page.page.omittedCount
            hasNext = page.page.hasNextPage
            if (hasNext) {
                val nextOffset = offset + pageSize
                if (nextOffset <= offset || nextOffset > Int.MAX_VALUE) return CoreReplicaSyncOutcome.RETRY
                offset = nextOffset
                val cursor = ManifestCursor(
                    snapshotId = requireNotNull(expectedSnapshotId),
                    snapshotFingerprint = requireNotNull(expectedSnapshotFingerprint),
                    runtimeFingerprint = requireNotNull(expectedFingerprint),
                    nextOffset = offset,
                    totalCount = requireNotNull(expectedTotal),
                    observedCount = observedCount,
                    omittedCount = omittedCount,
                    observedAt = observedAt,
                )
                checkpoint(
                    credentials,
                    bootstrapId,
                    PortableBootstrapPhase.RECEIVING_MANIFEST,
                    attemptCount,
                    nowEpochMillis,
                    manifestFingerprint = expectedSnapshotFingerprint,
                    currentItem = encodeCursor(cursor),
                )
            }
        }
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
                ecosystem = PortableEcosystem.SUWAYOMI.name,
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
        } catch (error: Throwable) {
            Log.w(LOG_TAG, "portable manifest hydration failed: ${error::class.simpleName}")
            return CoreReplicaSyncOutcome.RETRY
        }
        val requiresUserAction = hydrationReport?.dependenciesRequiringUserAction.orZero() > 0
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
                    ecosystem = PortableEcosystem.SUWAYOMI,
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
        page: CorePortableManifest,
        observedAt: Long,
        updatedAt: Long,
    ): Boolean = database.await(inTransaction = true) {
        val dependenciesByPackage = page.comicDependencies.associateBy(ComicDependency::pkgName)
        if (page.comicDependencies.size != dependenciesByPackage.size) return@await false
        if (page.works.map { it.portableId }.distinct().size != page.works.size) return@await false
        if (!page.works.all { work ->
            work.portableId == PortableIdentityV3.workId(work.reference) &&
                work.dependencyPackageName?.let { packageName ->
                    dependenciesByPackage[packageName]?.requiredSourceIds?.contains(work.reference.sourceId) == true
                } != false
        }) return@await false
        val bindingStore = SqlDelightPortableBindingStore(this)
        val dependencyStore = SqlDelightPortableDependencyStore(this)
        val existingDependencies = dependencyStore.comics(credentials.serverId, credentials.profileId)
            .associateBy { it.dependency.pkgName }
        page.comicDependencies.forEach { dependency ->
            val existing = existingDependencies[dependency.pkgName]
            val trustState = portableDependencyTrustState(
                existingProvenanceUrl = existing?.dependency?.extensionStore?.storeIndexUrl,
                existingTrustState = existing?.trustState,
                incomingProvenanceUrl = dependency.extensionStore?.storeIndexUrl,
            )
            dependencyStore.upsertComic(
                PortableComicDependencyRecord(
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
            val unchanged = existing?.takeIf {
                it.dependencyKey == work.dependencyPackageName &&
                    bindingStillTargetsExactProvider(it, work.reference)
            }
            bindingStore.upsertWork(
                PortableWorkBindingRecord(
                    portableId = work.portableId,
                    ref = work.reference,
                    dependencyKey = work.dependencyPackageName,
                    localReference = existing?.localReference,
                    resolution = unchanged?.resolution
                        ?: PortableResolution(
                            if (work.dependencyPackageName != null) PortableResolutionState.PENDING_DEPENDENCY
                            else PortableResolutionState.PENDING_PROVIDER,
                        ),
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

    /**
     * A bridge placeholder is not a resolved provider binding.
     *
     * Builds predating the portable dependency bootstrap could persist BOUND while the local
     * manga still pointed at EpigraphCoreSource. Preserving that state forever prevented a later,
     * user-installed extension with the exact source id from being considered, so details pages
     * kept the placeholder and often had no chapters. Non-BOUND evidence is still preserved; a
     * BOUND row is reusable only when its local manga exists and owns the exact source id from the
     * immutable portable reference.
     */
    private fun yokai.data.Database.bindingStillTargetsExactProvider(
        existing: PortableWorkBindingRecord,
        reference: epigraph.contract.PortableWorkRef.Comic,
    ): Boolean {
        if (existing.resolution.state != PortableResolutionState.BOUND) return true
        val localId = existing.localReference?.toLongOrNull()?.takeIf { it > 0 } ?: return false
        val expectedSourceId = reference.sourceId.value.toLongOrNull() ?: return false
        return mangasQueries.findById(localId).executeAsOneOrNull()?.source == expectedSourceId
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
        val runtimeFingerprint: String,
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
        const val LOG_TAG = "EpigraphCoreSync"
    }
}

private fun Int?.orZero(): Int = this ?: 0
