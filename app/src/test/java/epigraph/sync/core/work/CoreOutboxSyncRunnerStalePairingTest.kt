package epigraph.sync.core.work

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.session.CorePairingStaleException
import kotlinx.coroutines.test.runTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class CoreOutboxSyncRunnerStalePairingTest {
    @Test
    fun `rotated core identity surfaces as NeedsPairing instead of endless retry`() = runTest {
        val session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "server-one",
            accessTokenUtf8 = byteArrayOf(1, 2, 3),
        )
        val runner = CoreOutboxSyncRunner(
            credentials = object : CoreCredentialStore {
                override fun load(): CoreCredentialSession? = session
                override fun replace(replacement: CoreCredentialSession) = Unit
                override fun delete() = Unit
            },
            devices = CoreDeviceIdentityProvider { "device-one" },
            connections = CoreOutboxSyncConnectionFactory { throw CorePairingStaleException("stale") },
            pendingOutbox = object : CorePendingOutbox {
                override suspend fun count(): Long = 3
            },
            replica = SnapshotCoreReplicaSyncNoop,
            policies = epigraph.sync.core.policy.SyncPolicyResolver(NoopSelectionStore),
        )

        val outcome = runner.run(nowEpochMillis = 1_000)

        assertEquals(
            CoreOutboxSyncOutcome.NeedsPairing(3L, CorePairingRequirement.IDENTITY_MISMATCH),
            outcome,
        )
        session.close()
    }

    @Test
    fun `legacy credential is upgraded and run restarts with real server id`() = runTest {
        val session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf("comics:profile:main"),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "legacy_unbound",
            accessTokenUtf8 = byteArrayOf(1, 2, 3),
        )
        var stored: CoreCredentialSession = session
        var replaced: String? = null
        var loads = 0
        val runner = CoreOutboxSyncRunner(
            credentials = object : CoreCredentialStore {
                override fun load(): CoreCredentialSession? {
                    loads++
                    return stored.copyWithServerMetadata()
                }
                override fun replace(replacement: CoreCredentialSession) {
                    stored = replacement.copyWithServerMetadata()
                    replaced = stored.serverId
                }
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
                            )
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
                            )
                        )
                    override suspend fun drainSuwayomi(
                        nowEpochMillis: Long,
                        canonicalProjectionEnabled: Boolean,
                    ) = epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport(0, 0, 0, 0, 0)
                    override suspend fun drain(
                        authorization: epigraph.sync.core.outbox.CoreOutboxAuthorization,
                        capabilities: epigraph.sync.core.protocol.CoreCapabilities,
                        nowEpochMillis: Long,
                    ) = epigraph.sync.core.outbox.CoreOutboxDrainReport(0, 0, 0, 0, 0)
                }
            },
            pendingOutbox = object : CorePendingOutbox {
                override suspend fun count(): Long = 0
            },
            replica = SnapshotCoreReplicaSyncNoop,
            policies = epigraph.sync.core.policy.SyncPolicyResolver(NoopSelectionStore),
        )

        runner.run(nowEpochMillis = 1_000)

        assertEquals("srv1", replaced)
        assertEquals(2, loads)
        session.close()
    }
}

private object NoopSelectionStore : epigraph.sync.core.policy.DeviceSyncSelectionStore {
    override fun load(serverId: String, profileId: String, deviceId: String) = null
    override fun upsert(selection: epigraph.sync.core.policy.DeviceSyncSelectionV1) = Unit
    override fun delete(serverId: String, profileId: String, deviceId: String) = Unit
}

private object SnapshotCoreReplicaSyncNoop : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: epigraph.sync.core.protocol.CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome = CoreReplicaSyncOutcome.DEFERRED
}
