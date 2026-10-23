package epigraph.sync.core.work

import android.content.Context
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Sync the user disconnected from Settings without forgetting the desktop. While paused nothing
 * talks to the Core in the background: the worker and the live feed stand down, the pairing stays,
 * and changes keep queueing in the outbox until sync is reconnected.
 */
interface CoreSyncPause {
    val paused: StateFlow<Boolean>

    fun setPaused(paused: Boolean)
}

class InMemoryCoreSyncPause(paused: Boolean = false) : CoreSyncPause {
    private val mutablePaused = MutableStateFlow(paused)
    override val paused: StateFlow<Boolean> = mutablePaused.asStateFlow()

    override fun setPaused(paused: Boolean) {
        mutablePaused.value = paused
    }
}

class SharedPreferencesCoreSyncPause(context: Context) : CoreSyncPause {
    private val preferences = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val mutablePaused = MutableStateFlow(preferences.getBoolean(KEY_PAUSED, false))
    override val paused: StateFlow<Boolean> = mutablePaused.asStateFlow()

    override fun setPaused(paused: Boolean) {
        // Committed before the flow changes, so a worker started right after reads the same answer.
        preferences.edit().putBoolean(KEY_PAUSED, paused).commit()
        mutablePaused.value = paused
    }

    private companion object {
        const val PREFERENCES_NAME = "epigraph_core_sync_pause"
        const val KEY_PAUSED = "paused"
    }
}
