package epigraph.sync.core.work

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

class CoreSyncReleaseLogTest {
    @Test
    fun `formatV4Synced emits structured counts and duration without sensitive fields`() {
        val line = CoreSyncReleaseLog.formatV4Synced(
            elapsedMs = 142,
            seq = 88L,
            uploaded = 3,
            applied = 5,
            pending = 1L,
            noop = false,
            assetsSucceeded = 2,
            assetsAttempted = 4,
        )

        assertEquals(
            "v4 sync complete elapsedMs=142 seq=88 uploaded=3 applied=5 pending=1 noop=false assets=2/4",
            line,
        )
    }

    @Test
    fun `formatV4Failed classifies failure without raw reason text`() {
        val httpFailure = CoreSyncReleaseLog.formatV4Failed(
            elapsedMs = 310,
            statusCode = 503,
            retryable = true,
            pending = 7L,
        )
        assertEquals(
            "v4 sync failed elapsedMs=310 status=503 retryable=true pending=7 category=http_503",
            httpFailure,
        )

        val ioFailure = CoreSyncReleaseLog.formatV4Failed(
            elapsedMs = 50,
            statusCode = null,
            retryable = true,
            pending = 2L,
        )
        assertEquals(
            "v4 sync failed elapsedMs=50 status=none retryable=true pending=2 category=transient_io",
            ioFailure,
        )

        val nonRetryable = CoreSyncReleaseLog.formatV4Failed(
            elapsedMs = 12,
            statusCode = null,
            retryable = false,
            pending = 0L,
        )
        assertEquals(
            "v4 sync failed elapsedMs=12 status=none retryable=false pending=0 category=non_retryable",
            nonRetryable,
        )
    }

    @Test
    fun `formatStageOutcome and formatStageFailure are concise and payload-free`() {
        assertEquals(
            "replica sync outcome=APPLIED elapsedMs=25",
            CoreSyncReleaseLog.formatStageOutcome("replica", "APPLIED", 25),
        )
        val failureLine = CoreSyncReleaseLog.formatStageFailure("connection.drain", "SocketTimeoutException")
        assertEquals("connection.drain sync failed=SocketTimeoutException", failureLine)
        assertFalse(failureLine.contains("http"))
    }
}
