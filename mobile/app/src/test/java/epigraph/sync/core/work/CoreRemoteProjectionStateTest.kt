package epigraph.sync.core.work

import epigraph.sync.core.protocol.CoreSyncStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreRemoteProjectionStateTest {
    @Test
    fun `rows parked for a user decision are not reported as uploads left`() {
        assertEquals(3L, uploadsStillToSend(unsettled = 7, blocked = 4))
        assertEquals(0L, uploadsStillToSend(unsettled = 4, blocked = 4))
        assertEquals(0L, uploadsStillToSend(unsettled = 2, blocked = 5))
        assertEquals(0L, uploadsStillToSend(unsettled = 0, blocked = 0))
    }

    @Test
    fun `only blocked projections with nothing queued need desktop action`() {
        assertEquals(CoreRemoteProjectionState.READY, status(ready = true).remoteProjectionState())
        assertEquals(CoreRemoteProjectionState.BLOCKED, status(blocked = 2).remoteProjectionState())
        assertEquals(
            CoreRemoteProjectionState.IN_PROGRESS,
            status(pending = 1, blocked = 2).remoteProjectionState(),
        )
        assertEquals(
            CoreRemoteProjectionState.IN_PROGRESS,
            status(inFlight = 1, blocked = 2).remoteProjectionState(),
        )
        // `ready` false with no counters is an older/partial Core answer; keep retrying.
        assertEquals(CoreRemoteProjectionState.IN_PROGRESS, status().remoteProjectionState())
    }

    private fun status(
        pending: Long = 0,
        blocked: Long = 0,
        inFlight: Long = 0,
        ready: Boolean = false,
    ) = CoreSyncStatus(
        scopeId = "comics:profile:main",
        currentServerVersion = 10,
        minReplayableServerVersion = 1,
        comicAuthorityMode = "suwayomi-confirmed-v1",
        suwayomiProjectionPending = pending,
        suwayomiProjectionBlocked = blocked,
        suwayomiProjectionInFlight = inFlight,
        ready = ready,
    )
}
