package epigraph.sync.core.work

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreOutboxSyncRunnerClockTest {
    @Test
    fun `each drained batch claims with the current time so rows queued during the run are sent`() = runTest {
        val session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "srv1",
            accessTokenUtf8 = byteArrayOf(1, 2, 3),
        )
        var pending = 3L
        val drainedAt = mutableListOf<Long>()
        // The first reading is earlier than the run start; a batch never claims with an older time.
        val readings = ArrayDeque(listOf(500L, 2_000L, 3_000L, 4_000L))
        val runner = CoreOutboxSyncRunner(
            credentials = object : CoreCredentialStore {
                override fun load(): CoreCredentialSession = session
                override fun replace(replacement: CoreCredentialSession) = Unit
                override fun delete() = Unit
            },
            devices = CoreDeviceIdentityProvider { "device-one" },
            connections = CoreOutboxSyncConnectionFactory {
                object : CoreOutboxSyncConnection {
                    override val openedOrigin = "https://core.test/"
                    override suspend fun sessionMetadata() =
                        epigraph.sync.core.http.CoreHttpResult.Success(
                            epigraph.sync.core.protocol.CoreSessionResponse(
                                schemaVersion = 1,
                                serverId = "srv1",
                                profileId = "main",
                                tokenId = "token",
                                scopes = listOf("comics:profile:main"),
                                inactivityExpiresAtMs = Long.MAX_VALUE,
                                effectiveBaseUrl = "https://core.test/",
                                tlsCertSha256 = "a".repeat(64),
                                mdnsServiceName = "_epigraph-sync._tcp.local.",
                            ),
                        )
                    override suspend fun capabilities() =
                        epigraph.sync.core.http.CoreHttpResult.Success(
                            epigraph.sync.core.protocol.CoreCapabilities(
                                serverProtocolVersion = 1,
                                minClientVersion = "0.1.0",
                                supportedScopes = listOf("comics:profile:*"),
                                supportsSseReplay = true,
                                supportsManualIpFallback = true,
                                supportsOwnerTransfer = false,
                                supportsSnapshot = true,
                                supportsAssets = true,
                                supportsNovelChapterAssets = true,
                                supportsNovelPluginSync = true,
                                supportsSuwayomiProxy = true,
                                supportsCausalMutationsV3 = true,
                                supportsSuwayomiCatalog = true,
                                supportsSuwayomiContent = true,
                                supportsSuwayomiExtensionInventory = true,
                                supportsSuwayomiWebsocketProxy = false,
                                suwayomiProxyPathTemplate = "/v1/suwayomi/{profileId}/graphql",
                                snapshotSchemaVersion = 3,
                                snapshotEntityTypes = emptySet(),
                                tlsCertSha256 = "a".repeat(64),
                                mdnsServiceName = "_epigraph-sync._tcp.local.",
                                currentServerVersion = 1,
                                minReplayableServerVersion = 0,
                            ),
                        )
                    override suspend fun drainSuwayomi(
                        nowEpochMillis: Long,
                        canonicalProjectionEnabled: Boolean,
                    ) = epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport(0, 0, 0, 0, 0)
                    override suspend fun drain(
                        authorization: epigraph.sync.core.outbox.CoreOutboxAuthorization,
                        capabilities: epigraph.sync.core.protocol.CoreCapabilities,
                        nowEpochMillis: Long,
                    ): epigraph.sync.core.outbox.CoreOutboxDrainReport {
                        drainedAt += nowEpochMillis
                        pending -= 1
                        return epigraph.sync.core.outbox.CoreOutboxDrainReport(1, 1, 1, 0, 0)
                    }
                }
            },
            pendingOutbox = object : CorePendingOutbox {
                override suspend fun count(): Long = pending
            },
            replica = ClockTestReplicaNoop,
            policies = epigraph.sync.core.policy.SyncPolicyResolver(ClockTestSelectionStore),
            clock = { readings.removeFirstOrNull() ?: 9_000L },
        )

        runner.run(nowEpochMillis = 1_000)

        assertEquals(listOf(1_000L, 2_000L, 3_000L), drainedAt)
        session.close()
    }
}

private object ClockTestSelectionStore : epigraph.sync.core.policy.DeviceSyncSelectionStore {
    override fun load(serverId: String, profileId: String, deviceId: String) = null
    override fun upsert(selection: epigraph.sync.core.policy.DeviceSyncSelectionV1) = Unit
    override fun delete(serverId: String, profileId: String, deviceId: String) = Unit
}

private object ClockTestReplicaNoop : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: epigraph.sync.core.protocol.CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome = CoreReplicaSyncOutcome.DEFERRED
}
