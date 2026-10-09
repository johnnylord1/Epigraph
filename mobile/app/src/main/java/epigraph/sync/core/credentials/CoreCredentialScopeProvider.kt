package epigraph.sync.core.credentials

import android.content.Context
import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class CoreCredentialScopeProvider(
    private val credentials: CoreCredentialStore,
    private val lastPairedProfile: LastPairedProfileStore = LastPairedProfileStore.None,
    private val ioDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : EpigraphSyncScopeProvider {
    override suspend fun current(): EpigraphSyncScopes = withContext(ioDispatcher) {
        // After "forget connection" edits keep queuing for the last profile, so a later re-pair
        // publishes them with their original timestamps and the newest edit wins on either side.
        val profileId = credentials.load()?.use { it.profileId }?.also(lastPairedProfile::remember)
            ?: lastPairedProfile.load()
            ?: throw CoreProfileNotPairedException()
        EpigraphSyncScopes(
            novels = SyncScopeId("novels:profile:$profileId"),
            comics = SyncScopeId("comics:profile:$profileId"),
        )
    }
}

/** Non-secret pointer to the profile this device last synchronized with. */
interface LastPairedProfileStore {
    fun load(): String?
    fun remember(profileId: String)

    object None : LastPairedProfileStore {
        override fun load(): String? = null
        override fun remember(profileId: String) = Unit
    }
}

class SharedPreferencesLastPairedProfileStore(context: Context) : LastPairedProfileStore {
    private val preferences = context.getSharedPreferences("epigraph_core_last_profile", Context.MODE_PRIVATE)

    override fun load(): String? = preferences.getString(KEY, null)?.takeIf { it.isNotBlank() }

    override fun remember(profileId: String) {
        if (profileId.isNotBlank() && load() != profileId) preferences.edit().putString(KEY, profileId).apply()
    }

    private companion object {
        const val KEY = "profile_id"
    }
}

/** Expected on devices that were never paired; callers fall back to local-only writes. */
class CoreProfileNotPairedException :
    IllegalStateException("A paired Epigraph Core profile is required for synchronized mutations")
