package eu.kanade.tachiyomi.data.track

import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.core.preference.PreferenceStore
import eu.kanade.tachiyomi.data.track.anilist.Anilist

class TrackPreferences(
    private val preferenceStore: PreferenceStore,
    private val onCredentialsChanged: ((syncId: Long) -> Unit)? = null,
) {
    private val credentialWakeSuppression = ThreadLocal<Int>()

    fun <T> withoutCredentialWake(block: () -> T): T {
        val depth = credentialWakeSuppression.get() ?: 0
        credentialWakeSuppression.set(depth + 1)
        return try {
            block()
        } finally {
            if (depth == 0) {
                credentialWakeSuppression.remove()
            } else {
                credentialWakeSuppression.set(depth)
            }
        }
    }

    private fun notifyCredentialsChanged(sync: TrackService) {
        if (sync is EnhancedTrackService) return
        if ((credentialWakeSuppression.get() ?: 0) > 0) return
        onCredentialsChanged?.invoke(sync.id)
    }

    fun trackUsername(sync: TrackService) = preferenceStore.getString(trackUsername(sync.id), "")

    fun trackPassword(sync: TrackService) = preferenceStore.getString(trackPassword(sync.id), "")

    fun trackAuthExpired(sync: TrackService) = preferenceStore.getBoolean(
        Preference.privateKey("pref_tracker_auth_expired_${sync.id}"),
        false,
    )

    fun setCredentials(sync: TrackService, username: String, password: String) {
        trackUsername(sync).set(username)
        trackPassword(sync).set(password)
        trackAuthExpired(sync).set(false)
        notifyCredentialsChanged(sync)
    }

    fun trackToken(sync: TrackService): Preference<String> {
        val delegate = preferenceStore.getString(trackToken(sync.id), "")
        if (onCredentialsChanged == null || sync is EnhancedTrackService) return delegate
        return object : Preference<String> by delegate {
            override fun set(value: String) {
                delegate.set(value)
                notifyCredentialsChanged(sync)
            }

            override fun delete() {
                delegate.delete()
                notifyCredentialsChanged(sync)
            }
        }
    }

    /** Raw login fields by tracker ID, used only by the paired Core tracker credential sync. */
    fun usernamePreference(syncId: Long) = preferenceStore.getString(trackUsername(syncId), "")

    fun passwordPreference(syncId: Long) = preferenceStore.getString(trackPassword(syncId), "")

    fun tokenPreference(syncId: Long) = preferenceStore.getString(trackToken(syncId), "")

    fun anilistScoreType() = preferenceStore.getString("anilist_score_type", Anilist.POINT_10)

    fun autoUpdateTrack() = preferenceStore.getBoolean("pref_auto_update_manga_sync_key", true)

    companion object {
        fun trackUsername(syncId: Long) = Preference.privateKey("pref_mangasync_username_$syncId")

        private fun trackPassword(syncId: Long) =
            Preference.privateKey("pref_mangasync_password_$syncId")

        private fun trackToken(syncId: Long) = Preference.privateKey("track_token_$syncId")
    }
}
