package epigraph.sync.core.portable

import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.portable.SqlDelightPortableDependencyStore
import yokai.data.DatabaseHandler

internal fun portableDependencyTrustState(
    existingProvenanceUrl: String?,
    existingTrustState: String?,
    incomingProvenanceUrl: String?,
): String = when {
    incomingProvenanceUrl == null -> "TRUSTED"
    existingProvenanceUrl == incomingProvenanceUrl && existingTrustState != null -> existingTrustState
    else -> "APPROVAL_REQUIRED"
}

internal fun canonicalRepositoryUrl(value: String): String = value
    .trim()
    .trimEnd('/')

/** Connects explicit repository approval to the portable dependency graph. */
class PortableDependencyTrustCoordinator(
    private val database: DatabaseHandler,
    private val scheduler: CoreBackgroundSyncScheduler,
) {
    suspend fun trustComicStore(serverId: String, profileId: String, indexUrls: Set<String>) {
        if (indexUrls.isEmpty()) return
        database.await(inTransaction = true) {
            val store = SqlDelightPortableDependencyStore(this)
            store.comics(serverId, profileId)
                .filter { it.dependency.extensionStore?.storeIndexUrl in indexUrls }
                .forEach { record ->
                    store.upsertComic(
                        record.copy(
                            trustState = "TRUSTED",
                            resolution = PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
                            updatedAt = System.currentTimeMillis(),
                        ),
                    )
                }
        }
        wake()
    }

    suspend fun trustNovelRepository(serverId: String, profileId: String, indexUrls: Set<String>): Int {
        val canonicalUrls = indexUrls.map(::canonicalRepositoryUrl).filter(String::isNotEmpty).toSet()
        if (canonicalUrls.isEmpty()) return 0
        val changed = database.await(inTransaction = true) {
            val store = SqlDelightPortableDependencyStore(this)
            store.novels(serverId, profileId)
                .filter { record ->
                    record.trustState != "TRUSTED" &&
                        record.dependency.repository?.indexUrl
                            ?.let(::canonicalRepositoryUrl) in canonicalUrls
                }
                .onEach { record ->
                    store.upsertNovel(
                        record.copy(
                            trustState = "TRUSTED",
                            resolution = PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
                            updatedAt = System.currentTimeMillis(),
                        ),
                    )
                }
                .size
        }
        if (changed > 0) wake()
        return changed
    }

    fun wake() {
        scheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
    }
}
