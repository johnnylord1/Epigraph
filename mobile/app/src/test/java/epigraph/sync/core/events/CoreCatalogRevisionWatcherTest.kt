package epigraph.sync.core.events

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.suwayomi.SuwayomiProjectionStatusSource
import epigraph.sync.core.work.CoreCatalogStage
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

@OptIn(ExperimentalCoroutinesApi::class)
class CoreCatalogRevisionWatcherTest {
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("comics:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = "server-1",
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )
    private val foreground = MutableStateFlow(true)
    private val applied = mutableMapOf<CoreCatalogStage, String?>(
        CoreCatalogStage.CATALOG to "lib-1",
        CoreCatalogStage.EXTENSIONS to "ext-1",
    )
    private var status: CoreHttpResult<CoreSyncStatus>? = status("lib-1", "ext-1")
    private var checks = 0
    private var wakes = 0

    @AfterEach
    fun close() = session.close()

    @Test
    fun `an applied revision never wakes the worker`() = watching {
        advanceTimeBy(INTERVAL * 3)
        assertEquals(0, wakes)
        assertEquals(3, checks)
    }

    @Test
    fun `a new desktop revision wakes the worker once`() = watching {
        status = status("lib-2", "ext-1")
        advanceTimeBy(INTERVAL)
        runCurrent()
        assertEquals(1, wakes)

        // The worker has not applied it yet: no second wake for the same revision.
        advanceTimeBy(INTERVAL * 3)
        assertEquals(1, wakes)

        applied[CoreCatalogStage.CATALOG] = "lib-2"
        advanceTimeBy(INTERVAL)
        status = status("lib-2", "ext-2")
        advanceTimeBy(INTERVAL)
        assertEquals(2, wakes)
    }

    @Test
    fun `the same revision wakes again after the phone caught up and fell behind`() = watching {
        status = status("lib-2", "ext-1")
        advanceTimeBy(INTERVAL + 1)
        applied[CoreCatalogStage.CATALOG] = "lib-2"
        advanceTimeBy(INTERVAL)
        // A stage that could not record its apply (local work in flight) is behind once more.
        applied[CoreCatalogStage.CATALOG] = null
        advanceTimeBy(INTERVAL)
        assertEquals(2, wakes)
    }

    @Test
    fun `no revision or an unreachable Core waits instead of waking`() = watching {
        status = status(null, null)
        advanceTimeBy(INTERVAL * 2)
        status = CoreHttpResult.Failure(503, null)
        advanceTimeBy(INTERVAL * 2)
        status = null
        advanceTimeBy(INTERVAL * 2)
        assertEquals(0, wakes)
    }

    @Test
    fun `it checks only while visible and right when the app becomes visible`() = watching {
        foreground.value = false
        runCurrent()
        val before = checks
        status = status("lib-2", "ext-1")
        advanceTimeBy(INTERVAL * 5)
        assertEquals(before, checks)
        assertEquals(0, wakes)

        foreground.value = true
        runCurrent()
        assertEquals(before + 1, checks)
        assertEquals(1, wakes)
    }

    @Test
    fun `a Core without sync status is never asked`() = runTest {
        val job = launch { watcher().watch(session, capabilities(supportsSyncStatus = false)) }
        advanceTimeBy(INTERVAL * 3)
        assertEquals(0, checks)
        job.cancel()
    }

    private fun watching(block: suspend TestScope.() -> Unit) = runTest {
        val job = launch { watcher().watch(session, capabilities()) }
        runCurrent()
        block()
        job.cancel()
    }

    private fun watcher() = CoreCatalogRevisionWatcher(
        foreground = foreground,
        status = SuwayomiProjectionStatusSource { _, scopeId ->
            assertEquals("comics:profile:$PROFILE", scopeId)
            checks++
            status ?: throw IllegalStateException("offline")
        },
        applied = { credentials, stage ->
            assertEquals(PROFILE, credentials.profileId)
            applied[stage]
        },
        wake = { wakes++ },
        intervalMs = INTERVAL,
    )

    private fun status(library: String?, extensions: String?): CoreHttpResult<CoreSyncStatus> =
        CoreHttpResult.Success(
            CoreSyncStatus(
                scopeId = "comics:profile:$PROFILE",
                currentServerVersion = 1,
                minReplayableServerVersion = 0,
                comicAuthorityMode = "suwayomi-confirmed-v1",
                suwayomiProjectionPending = 0,
                suwayomiProjectionBlocked = 0,
                suwayomiProjectionInFlight = 0,
                ready = true,
                comicLibraryRevision = library,
                comicExtensionsRevision = extensions,
            ),
        )

    private fun capabilities(supportsSyncStatus: Boolean = true) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:$PROFILE"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = false,
        supportsSnapshot = false,
        supportsAssets = false,
        supportsNovelChapterAssets = false,
        supportsNovelPluginSync = false,
        supportsSuwayomiProxy = true,
        supportsSuwayomiCatalog = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        snapshotEntityTypes = emptySet(),
        supportsSyncStatusV1 = supportsSyncStatus,
    )

    private companion object {
        const val PROFILE = "profile-1"
        const val INTERVAL = 20_000L
    }
}
