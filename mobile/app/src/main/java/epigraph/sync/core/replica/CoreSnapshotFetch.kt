package epigraph.sync.core.replica

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSnapshot

/** Entities per page; comic chapter states are about 1 KB each, well under the response bound. */
internal const val CORE_SNAPSHOT_PAGE_SIZE = 4_000

/** More pages than this is a Core that never ends its snapshot, not a library. */
internal const val MAX_CORE_SNAPSHOT_PAGES = 2_000

/**
 * Fetches a scope snapshot and applies it as one replacement. A Core with
 * [CoreCapabilities.supportsPagedSnapshotV1] sends it in bounded pages, so a large comic library
 * never exceeds the client's response limit; older Cores send the whole scope at once.
 */
suspend fun CoreReplicaApplier.fetchAndApplySnapshot(
    http: EpigraphCoreHttpClient,
    accessToken: String,
    scopeId: String,
    capabilities: CoreCapabilities,
    originServerId: String?,
): CoreHttpResult<CoreReplicaApplyResult.SnapshotApplied> {
    if (!capabilities.supportsPagedSnapshotV1) {
        return when (val response = http.snapshot(accessToken, scopeId)) {
            is CoreHttpResult.Success -> CoreHttpResult.Success(
                applySnapshot(response.value, capabilities, originServerId),
            )
            is CoreHttpResult.Failure -> response
        }
    }
    val pages = ArrayList<CoreSnapshot>()
    var cursor: String? = null
    do {
        val page = when (val response = http.snapshot(accessToken, scopeId, CORE_SNAPSHOT_PAGE_SIZE, cursor)) {
            is CoreHttpResult.Success -> response.value
            is CoreHttpResult.Failure -> return response
        }
        pages += page
        cursor = page.nextCursor
        if (cursor != null && pages.size >= MAX_CORE_SNAPSHOT_PAGES) {
            throw CoreReplicaProtocolException("Core snapshot does not end")
        }
    } while (cursor != null)
    return CoreHttpResult.Success(applySnapshotPages(pages, capabilities, originServerId))
}
