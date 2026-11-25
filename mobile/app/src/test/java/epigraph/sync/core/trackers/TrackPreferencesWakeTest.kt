package epigraph.sync.core.trackers

import eu.kanade.tachiyomi.core.preference.InMemoryPreferenceStore
import eu.kanade.tachiyomi.data.track.EnhancedTrackService
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.track.TrackPreferences
import eu.kanade.tachiyomi.data.track.TrackService
import io.mockk.every
import io.mockk.mockk
import org.junit.Assert.assertEquals
import org.junit.Test

class TrackPreferencesWakeTest {
    @Test
    fun localCredentialAndTokenWritesWakeSyncWhileSuppressedWritesDoNot() {
        val wokenSyncIds = mutableListOf<Long>()
        val preferences = TrackPreferences(
            preferenceStore = InMemoryPreferenceStore(),
            onCredentialsChanged = { wokenSyncIds += it },
        )
        val regularService = mockk<TrackService>(relaxed = true) {
            every { id } returns 2L
        }
        val enhancedService = mockk<TrackService>(
            relaxed = true,
            moreInterfaces = arrayOf(EnhancedTrackService::class),
        ) {
            every { id } returns 6L
        }

        preferences.setCredentials(regularService, "user", "pass")
        preferences.trackToken(regularService).set("oauth-token")
        preferences.trackToken(regularService).delete()
        assertEquals(listOf(2L, 2L, 2L), wokenSyncIds)

        preferences.setCredentials(enhancedService, "komga", "secret")
        preferences.trackToken(enhancedService).set("ignored")
        assertEquals(listOf(2L, 2L, 2L), wokenSyncIds)

        val trackManager = mockk<TrackManager> {
            every { services } returns listOf(regularService)
            every { getService(2L) } returns regularService
        }
        val source = TrackManagerCredentialSource(trackManager, preferences)
        source.apply(2L, TrackerSecret(username = "remote", password = "pw", token = "tok"))
        source.apply(2L, null)
        assertEquals(listOf(2L, 2L, 2L), wokenSyncIds)
    }
}
