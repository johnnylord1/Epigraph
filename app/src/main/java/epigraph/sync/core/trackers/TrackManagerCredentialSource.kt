package epigraph.sync.core.trackers

import eu.kanade.tachiyomi.data.track.EnhancedTrackService
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.track.TrackPreferences

/**
 * Tracker logins as stored by the tracker services. Enhanced services (Komga, Kavita, Suwayomi)
 * authenticate through a local source, not a portable account, so their state never leaves the
 * device.
 */
class TrackManagerCredentialSource(
    private val trackManager: TrackManager,
    private val preferences: TrackPreferences,
) : TrackerCredentialSource {
    override val syncIds: Set<Long> by lazy {
        trackManager.services.filterNot { it is EnhancedTrackService }.mapTo(linkedSetOf()) { it.id }
    }

    override fun read(syncId: Long): TrackerSecret? {
        if (syncId !in syncIds) return null
        val secret = runCatching {
            TrackerSecret(
                username = preferences.usernamePreference(syncId).get(),
                password = preferences.passwordPreference(syncId).get(),
                token = preferences.tokenPreference(syncId).get(),
            )
        }.getOrNull() ?: return null
        // Same rule as TrackService.isLogged: the default logout() clears only the username and
        // password, so a leftover token alone is not a login.
        return secret.takeIf { it.isLogin }
    }

    override fun apply(syncId: Long, secret: TrackerSecret?) {
        if (syncId !in syncIds) return
        val service = trackManager.getService(syncId) ?: return
        // logout() also drops the service's in-memory auth, so the next request reloads it.
        service.logout()
        if (secret == null || !secret.isLogin) {
            preferences.tokenPreference(syncId).set("")
            return
        }
        preferences.usernamePreference(syncId).set(secret.username)
        preferences.passwordPreference(syncId).set(secret.password)
        preferences.tokenPreference(syncId).set(secret.token)
        preferences.trackAuthExpired(service).set(false)
    }
}
