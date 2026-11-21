package epigraph.sync.core.work

import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ClientMutationId
import epigraph.contract.DecimalSourceId
import epigraph.contract.DeviceId
import epigraph.contract.EpigraphEntityId
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncScopeId
import epigraph.sync.ClientMutationIdFactory
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationAcknowledgement
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.EpigraphSyncScopes
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.credentials.LEGACY_UNBOUND_SERVER_ID
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxAuthorization
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.DeviceSyncSelectionV1
import epigraph.sync.core.policy.SyncPolicyResolver
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.replica.SqlDelightCoreReplicaStore
import epigraph.sync.core.suwayomi.LocalComicLibraryOutboxRepair
import epigraph.sync.core.suwayomi.SuwayomiMutationDrainReport
import epigraph.sync.portable.PortableWorkBindingRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import eu.kanade.tachiyomi.source.SourceManager
import io.mockk.coEvery
import io.mockk.mockk
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.memoColumnAdapter

class CoreQueueHandOverTest {
    private val driver = JdbcSqliteDriver(
        JdbcSqliteDriver.IN_MEMORY,
        java.util.Properties().apply { put("foreign_keys", "true") },
    ).also { Database.Schema.create(it) }
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val queries = database.aethon_syncQueries
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val coordinator = EpigraphMutationCoordinator(handler)
    private val replica = SqlDelightCoreReplicaStore(handler)
    private val sources = mockk<SourceManager>().also {
        coEvery { it.awaitExtensionSource(any(), any()) } returns null
    }
    private val json = Json {
        classDiscriminator = "operation"
        ignoreUnknownKeys = false
    }

    private class MemoryOwner(var current: String? = null) : CoreQueueHandOver.Owner {
        override fun get(): String? = current
        override fun set(serverId: String) {
            current = serverId
        }
    }

    @AfterEach
    fun closeDriver() = driver.close()

    @Test
    fun `hands over blocked rows and replica waits once per server while keeping plain receipts and pending rows`() = runTest {
        // 1. Blocked row from Core A
        enqueueOutbox("mut-blocked", "comic:blocked", status = "ERROR", lastError = "blocked:entity_capability_not_advertised")
        // 2. Genuine pending row
        enqueueOutbox("mut-pending", "comic:pending", status = "PENDING", lastError = null)
        // 3. Transient error row
        enqueueOutbox("mut-transient", "comic:transient", status = "ERROR", lastError = "network_unreachable")
        // 4. Receipt backed by an orphaned replica wait from Core A
        queries.upsertReceipt(DEVICE, "mut-waited", "comic:waited", 100)
        queries.upsertReplicaWait(
            DEVICE, "mut-waited", COMIC_SCOPE, EpigraphCoreEntityType.COMIC_ENTRY,
            "comic:waited", "comic:waited", "APPLIED", 900, 1, null, null, 100,
        )
        // 5. Plain receipt without a replica wait (already confirmed on A)
        queries.upsertReceipt(DEVICE, "mut-plain", "comic:plain", 100)

        val owner = MemoryOwner("server-a")
        val handOver = CoreQueueHandOver(handler, owner)

        // Switching to Core B releases blocked rows and waits, dropping only receipts behind waits.
        val first = handOver.handTo("server-b")
        assertEquals(CoreQueueHandOver.Released(requeued = 1, waits = 1), first)
        assertEquals("server-b", owner.current)
        assertEquals(0, queries.blockedMutationCount().executeAsOne())
        assertEquals(0, queries.replicaWaitCount().executeAsOne())
        assertEquals(1, receiptCount())
        assertEquals(3, coordinator.claimReady(System.currentTimeMillis(), 1_000, 10).size)

        // A row Core B itself refuses stays blocked on subsequent runs against Core B.
        coordinator.markFailed(DeviceId(DEVICE), ClientMutationId("mut-blocked"), "blocked:invalid_payload", Long.MAX_VALUE)
        assertNull(handOver.handTo("server-b"))
        assertEquals(1, queries.blockedMutationCount().executeAsOne())

        // Switching again to Core C releases Core B's refusal once.
        val second = handOver.handTo("server-c")
        assertEquals(CoreQueueHandOver.Released(requeued = 1, waits = 0), second)
        assertEquals("server-c", owner.current)
        assertEquals(0, queries.blockedMutationCount().executeAsOne())
    }

    @Test
    fun `ignores blank and legacy unbound server ids`() = runTest {
        enqueueOutbox("mut-blocked", "comic:blocked", status = "ERROR", lastError = "blocked:bad")
        val owner = MemoryOwner()
        val handOver = CoreQueueHandOver(handler, owner)

        assertNull(handOver.handTo(""))
        assertNull(handOver.handTo("   "))
        assertNull(handOver.handTo(LEGACY_UNBOUND_SERVER_ID))
        assertNull(owner.current)
        assertEquals(1, queries.blockedMutationCount().executeAsOne())
    }

    @Test
    fun `clears orphaned replica wait on already-switched phone so library repair republishes comic entry`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/manga/bleach"))
        val workId = PortableIdentityV3.workId(work)
        insertBoundFavorite(work, workId, "Bleach")

        // Simulate a phone already switched to Core B before this fix existed: B's snapshot is
        // replayed without Bleach, while an orphaned replica_wait from Core A (sv 900) remains.
        queries.upsertCoreReplicaCheckpoint("comics", "FILTERED", COMIC_SCOPE, 120, 1)
        queries.upsertReceipt(DEVICE, "ack-from-a", workId, 1)
        queries.upsertReplicaWait(
            DEVICE, "ack-from-a", COMIC_SCOPE, EpigraphCoreEntityType.COMIC_ENTRY,
            workId, workId, "APPLIED", 900, 1, null, null, 1,
        )

        // Before handover, repair treats Bleach as already in flight.
        assertEquals(0, repair("server-b").repair())

        // First sync on upgraded app has no recorded owner yet -> hands over to Core B once.
        val handOver = CoreQueueHandOver(handler, MemoryOwner(null))
        assertEquals(CoreQueueHandOver.Released(requeued = 0, waits = 1), handOver.handTo("server-b"))

        // Now repair republishes Bleach's comic.entry to Core B.
        val emitted = repair("server-b").repair()
        assertEquals(1, emitted)
        val command = coordinator.claimReady(System.currentTimeMillis(), 1_000, 10)
            .map { json.decodeFromString<SyncCommandEnvelope>(it.payload_json).command }
            .single() as SyncCommand.SetLibraryMembership
        assertEquals(workId, command.entityId.value)
        assertEquals(work, command.portableWorkRef)
    }

    @Test
    fun `switching the queue owner discards replay already written by the previous Core`() = runTest {
        val handOver = CoreQueueHandOver(handler, MemoryOwner("server-a"))
        queries.upsertCoreReplicaCheckpoint("comics", "FILTERED", COMIC_SCOPE, 900, 1)

        handOver.handTo("server-b")

        assertNull(queries.selectCoreReplicaCheckpoint("comics").executeAsOneOrNull())
        queries.upsertCoreReplicaCheckpoint("comics", "FILTERED", COMIC_SCOPE, 10, 1)
        handOver.handTo("server-b")
        assertEquals(10L, queries.selectCoreReplicaCheckpoint("comics").executeAsOne().last_global_event_id)
    }

    @Test
    fun `rewinding Core history drops stale waits so library repair can publish again`() = runTest {
        val work = PortableWorkRef.Comic(DecimalSourceId("42"), ProviderOwnedKey("/manga/eleceed"))
        val workId = PortableIdentityV3.workId(work)
        insertBoundFavorite(work, workId, "Eleceed")
        queries.upsertReceipt(DEVICE, "ack-from-a", workId, 1)
        queries.upsertReceipt(DEVICE, "plain-receipt", "comic:other", 1)
        queries.upsertReplicaWait(
            DEVICE, "ack-from-a", COMIC_SCOPE, EpigraphCoreEntityType.COMIC_ENTRY,
            workId, workId, "APPLIED", 900, 1, null, null, 1,
        )

        replica.resetAfterHistoryRewind()

        assertEquals(0, queries.replicaWaitCount().executeAsOne())
        assertEquals(1, receiptCount())
        queries.upsertCoreReplicaCheckpoint("comics", "FILTERED", COMIC_SCOPE, 10, 1)
        assertEquals(1, repair("server-b").repair())
    }

    @Test
    fun `replica reset on re-pairing the same Core preserves its waits and receipts`() = runTest {
        queries.upsertReceipt(DEVICE, "ack-from-a", "comic:waiting", 1)
        queries.upsertReplicaWait(
            DEVICE, "ack-from-a", COMIC_SCOPE, EpigraphCoreEntityType.COMIC_ENTRY,
            "comic:waiting", "comic:waiting", "APPLIED", 900, 1, null, null, 1,
        )

        replica.reset()
        CoreQueueHandOver(handler, MemoryOwner("server-a")).handTo("server-a")

        assertEquals(1, queries.replicaWaitCount().executeAsOne())
        assertEquals(1, receiptCount())
    }

    @Test
    fun `sync runner hands over queue before draining outbox`() = runTest {
        enqueueOutbox("mut-blocked", "comic:blocked", status = "ERROR", lastError = "blocked:old_core")
        var blockedSeenAtDrain = -1L
        val session = CoreCredentialSession(
            origin = "https://core.test/",
            tlsCertSha256 = "a".repeat(64),
            pairingSessionId = "pairing",
            profileId = "main",
            tokenId = "token",
            scopes = listOf(COMIC_SCOPE),
            inactivityExpiresAtMs = Long.MAX_VALUE,
            serverId = "server-b",
            accessTokenUtf8 = byteArrayOf(1, 2, 3),
        )
        val owner = MemoryOwner("server-a")
        val runner = CoreOutboxSyncRunner(
            credentials = object : CoreCredentialStore {
                override fun load(): CoreCredentialSession? = session.copyWithServerMetadata()
                override fun replace(session: CoreCredentialSession) = Unit
                override fun delete() = Unit
            },
            devices = CoreDeviceIdentityProvider { DEVICE },
            connections = CoreOutboxSyncConnectionFactory {
                object : CoreOutboxSyncConnection {
                    override val openedOrigin = "https://core.test/"
                    override suspend fun capabilities() = CoreHttpResult.Success(compatibleCapabilities())
                    override suspend fun drainSuwayomi(nowEpochMillis: Long, canonicalProjectionEnabled: Boolean) =
                        SuwayomiMutationDrainReport(0, 0, 0, 0, 0)
                    override suspend fun drain(
                        authorization: CoreOutboxAuthorization,
                        capabilities: CoreCapabilities,
                        nowEpochMillis: Long,
                    ): CoreOutboxDrainReport {
                        blockedSeenAtDrain = queries.blockedMutationCount().executeAsOne()
                        return CoreOutboxDrainReport(0, 0, 0, 0, 0)
                    }
                }
            },
            pendingOutbox = object : CorePendingOutbox {
                override suspend fun count(): Long = 0
            },
            replica = CoreReplicaSyncPort { _, _, _ -> CoreReplicaSyncOutcome.DEFERRED },
            policies = SyncPolicyResolver(
                object : DeviceSyncSelectionStore {
                    override fun load(serverId: String, profileId: String, deviceId: String) = null
                    override fun upsert(selection: DeviceSyncSelectionV1) = Unit
                    override fun delete(serverId: String, profileId: String, deviceId: String) = Unit
                },
            ),
            queueHandOver = CoreQueueHandOver(handler, owner),
        )

        runner.run(nowEpochMillis = 1_000)

        assertEquals(0L, blockedSeenAtDrain)
        assertEquals("server-b", owner.current)
        assertNotNull(coordinator.claimReady(1_000, 1_000, 10).singleOrNull())
        session.close()
    }

    private fun enqueueOutbox(mutationId: String, entityId: String, status: String, lastError: String?) {
        queries.enqueueMutation(
            clientMutationId = mutationId,
            deviceId = DEVICE,
            scopeId = COMIC_SCOPE,
            entityType = EpigraphCoreEntityType.COMIC_ENTRY,
            entityId = entityId,
            operation = "set_library_membership",
            payloadJson = "{}",
            createdAt = 100,
            nextAttemptAt = if (status == "ERROR" && lastError?.startsWith("blocked:") == true) Long.MAX_VALUE else 0,
        )
        if (status == "ERROR" && lastError != null) {
            queries.markMutationFailed(
                nextAttemptAt = if (lastError.startsWith("blocked:")) Long.MAX_VALUE else 0,
                lastError = lastError,
                deviceId = DEVICE,
                clientMutationId = mutationId,
            )
        }
    }

    private fun insertBoundFavorite(work: PortableWorkRef.Comic, workId: String, title: String) {
        database.mangasQueries.insert(
            source = 42L, url = work.mangaKey.value, artist = null, author = null, description = null,
            genre = null, title = title, status = 0, thumbnailUrl = null, favorite = true,
            lastUpdate = 0, initialized = true, viewer = 0, hideTitle = false, chapterFlags = 0,
            dateAdded = 0, filteredScanlators = null, updateStrategy = 0, coverLastModified = 0,
            nextUpdate = 0, fetchInterval = 0, memo = JsonObject(emptyMap()),
        )
        val mangaId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        queries.upsertIdentity(workId, "MANGA", mangaId.toString(), 1, 1)
        SqlDelightPortableBindingStore(database).upsertWork(
            PortableWorkBindingRecord(
                portableId = workId,
                ref = work,
                localReference = mangaId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = title,
                providerLabelHint = null,
                attemptCount = 0,
                updatedAt = 1,
            ),
        )
    }

    private fun repair(serverId: String): LocalComicLibraryOutboxRepair {
        val scopes = EpigraphSyncScopeProvider {
            EpigraphSyncScopes(SyncScopeId("novels:profile:main"), SyncScopeId(COMIC_SCOPE), serverId)
        }
        var sequence = 0
        val router = EpigraphLibraryMutationRouter(
            coordinator = coordinator,
            deviceId = DeviceId(DEVICE),
            scopeId = SyncScopeId(COMIC_SCOPE),
            mutationIds = ClientMutationIdFactory { ClientMutationId("repair-${++sequence}") },
            scopeProvider = scopes,
        )
        return LocalComicLibraryOutboxRepair(handler, sources, router, scopes)
    }

    private fun receiptCount(): Long =
        driver.executeQuery(
            null,
            "SELECT COUNT(*) FROM aethon_sync_receipt",
            { cursor ->
                cursor.next()
                app.cash.sqldelight.db.QueryResult.Value(cursor.getLong(0)!!)
            },
            0,
        ).value

    private fun compatibleCapabilities() = CoreCapabilities(
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

    private companion object {
        const val COMIC_SCOPE = "comics:profile:main"
        const val DEVICE = "phone-a"
    }
}
