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
