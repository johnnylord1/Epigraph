package epigraph.sync.core.trackers

import epigraph.contract.SyncEntityType
import epigraph.sync.core.credentials.CoreCredentialBlobStore
import epigraph.sync.core.credentials.CoreCredentialCipher
import epigraph.sync.core.credentials.SealedCredential
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxAuthorization
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreTrackerCredential
import epigraph.sync.core.protocol.CoreTrackerCredentialDelete
import epigraph.sync.core.protocol.CoreTrackerCredentialList
import epigraph.sync.core.protocol.CoreTrackerCredentialWrite
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport
import epigraph.sync.core.work.CoreOutboxSyncConnection
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir

class CoreTrackingCapabilityCacheTest {
    @TempDir
    lateinit var directory: File

    @Test
    fun `negotiated tracking capabilities survive a restart and end with the pairing`() = runTest {
        val file = File(directory, "aethon-sync/tracker-capabilities-v1.json")
        val cache = CoreTrackingCapabilityCache(file)
        assertFalse(cache.advertises(COMIC_TRACKING))

        cache.onNegotiated(capabilities(trackerCredentials = true, "comic.tracking"))

        val restarted = CoreTrackingCapabilityCache(file)
        assertTrue(restarted.advertises(COMIC_TRACKING))
        assertFalse(restarted.advertises(NOVEL_TRACKING))
        assertFalse(restarted.advertises(SyncEntityType(EpigraphCoreEntityType.BOOK_CATEGORY)))
        assertTrue(restarted.supportsTrackerCredentials())

        restarted.onPairingEnded()

        assertFalse(file.exists())
        assertFalse(restarted.advertises(COMIC_TRACKING))
        assertFalse(CoreTrackingCapabilityCache(file).supportsTrackerCredentials())
    }

    @Test
    fun `unreadable cache advertises nothing`() = runTest {
        val file = File(directory, "tracker-capabilities-v1.json").apply { writeText("{not json") }

        assertFalse(CoreTrackingCapabilityCache(file).advertises(NOVEL_TRACKING))
    }

    @Test
    fun `session hook syncs credentials only when the core advertises them`() = runTest {
        val cache = CoreTrackingCapabilityCache(File(directory, "caps.json"))
        val channel = CountingChannel()
        val hook = TrackerSyncSessionHook(
            cache,
            TrackerCredentialSyncer(
                vault = TrackerCredentialVault(UnusedCipher, EmptyBlobs),
                source = EmptySource,
                deviceId = { "device-a" },
                ioDispatcher = Dispatchers.Unconfined,
            ),
        )
        val connection = ChannelConnection(channel)

        hook.onNegotiated(capabilities(trackerCredentials = false, "novel.tracking"), connection)
        assertEquals(0, channel.lists)
        assertTrue(cache.advertises(NOVEL_TRACKING))

        hook.onNegotiated(capabilities(trackerCredentials = true), connection)
        assertEquals(1, channel.lists)
        assertFalse(cache.advertises(NOVEL_TRACKING))
    }

    private fun capabilities(trackerCredentials: Boolean, vararg entityTypes: String) = CoreCapabilities(
        serverProtocolVersion = EpigraphCoreWireProtocol.CURRENT_VERSION,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("comics:profile:<paired-profile>"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = true,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = true,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
        snapshotEntityTypes = setOf(EpigraphCoreEntityType.BOOK_CATEGORY) + entityTypes,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
        supportsTrackerCredentialsV1 = trackerCredentials,
    )

    private class CountingChannel : TrackerCredentialChannel {
        var lists = 0

        override suspend fun list(): CoreHttpResult<CoreTrackerCredentialList> {
            lists++
            return CoreHttpResult.Success(CoreTrackerCredentialList())
        }

        override suspend fun put(
            trackerKey: String,
            write: CoreTrackerCredentialWrite,
        ): CoreHttpResult<CoreTrackerCredential> = error("no local logins")

        override suspend fun delete(
            trackerKey: String,
            delete: CoreTrackerCredentialDelete,
        ): CoreHttpResult<CoreTrackerCredential> = error("no local logins")
    }

    private class ChannelConnection(private val channel: TrackerCredentialChannel) : CoreOutboxSyncConnection {
        override val openedOrigin: String = "https://core.test"

        override suspend fun capabilities(): CoreHttpResult<CoreCapabilities> = error("not used")

        override suspend fun drainSuwayomi(
            nowEpochMillis: Long,
            canonicalProjectionEnabled: Boolean,
        ): SuwayomiMutationDrainReport = error("not used")

        override suspend fun drain(
            authorization: CoreOutboxAuthorization,
            capabilities: CoreCapabilities,
            nowEpochMillis: Long,
        ): CoreOutboxDrainReport = error("not used")

        override fun trackerCredentials(): TrackerCredentialChannel = channel
    }

    private object EmptySource : TrackerCredentialSource {
        override val syncIds: Set<Long> = setOf(1L)

        override fun read(syncId: Long): TrackerSecret? = null

        override fun apply(syncId: Long, secret: TrackerSecret?) = error("nothing to apply")
    }

    private object UnusedCipher : CoreCredentialCipher {
        override fun seal(plaintext: ByteArray, authenticatedData: ByteArray): SealedCredential = error("not used")

        override fun open(sealed: SealedCredential, authenticatedData: ByteArray): ByteArray = error("not used")
    }

    private object EmptyBlobs : CoreCredentialBlobStore {
        override fun read(): ByteArray? = null

        override fun writeAtomically(value: ByteArray) = error("not used")

        override fun delete() = Unit
    }

    private companion object {
        val COMIC_TRACKING = SyncEntityType("comic.tracking")
        val NOVEL_TRACKING = SyncEntityType("novel.tracking")
    }
}
