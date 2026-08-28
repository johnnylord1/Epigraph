package epigraph.sync.core.credentials

import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CoreCredentialScopeProvider(
    private val credentials: CoreCredentialStore,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : EpigraphSyncScopeProvider {
    override suspend fun current(): EpigraphSyncScopes = withContext(ioDispatcher) {
        val profileId = credentials.load()?.use { it.profileId }
            ?: error("A paired Epigraph Core profile is required for synchronized mutations")
        EpigraphSyncScopes(
            novels = SyncScopeId("novels:profile:$profileId"),
            comics = SyncScopeId("comics:profile:$profileId"),
        )
    }
}
