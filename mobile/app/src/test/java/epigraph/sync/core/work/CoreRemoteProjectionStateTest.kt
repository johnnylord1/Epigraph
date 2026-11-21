package epigraph.sync.core.work

import epigraph.sync.core.protocol.CoreSyncStatus
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
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

    @Test
    fun `blocked desktop rows stop the run only once this device has nothing left to send`() {
        // A first sync's backlog keeps going: the run finishes normally and the next wake sends more.
        assertNull(remoteProjectionOutcome(CoreRemoteProjectionState.BLOCKED, 17_006, 17_006, null))
        // Rows parked here for a user decision are not uploads left, so they do not hide the notice.
        assertEquals(
            CoreOutboxSyncOutcome.NeedsUserAction(4, CoreUserActionReason.REMOTE_PROJECTION_BLOCKED),
            remoteProjectionOutcome(CoreRemoteProjectionState.BLOCKED, 4, 0, null),
        )
        assertNull(remoteProjectionOutcome(CoreRemoteProjectionState.READY, 9, 9, null))
        assertEquals(
            CoreOutboxSyncOutcome.Retry(9, CoreOutboxRetryReason.OUTBOX_PENDING, desktopPendingCount = 3),
            remoteProjectionOutcome(CoreRemoteProjectionState.IN_PROGRESS, 9, 9, 3),
        )
    }

    @Test
    fun `works the desktop could not find are read from newer desktops without blocking`() {
        val newer = kotlinx.serialization.json.Json { ignoreUnknownKeys = true }.decodeFromString(
            CoreSyncStatus.serializer(),
            """
            {"scopeId":"comics:profile:main","currentServerVersion":10,"minReplayableServerVersion":1,
             "comicAuthorityMode":"suwayomi-confirmed-v1","suwayomiProjectionPending":0,
             "suwayomiProjectionBlocked":0,"suwayomiProjectionInFlight":0,
             "suwayomiProjectionNotFound":173,"ready":true}
            """.trimIndent(),
        )
        assertEquals(173L, newer.suwayomiProjectionNotFound)
        assertEquals(CoreRemoteProjectionState.READY, newer.remoteProjectionState())
        assertNull(status().suwayomiProjectionNotFound)
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
