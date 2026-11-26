package epigraph.sync.core.work

import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSyncStatus
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreV4UploadReportTest {
    private val report = CoreOutboxDrainReport(0, 0, 0, 0, 0)
    private val drained = CoreOutboxSyncOutcome.OutboxDrained(report, CoreReplicaSyncOutcome.APPLIED)
    private val deferred = CoreOutboxSyncOutcome.OutboxDeferred(report, CoreReplicaSyncOutcome.APPLIED, pendingCount = 7)
    private val retry = CoreOutboxSyncOutcome.Retry(3, CoreOutboxRetryReason.CONNECTION)

    @Test
    fun `a finished V4 run tells the Core what this device still has to upload`() = runBlocking {
        val connection = RecordingConnection()

        reportV4Uploads(connection, capabilities(statusSupported = true), "main", drained)
        reportV4Uploads(connection, capabilities(statusSupported = true), "main", deferred)

        assertEquals(
            listOf(
                Triple("comics:profile:main", 0L, 0L),
                Triple("comics:profile:main", 7L, 7L),
            ),
            connection.reports,
        )
    }

    @Test
    fun `a failed run or a Core without the status route reports nothing`() = runBlocking {
        val connection = RecordingConnection()

        reportV4Uploads(connection, capabilities(statusSupported = true), "main", retry)
        reportV4Uploads(connection, capabilities(statusSupported = false), "main", drained)

        assertEquals(emptyList<Triple<String, Long?, Long?>>(), connection.reports)
    }

    @Test
    fun `a rejected report does not fail the sync run`() = runBlocking {
        val connection = RecordingConnection(fail = true)

        reportV4Uploads(connection, capabilities(statusSupported = true), "main", drained)

        assertEquals(1, connection.reports.size)
    }

    private class RecordingConnection(private val fail: Boolean = false) : CoreOutboxSyncConnection {
        val reports = mutableListOf<Triple<String, Long?, Long?>>()
        override val openedOrigin: String = "https://core.test"

        override suspend fun capabilities(): CoreHttpResult<CoreCapabilities> = error("unused")

        override suspend fun syncStatus(
            scopeId: String,
            pendingUploads: Long?,
            pendingLibraryUploads: Long?,
        ): CoreHttpResult<CoreSyncStatus>? {
            reports += Triple(scopeId, pendingUploads, pendingLibraryUploads)
            if (fail) throw IllegalStateException("403")
            return null
        }
    }

    private fun capabilities(statusSupported: Boolean) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:main"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{profileId}/graphql",
        snapshotSchemaVersion = 3,
        snapshotEntityTypes = emptySet(),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-sync._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        supportsSyncStatusV1 = statusSupported,
    )
}
