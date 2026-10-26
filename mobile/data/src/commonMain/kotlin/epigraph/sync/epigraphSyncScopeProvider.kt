package epigraph.sync

import epigraph.contract.SyncScopeId

data class EpigraphSyncScopes(
    val novels: SyncScopeId,
    val comics: SyncScopeId,
    /**
     * The paired Core's server id. Null while unpaired or on a legacy session, when the server is
     * unknown and Suwayomi ids are published as they are.
     */
    val serverId: String? = null,
)

fun interface EpigraphSyncScopeProvider {
    suspend fun current(): EpigraphSyncScopes
}
