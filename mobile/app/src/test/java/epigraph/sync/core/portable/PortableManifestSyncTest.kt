package epigraph.sync.core.portable
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.memoColumnAdapter

import android.util.Log
import app.cash.sqldelight.driver.jdbc.sqlite.JdbcSqliteDriver
import epigraph.contract.ComicDependency
import epigraph.contract.DecimalSourceId
import epigraph.contract.ExtensionStoreReference
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableEcosystem
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreErrorDetail
import epigraph.sync.core.protocol.CoreErrorEnvelope
import epigraph.sync.core.protocol.CorePortableComicWork
import epigraph.sync.core.protocol.CorePortableManifest
import epigraph.sync.core.protocol.CorePortableManifestPage
import epigraph.sync.core.session.CoreEndpoint
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.CoreSessionTransports
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.portable.PortableBootstrapPhase
import epigraph.sync.portable.PortableBootstrapRecord
import epigraph.sync.portable.PortableComicDependencyRecord
import epigraph.sync.portable.SqlDelightPortableBindingStore
import epigraph.sync.portable.SqlDelightPortableBootstrapStore
import epigraph.sync.portable.SqlDelightPortableDependencyStore
import io.mockk.coEvery
import io.mockk.every
import io.mockk.mockk
import io.mockk.mockkStatic
import io.mockk.unmockkStatic
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database

class PortableManifestSyncTest {
    private val driver = JdbcSqliteDriver(JdbcSqliteDriver.IN_MEMORY).also(Database.Schema::create)
    private val database = Database(driver, Chapters.Adapter(memoColumnAdapter), Mangas.Adapter(memoColumnAdapter))
    private val handler = AndroidDatabaseHandler(database, driver, Dispatchers.IO, Dispatchers.IO)
    private val session = CoreCredentialSession(
        origin = ORIGIN,
        tlsCertSha256 = "a".repeat(64),
        pairingSessionId = "pairing",
        profileId = PROFILE,
        tokenId = "token",
        scopes = listOf("comics:profile:$PROFILE"),
        inactivityExpiresAtMs = Long.MAX_VALUE,
        serverId = SERVER,
        accessTokenUtf8 = byteArrayOf(1, 2, 3),
    )

    @AfterEach
    fun close() {
        session.close()
        driver.close()
    }

    @Test
    fun `manifest preserves trust for the same store and resets it when provenance changes`() = runTest {
        val dependencies = SqlDelightPortableDependencyStore(database)
        dependencies.upsertComic(
            PortableComicDependencyRecord(
                serverId = SERVER,
                profileId = PROFILE,
                dependency = dependency(STORE_ONE),
                trustState = "TRUSTED",
                resolution = PortableResolution(PortableResolutionState.PENDING_DEPENDENCY),
                updatedAt = 1,
            ),
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(STORE_ONE)))
        assertEquals("TRUSTED", dependencies.comics(SERVER, PROFILE).single().trustState)

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(STORE_TWO)))
        assertEquals("APPROVAL_REQUIRED", dependencies.comics(SERVER, PROFILE).single().trustState)
    }

    @Test
    fun `dependency without portable provenance uses only locally trusted providers`() = runTest {
        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(null)))

        val stored = SqlDelightPortableDependencyStore(database).comics(SERVER, PROFILE).single()
        assertNull(stored.dependency.extensionStore)
        assertEquals("TRUSTED", stored.trustState)
    }

    @Test
    fun `unchanged manifest preserves pending resolution evidence`() = runTest {
        val bindings = SqlDelightPortableBindingStore(database)
        bindings.upsertWork(
            epigraph.sync.portable.PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(WORK_REF),
                ref = WORK_REF,
                dependencyKey = PACKAGE,
                localReference = null,
                resolution = PortableResolution(
                    PortableResolutionState.PENDING_DEPENDENCY,
                    epigraph.contract.PortableResolutionReason.EXTENSION_NOT_FOUND,
                ),
                titleHint = null,
                providerLabelHint = null,
                attemptCount = 2,
                updatedAt = 5,
            ),
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(null)))

        val stored = requireNotNull(bindings.work(WORK_REF))
        assertEquals(epigraph.contract.PortableResolutionReason.EXTENSION_NOT_FOUND, stored.resolution.reason)
        assertEquals(2, stored.attemptCount)
        assertEquals(5, stored.updatedAt)
    }

    @Test
    fun `manifest reopens a stale bound bridge placeholder for exact source resolution`() = runTest {
        database.mangasQueries.insert(
            source = epigraph.sync.core.suwayomi.EpigraphCoreSource.ID,
            url = "aethon-core://suwayomi/main/manga/1",
            artist = null,
            author = null,
            description = null,
            genre = null,
            title = "Bridge placeholder",
            status = 0,
            thumbnailUrl = "aethon-core://suwayomi/main/manga/1",
            favorite = true,
            lastUpdate = null,
            initialized = true,
            viewer = 0,
            hideTitle = false,
            chapterFlags = 0,
            dateAdded = null,
            filteredScanlators = null,
            updateStrategy = 0,
            coverLastModified = 0,
            nextUpdate = 0,
            fetchInterval = 0,
            memo = JsonObject(emptyMap()),
        )
        val localId = database.mangasQueries.selectLastInsertedRowId().executeAsOne()
        val bindings = SqlDelightPortableBindingStore(database)
        bindings.upsertWork(
            epigraph.sync.portable.PortableWorkBindingRecord(
                portableId = PortableIdentityV3.workId(WORK_REF),
                ref = WORK_REF,
                dependencyKey = null,
                localReference = localId.toString(),
                resolution = PortableResolution(PortableResolutionState.BOUND),
                titleHint = "Bridge placeholder",
                providerLabelHint = null,
                attemptCount = 1,
                updatedAt = 5,
            ),
        )
        val dependencyless = manifest(STORE_ONE).copy(
            comicDependencies = emptyList(),
            works = listOf(
                CorePortableComicWork(
                    portableId = PortableIdentityV3.workId(WORK_REF),
                    reference = WORK_REF,
                    dependencyPackageName = null,
                ),
            ),
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(dependencyless))

        val stored = requireNotNull(bindings.work(WORK_REF))
        assertEquals(PortableResolutionState.PENDING_PROVIDER, stored.resolution.state)
        assertEquals(localId.toString(), stored.localReference)
        assertEquals(listOf(stored.portableId), bindings.pendingWorks(SERVER, PROFILE, 10).map { it.portableId })
    }

    @Test
    fun `manifest rejects a work whose package does not expose its source id`() = runTest {
        val inconsistent = manifest(STORE_ONE).copy(
            comicDependencies = listOf(
                dependency(STORE_ONE).copy(requiredSourceIds = setOf(DecimalSourceId("2002"))),
            ),
        )

        assertEquals(CoreReplicaSyncOutcome.RETRY, synchronize(inconsistent))
        assertTrue(SqlDelightPortableDependencyStore(database).comics(SERVER, PROFILE).isEmpty())
        assertNull(SqlDelightPortableBindingStore(database).work(WORK_REF))
    }

    @Test
    fun `bootstrap remains partial while a chapter is pending`() = runTest {
        val report = PortableHydrationReport(
            examinedDependencies = 1,
            dependenciesRequiringUserAction = 0,
            examinedWorks = 1,
            boundWorks = 1,
            pendingWorks = 0,
            boundChapters = 0,
            pendingChapters = 1,
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(STORE_ONE), report))
        val bootstrap = requireNotNull(
            SqlDelightPortableBootstrapStore(database).load(SERVER, PROFILE, epigraph.contract.PortableEcosystem.SUWAYOMI),
        )
        assertEquals(PortableBootstrapPhase.PARTIAL, bootstrap.phase)
        assertNull(bootstrap.lastReason)
    }

    @Test
    fun `bootstrap remains partial without blocking independent work while dependency trust is unresolved`() = runTest {
        val report = PortableHydrationReport(
            examinedDependencies = 1,
            dependenciesRequiringUserAction = 1,
            examinedWorks = 1,
            boundWorks = 0,
            pendingWorks = 1,
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(STORE_ONE), report))
        val bootstrap = requireNotNull(
            SqlDelightPortableBootstrapStore(database).load(SERVER, PROFILE, epigraph.contract.PortableEcosystem.SUWAYOMI),
        )
        assertEquals(PortableBootstrapPhase.PARTIAL, bootstrap.phase)
        assertEquals(PortableBootstrapPhase.WAITING_TRUST.name, bootstrap.lastReason)
    }

    @Test
    fun `secret bearing works are omitted without blocking independent bootstrap pages`() = runTest {
        val omitted = manifest(STORE_ONE).copy(
            page = CorePortableManifestPage(
                offset = 0,
                pageSize = PAGE_SIZE,
                hasNextPage = false,
                totalCount = 1,
                omittedCount = 1,
            ),
            comicDependencies = emptyList(),
            works = emptyList(),
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(omitted))
        val bootstrap = requireNotNull(
            SqlDelightPortableBootstrapStore(database).load(SERVER, PROFILE, epigraph.contract.PortableEcosystem.SUWAYOMI),
        )
        assertEquals(PortableBootstrapPhase.PARTIAL, bootstrap.phase)
        assertEquals("WORK_RESOLUTION_UNSUPPORTED", bootstrap.lastReason)
    }

    @Test
    fun `comic and novel bootstrap checkpoints remain independent`() {
        val store = SqlDelightPortableBootstrapStore(database)
        store.upsert(
            PortableBootstrapRecord(
                serverId = SERVER,
                profileId = PROFILE,
                ecosystem = PortableEcosystem.SUWAYOMI,
                bootstrapId = "comic-bootstrap",
                phase = PortableBootstrapPhase.PARTIAL,
                updatedAt = NOW,
            ),
        )
        store.upsert(
            PortableBootstrapRecord(
                serverId = SERVER,
                profileId = PROFILE,
                ecosystem = PortableEcosystem.LNREADER,
                bootstrapId = "novel-bootstrap",
                phase = PortableBootstrapPhase.COMPLETED,
                updatedAt = NOW + 1,
            ),
        )

        assertEquals("comic-bootstrap", store.load(SERVER, PROFILE, PortableEcosystem.SUWAYOMI)?.bootstrapId)
        assertEquals("novel-bootstrap", store.load(SERVER, PROFILE, PortableEcosystem.LNREADER)?.bootstrapId)
    }

    @Test
    fun `future manifest schema is deferred without retry`() = runTest {
        val response = CoreHttpResult.Failure(
            statusCode = 422,
            errorEnvelope = CoreErrorEnvelope(
                CoreErrorDetail(
                    code = "CLIENT_RESPONSE_UNSUPPORTED",
                    message = "Future portable manifest schema",
                    retryable = false,
                ),
            ),
        )

        mockkStatic(Log::class)
        try {
            every { Log.w(any(), any<String>()) } returns 0
            assertEquals(CoreReplicaSyncOutcome.DEFERRED, synchronize(response))
        } finally {
            unmockkStatic(Log::class)
        }
    }

    @Test
    fun `complete manifest removes only stale membership and preserves portable binding`() = runTest {
        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(manifest(STORE_ONE)))
        assertEquals(1, SqlDelightPortableBindingStore(database).pendingWorks(SERVER, PROFILE, 10).size)
        val empty = manifest(STORE_ONE).copy(
            generatedAtMs = NOW + 1,
            page = CorePortableManifestPage(0, PAGE_SIZE, hasNextPage = false, totalCount = 0),
            comicDependencies = emptyList(),
            works = emptyList(),
        )

        assertEquals(CoreReplicaSyncOutcome.APPLIED, synchronize(empty, now = NOW + 1))

        assertTrue(SqlDelightPortableBindingStore(database).pendingWorks(SERVER, PROFILE, 10).isEmpty())
        assertEquals(WORK_REF, SqlDelightPortableBindingStore(database).work(WORK_REF)?.ref)
    }

    private suspend fun synchronize(
        manifest: CorePortableManifest,
        hydrationReport: PortableHydrationReport? = null,
        now: Long = NOW,
    ): CoreReplicaSyncOutcome = synchronize(CoreHttpResult.Success(manifest), hydrationReport, now)

    private suspend fun synchronize(
        response: CoreHttpResult<CorePortableManifest>,
        hydrationReport: PortableHydrationReport? = null,
        now: Long = NOW,
    ): CoreReplicaSyncOutcome {
        val http = mockk<EpigraphCoreHttpClient>()
        coEvery { http.portableManifest(any(), PROFILE, PAGE_SIZE, 0, null, null) } returns response
        val sessionTransports = mockk<CoreSessionTransports>()
        every { sessionTransports.http } returns http
        val transports = mockk<CoreSessionTransportFactory>()
        every { transports.create(session, ORIGIN) } returns sessionTransports
        val hydration = hydrationReport?.let { report ->
            mockk<PortableHydrationCoordinator>().also {
                coEvery { it.hydrate(SERVER, PROFILE, now) } returns report
            }
        }
        return PortableManifestSync(
            transports = transports,
            endpoints = { CoreEndpoint(ORIGIN, discovered = false) },
            database = handler,
            hydration = hydration,
            pageSize = PAGE_SIZE,
        ).synchronize(session, capabilities(), now)
    }

    private fun manifest(storeUrl: String?): CorePortableManifest = CorePortableManifest(
        schemaVersion = 3,
        scopeId = "comics:profile:$PROFILE",
        runtimeFingerprint = "runtime-fixture",
        generatedAtMs = NOW,
        snapshotId = "snapshot-fixture",
        snapshotFingerprint = "sha256:${"a".repeat(64)}",
        snapshotExpiresAtMs = NOW + 120_000,
        page = CorePortableManifestPage(0, PAGE_SIZE, hasNextPage = false, totalCount = 1),
        comicDependencies = listOf(dependency(storeUrl)),
        works = listOf(
            CorePortableComicWork(
                portableId = PortableIdentityV3.workId(WORK_REF),
                reference = WORK_REF,
                dependencyPackageName = PACKAGE,
            ),
        ),
    )

    private fun dependency(storeUrl: String?) = ComicDependency(
        pkgName = PACKAGE,
        requiredSourceIds = setOf(WORK_REF.sourceId),
        observedVersionCode = "7",
        extensionStore = storeUrl?.let(::ExtensionStoreReference),
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
        supportsPortableSyncV3 = true,
        supportsSuwayomiWebsocketProxy = false,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 1,
        snapshotEntityTypes = emptySet(),
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )

    private companion object {
        const val SERVER = "desktop-one"
        const val PROFILE = "main"
        const val ORIGIN = "https://core.test/"
        const val PACKAGE = "eu.kanade.tachiyomi.extension.en.fixture"
        const val STORE_ONE = "https://store-one.example/index.min.json"
        const val STORE_TWO = "https://store-two.example/index.min.json"
        const val PAGE_SIZE = 100L
        const val NOW = 1_000L
        val WORK_REF = PortableWorkRef.Comic(
            DecimalSourceId("1001"),
            ProviderOwnedKey("/manga/fixture"),
        )
    }
}
