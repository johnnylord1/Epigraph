package epigraph.sync.core.work

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreSyncStatus
import epigraph.sync.core.suwayomi.SuwayomiProjectionStatusSource
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreCatalogRevisionGateTest {
    private val session = CoreCredentialSession(
        origin = "https://core.test/",
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("comics:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = SERVER,
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )
    private val runs = mutableListOf<String>()
    private val store = MemoryStore()
    private val local = mutableMapOf<CoreCatalogStage, String?>(
        CoreCatalogStage.EXTENSIONS to "installed-1",
        CoreCatalogStage.PORTABLE_MANIFEST to "library-1",
        CoreCatalogStage.CATALOG to "library-1",
    )
    private var status: CoreHttpResult<CoreSyncStatus>? = status("lib-1", "ext-1")
    private var catalogOutcome = CoreReplicaSyncOutcome.APPLIED

    @AfterEach
    fun close() = session.close()

    @Test
    fun `an unchanged revision skips the catalog stages but never the replica`() = runTest {
        assertEquals(CoreReplicaSyncOutcome.APPLIED, sync(1_000))
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)

        runs.clear()
        assertEquals(CoreReplicaSyncOutcome.APPLIED, sync(2_000))
        assertEquals(listOf("replica"), runs)
    }

    @Test
    fun `a new library revision runs the library stages and keeps the extension skip`() = runTest {
        sync(1_000)
        runs.clear()
        status = status("lib-2", "ext-1")

        sync(2_000)
        assertEquals(listOf("portable", "catalog", "replica"), runs)
    }

    @Test
    fun `a category change keeps the manifest skip when the desktop announces its revision`() = runTest {
        status = status("lib-1", "ext-1", manifest = "man-1")
        sync(1_000)
        runs.clear()
        status = status("lib-2", "ext-1", manifest = "man-1")

        sync(2_000)
        assertEquals(listOf("catalog", "replica"), runs)

        runs.clear()
        status = status("lib-3", "ext-1", manifest = "man-2")
        sync(3_000)
        assertEquals(listOf("portable", "catalog", "replica"), runs)
    }

    @Test
    fun `a desktop without revisions runs every stage and keeps nothing`() = runTest {
        status = status(null, null)
        sync(1_000)
        runs.clear()
        sync(2_000)
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)
        assertTrue(store.values.isEmpty())

        runs.clear()
        status = null
        sync(3_000)
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)

        runs.clear()
        status = CoreHttpResult.Failure(503, null)
        sync(4_000)
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)
    }

    @Test
    fun `a pass without revisions runs every stage but keeps what was applied`() = runTest {
        sync(1_000)
        runs.clear()
        // The Core hides its revisions while it projects a change.
        status = status(null, null)
        sync(2_000)
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)

        runs.clear()
        status = status("lib-1", "ext-1")
        sync(3_000)
        assertEquals(listOf("replica"), runs)
    }

    @Test
    fun `a local change or unsettled work runs the stage again`() = runTest {
        sync(1_000)
        runs.clear()
        local[CoreCatalogStage.EXTENSIONS] = "installed-2"
        sync(2_000)
        assertEquals(listOf("extensions", "replica"), runs)

        runs.clear()
        local[CoreCatalogStage.CATALOG] = null
        sync(3_000)
        assertEquals(listOf("catalog", "replica"), runs)
        runs.clear()
        sync(4_000)
        assertEquals(listOf("catalog", "replica"), runs)
    }

    @Test
    fun `a stage that did not apply runs again`() = runTest {
        catalogOutcome = CoreReplicaSyncOutcome.RETRY
        assertEquals(CoreReplicaSyncOutcome.RETRY, sync(1_000))
        runs.clear()
        catalogOutcome = CoreReplicaSyncOutcome.APPLIED
        sync(2_000)
        assertEquals(listOf("catalog", "replica"), runs)
    }

    @Test
    fun `every stage runs again after the full reapply interval`() = runTest {
        sync(1_000)
        runs.clear()
        sync(1_000 + CoreCatalogRevisionGate.REAPPLY_INTERVAL_MS - 1)
        assertEquals(listOf("replica"), runs)

        runs.clear()
        sync(1_000 + CoreCatalogRevisionGate.REAPPLY_INTERVAL_MS)
        assertEquals(listOf("extensions", "portable", "catalog", "replica"), runs)
    }

    @Test
    fun `a library change made by a later stage of the same pass is not a local edit`() = runTest {
        // The catalog stage itself changes the library the portable stage compared against.
        sync(1_000) { local[CoreCatalogStage.PORTABLE_MANIFEST] = "library-2" }
        runs.clear()
        sync(2_000)
        assertEquals(listOf("replica"), runs)
    }

    private suspend fun sync(now: Long, onCatalog: () -> Unit = {}): CoreReplicaSyncOutcome {
        fun port(name: String, outcome: () -> CoreReplicaSyncOutcome = { CoreReplicaSyncOutcome.APPLIED }) =
            CoreReplicaSyncPort { _, _, _ ->
                runs += name
                outcome()
            }
        return CompositeCoreReplicaSync(
            replica = port("replica"),
            catalog = port("catalog") {
                onCatalog()
                catalogOutcome
            },
            extensionInventory = port("extensions"),
            portableManifest = port("portable"),
            revisions = CoreCatalogRevisionGate(
                status = SuwayomiProjectionStatusSource { _, scopeId ->
                    assertEquals("comics:profile:$PROFILE", scopeId)
                    status
                },
                store = store,
                localState = CoreCatalogLocalState { stage, _ -> local[stage] },
            ),
        ).synchronize(session, capabilities(), now)
    }

    private fun status(
        library: String?,
        extensions: String?,
        manifest: String? = null,
    ): CoreHttpResult<CoreSyncStatus> =
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
                comicManifestRevision = manifest,
            ),
        )

    private fun capabilities() = CoreCapabilities(
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
        supportsSyncStatusV1 = true,
    )

    private class MemoryStore : CoreStageRevisionStore {
        val values = mutableMapOf<String, CoreStageRevision>()
        override fun get(key: String) = values[key]
        override fun put(key: String, value: CoreStageRevision) { values[key] = value }
        override fun remove(key: String) { values.remove(key) }
    }

    private companion object {
        const val PROFILE = "profile-1"
        const val SERVER = "server-1"
    }
}
