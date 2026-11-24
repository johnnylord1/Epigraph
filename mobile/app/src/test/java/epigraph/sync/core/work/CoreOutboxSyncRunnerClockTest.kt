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

    @Test
    fun `post-backfill hooks run after backfill and drain what they queue even when only catalog retries`() = runTest {
        val events = mutableListOf<String>()
        var pending = 0L
        var backfillPasses = 0
        val replica = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { _, _, _ ->
                events += "core-replica"
                CoreReplicaSyncOutcome.APPLIED
            },
            catalog = CoreReplicaSyncPort { _, _, _ ->
                events += "catalog-retry"
                CoreReplicaSyncOutcome.RETRY
            },
        )
        val runner = testRunner(
            replica = replica,
            pending = { pending },
            onDrain = {
                events += "drain:$pending"
                val drained = pending.toInt()
                pending = 0L
                epigraph.sync.core.outbox.CoreOutboxDrainReport(drained, drained, drained, 0, 0)
            },
            negotiatedHooks = listOf(CoreNegotiatedSessionHook { _, _ -> events += "negotiated" }),
            replicaAppliedHooks = listOf(CoreReplicaAppliedHook { events += "replica-hook" }),
            postBackfillHooks = listOf(
                CoreNegotiatedSessionHook { _, _ ->
                    events += "post-backfill-categories"
                    pending += 2L
                },
                CoreNegotiatedSessionHook { _, _ -> events += "post-backfill-extensions" },
            ),
        )

        val outcome = runner.run(
            nowEpochMillis = 1_000,
            synchronizeReplica = true,
            backfill = { onQueued ->
                backfillPasses += 1
                if (backfillPasses == 1) {
                    events += "backfill"
                    pending += 3L
                    onQueued()
                    3
                } else {
                    0
                }
            },
        )

        assertEquals(
            listOf(
                "negotiated",
                "drain:0",
                "catalog-retry",
                "core-replica",
                "replica-hook",
                "backfill",
                "drain:3",
                "post-backfill-categories",
                "drain:2",
                "post-backfill-extensions",
            ),
            events,
        )
        assertEquals(CoreOutboxSyncOutcome.Retry(0L, CoreOutboxRetryReason.REPLICA), outcome)
    }

    @Test
    fun `backfill and post-backfill hooks do not run when the core replica stage itself retries`() = runTest {
        val events = mutableListOf<String>()
        val replica = CompositeCoreReplicaSync(
            replica = CoreReplicaSyncPort { _, _, _ ->
                events += "core-replica-retry"
                CoreReplicaSyncOutcome.RETRY
            },
            catalog = CoreReplicaSyncPort { _, _, _ -> CoreReplicaSyncOutcome.APPLIED },
        )
        val runner = testRunner(
            replica = replica,
            pending = { 0L },
            onDrain = { epigraph.sync.core.outbox.CoreOutboxDrainReport(0, 0, 0, 0, 0) },
            replicaAppliedHooks = listOf(CoreReplicaAppliedHook { events += "replica-hook" }),
            postBackfillHooks = listOf(CoreNegotiatedSessionHook { _, _ -> events += "post-backfill" }),
        )

        runner.run(
            nowEpochMillis = 1_000,
            synchronizeReplica = true,
            backfill = {
                events += "backfill"
                0
            },
        )

        assertEquals(listOf("core-replica-retry"), events)
    }

    private fun testRunner(
        replica: CoreReplicaSyncPort,
        pending: () -> Long,
        onDrain: () -> epigraph.sync.core.outbox.CoreOutboxDrainReport,
        negotiatedHooks: List<CoreNegotiatedSessionHook> = emptyList(),
        replicaAppliedHooks: List<CoreReplicaAppliedHook> = emptyList(),
        postBackfillHooks: List<CoreNegotiatedSessionHook> = emptyList(),
    ): CoreOutboxSyncRunner {
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
        return CoreOutboxSyncRunner(
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
                    ) = onDrain()
                }
            },
            pendingOutbox = object : CorePendingOutbox {
                override suspend fun count(): Long = pending()
            },
            replica = replica,
            policies = epigraph.sync.core.policy.SyncPolicyResolver(ClockTestSelectionStore),
            negotiatedHooks = negotiatedHooks,
            replicaAppliedHooks = replicaAppliedHooks,
            postBackfillHooks = postBackfillHooks,
        )
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
