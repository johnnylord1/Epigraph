package epigraph.sync

import epigraph.contract.SyncScopeId

data class EpigraphSyncScopes(
    val novels: SyncScopeId,
    val comics: SyncScopeId,
)

fun interface EpigraphSyncScopeProvider {
    suspend fun current(): EpigraphSyncScopes
}
