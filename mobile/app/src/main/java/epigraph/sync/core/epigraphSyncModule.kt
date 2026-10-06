package epigraph.sync.core

import android.app.Application
import android.content.Context
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.SyncScopeId
import epigraph.sync.EpigraphReaderProgressRouter
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphBookMutationRouter
import epigraph.sync.EpigraphCategoryMutationRouter
import epigraph.sync.EpigraphTrackingMutationRouter
import epigraph.sync.TrackingSyncGate
import epigraph.sync.ClientMutationIdFactory
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.credentials.EncryptedCoreCredentialStore
import epigraph.sync.core.credentials.CoreCredentialScopeProvider
import epigraph.sync.core.credentials.SharedPreferencesLastPairedProfileStore
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreLiveEventSupervisor
import epigraph.sync.core.extensions.ExtensionInventoryReplicaSync
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.extensions.CoreSourceRegistry
import epigraph.sync.core.extensions.CoreSourceRelinker
import epigraph.sync.core.extensions.InstalledCoreSourceRegistry
import epigraph.sync.core.extensions.InstalledExtensionRelinkObserver
import epigraph.sync.core.extensions.SqlDelightCoreSourceRelinkStore
import epigraph.sync.core.extensions.CoreSourceRelinkStore
import epigraph.sync.core.extensions.ExtensionReconciliationNotifier
import epigraph.sync.core.extensions.ExtensionReconciliationStore
import epigraph.sync.core.suwayomi.EpigraphCoreBridgeLabeler
import epigraph.sync.core.suwayomi.SuwayomiCategoryCreateHook
import epigraph.sync.core.suwayomi.SuwayomiExtensionPublishHook
import epigraph.sync.core.suwayomi.PhoneExtensionState
import epigraph.sync.core.suwayomi.SharedPreferencesPublishedExtensionLedger
import epigraph.sync.core.suwayomi.UnpublishedComicCategorySource
import epigraph.sync.core.suwayomi.UnpublishedComicCategory
import epigraph.sync.core.suwayomi.CreatedComicCategoryBinder
import epigraph.sync.core.outbox.EpigraphCoordinatorOutboxStore
import epigraph.sync.core.outbox.CoreLamportSource
import epigraph.sync.core.outbox.CoreOutboxRetryPlanner
import epigraph.sync.core.outbox.CoreOutboxStore
import epigraph.sync.core.outbox.CoreRequestIdSource
import epigraph.sync.core.outbox.CoreV1OutboxAdapter
import epigraph.sync.core.outbox.ExponentialCoreOutboxRetryPlanner
import epigraph.sync.core.outbox.UuidCoreRequestIdSource
import epigraph.sync.core.novels.LnReaderPluginReplicaSync
import epigraph.sync.core.novels.LocalNovelLibraryOutboxRepair
import epigraph.sync.core.novels.LnReaderPluginGateway
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyActionGateway
import epigraph.sync.core.novels.LnReaderDependencyInventoryStore
import epigraph.sync.core.novels.CoreNovelDependencyReader
import epigraph.sync.core.novels.CoreNovelPluginArtifactGateway
import epigraph.sync.core.novels.ManagedCoreNovelPluginArtifactGateway
import epigraph.sync.core.novels.ManagedLnReaderDependencyActionGateway
import epigraph.sync.core.novels.ManagedLnReaderPluginGateway
import epigraph.sync.core.novels.ReplicaCoreNovelDependencyReader
import epigraph.sync.core.novels.SqlDelightLnReaderDependencyInventoryStore
import epigraph.sync.core.persistence.SqlDelightCoreIdentityInventoryStore
import epigraph.sync.core.portable.PortableManifestSync
import epigraph.sync.core.portable.PortableNovelManifestSync
import epigraph.sync.core.portable.PortableHydrationCoordinator
import epigraph.sync.core.portable.PortableHydrationStore
import epigraph.sync.core.portable.SqlDelightPortableHydrationStore
import epigraph.sync.core.portable.ComicDependencyRegistry
import epigraph.sync.core.portable.EpigraphPortableLocalEntityLookup
import epigraph.sync.core.portable.EpigraphPortableChapterMaterializer
import epigraph.sync.core.portable.EpigraphPortableWorkMaterializer
import epigraph.sync.core.portable.LnReaderNovelDependencyRegistry
import epigraph.sync.core.portable.LnReaderPortableProvider
import epigraph.sync.core.portable.MihonComicDependencyRegistry
import epigraph.sync.core.portable.MihonPortableProvider
import epigraph.sync.core.portable.NovelDependencyRegistry
import epigraph.sync.core.portable.PortableLocalEntityLookup
import epigraph.sync.core.portable.PortableChapterMaterializer
import epigraph.sync.core.portable.PortableWorkMaterializer
import epigraph.sync.core.portable.PortableDependencyTrustCoordinator
import epigraph.contract.PortableContentProvider
import epigraph.sync.core.policy.DeviceSyncSelectionStore
import epigraph.sync.core.policy.SqlDelightDeviceSyncSelectionStore
import epigraph.sync.core.policy.SyncPolicyResolver
import epigraph.sync.core.pairing.EpigraphCorePairingActivation
import epigraph.sync.core.pairing.EpigraphCorePairingEngine
import epigraph.sync.core.pairing.EpigraphCorePairingController
import epigraph.sync.core.pairing.AndroidPairingDeviceProvider
import epigraph.sync.core.pairing.PairingTransport
import epigraph.sync.core.pairing.PairingPinTransport
import epigraph.sync.core.pairing.PairingPinResolver
import epigraph.sync.core.pairing.CorePairingEndedListener
import epigraph.sync.core.trackers.CoreTrackingCapabilityCache
import epigraph.sync.core.trackers.TrackManagerCredentialSource
import epigraph.sync.core.trackers.TrackerCredentialSyncer
import epigraph.sync.core.trackers.TrackerCredentialVault
import epigraph.sync.core.trackers.TrackerSyncSessionHook
import epigraph.sync.core.pairing.CoreHostDiscovery
import epigraph.sync.core.pairing.AndroidCoreHostDiscovery
import epigraph.sync.core.pairing.CoreHostProbe
import epigraph.sync.core.pairing.transport.OkHttpCoreHostProbe
import epigraph.sync.core.pairing.transport.OkHttpPairingTransport
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import epigraph.sync.core.replica.SqlDelightCoreLamportSource
import epigraph.sync.core.replica.CoreReplicaApplier
import epigraph.sync.core.replica.CoreReplicaCheckpointReader
import epigraph.sync.core.replica.CoreReplicaCheckpointResetter
import epigraph.sync.core.replica.CoreReplicaRecordReader
import epigraph.sync.core.replica.CoreReplicaStore
import epigraph.sync.core.replica.NovelChapterCoverageCheck
import epigraph.sync.core.replica.SqlDelightCoreReplicaStore
import epigraph.sync.core.replica.EpigraphCoreDomainProjection
import epigraph.sync.core.replica.CoreReplicaProjection
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.AndroidCoreEndpointResolver
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.suwayomi.CoreSuwayomiCatalogPageSource
import epigraph.sync.core.suwayomi.CoreSuwayomiProjectionStatusSource
import epigraph.sync.core.suwayomi.SuwayomiCatalogPageSource
import epigraph.sync.core.suwayomi.SuwayomiCatalogSync
import epigraph.sync.core.suwayomi.EpigraphCoreCoverClient
import epigraph.sync.core.suwayomi.CoreCatalogCoverCache
import epigraph.sync.core.suwayomi.CoreCatalogCoverSink
import epigraph.sync.core.suwayomi.CoreCatalogCoverStore
import epigraph.sync.core.suwayomi.CoreCoverByteSource
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import epigraph.sync.core.suwayomi.AuthenticatedEpigraphCoreSourceGateway
import epigraph.sync.core.suwayomi.SuwayomiMutationQueueDrainer
import epigraph.sync.core.work.CompositeCoreReplicaSync
import epigraph.sync.core.work.AndroidCoreDeviceIdentityProvider
import epigraph.sync.core.work.CoordinatorPendingOutbox
import epigraph.sync.core.work.CoreDeviceIdentityProvider
import epigraph.sync.core.work.CoreOutboxDrainerFactory
import epigraph.sync.core.work.CoreOutboxSyncConnectionFactory
import epigraph.sync.core.work.CoreOutboxSyncRunner
import epigraph.sync.core.work.CoreReplicaAppliedHook
import epigraph.sync.core.work.CorePendingOutbox
import epigraph.sync.core.work.CoreSyncWakeStore
import epigraph.sync.core.assets.BookAssetCoordinator
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.core.work.PinnedCoreOutboxSyncConnectionFactory
import epigraph.sync.core.work.SnapshotCoreReplicaSync
import epigraph.sync.core.work.SqlDelightCoreSyncWakeStore
import epigraph.sync.core.work.CoreSyncRunStore
import epigraph.sync.core.work.CoreSyncStatusMonitor
import epigraph.sync.core.work.WorkManagerCoreBackgroundSyncScheduler
import eu.kanade.tachiyomi.BuildConfig
import java.util.concurrent.TimeUnit
import java.util.UUID
import java.io.File
import okhttp3.OkHttpClient
import org.koin.core.qualifier.named
import org.koin.dsl.module
import yokai.data.DatabaseHandler

/** Product wiring for the security-sensitive Epigraph Core pairing boundary. */
fun epigraphSyncModule(app: Application) = module {
    single(named(PAIRING_HTTP_CLIENT)) {
        OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .pingInterval(20, TimeUnit.SECONDS)
            .build()
    }
    single { EpigraphCoreTlsClientFactory(get(named(PAIRING_HTTP_CLIENT))) }
    single { OkHttpPairingTransport(get<OkHttpClient>(named(PAIRING_HTTP_CLIENT))) }
    single<PairingTransport> { get<OkHttpPairingTransport>() }
    single<PairingPinTransport> { get<OkHttpPairingTransport>() }
    single { PairingPinResolver(get()) }
    single<CoreHostDiscovery> { AndroidCoreHostDiscovery(app) }
    single<CoreHostProbe> { OkHttpCoreHostProbe(get<OkHttpClient>(named(PAIRING_HTTP_CLIENT))) }
    single { EpigraphCorePairingEngine(get()) }

    single { EncryptedCoreCredentialStore.create(app) }
    single<CoreCredentialStore> { get<EncryptedCoreCredentialStore>() }
    single<DeviceSyncSelectionStore> { SqlDelightDeviceSyncSelectionStore(get()) }
    single { SyncPolicyResolver(get()) }
    single<EpigraphSyncScopeProvider> {
        CoreCredentialScopeProvider(get(), SharedPreferencesLastPairedProfileStore(app))
    }
    single { EpigraphCorePairingActivation(get(), get(), get(), get()) }
    single { AndroidPairingDeviceProvider(app) }
    single<CoreBackgroundSyncScheduler> { WorkManagerCoreBackgroundSyncScheduler(app) }
    single { CoreSyncRunStore(app) }
    single { CoreSyncStatusMonitor(app, get(), get(), get(), get()) }
    single { PortableDependencyTrustCoordinator(get(), get()) }
    single {
        EpigraphCorePairingController(
            activation = get(),
            credentials = get(),
            deviceProvider = get(),
            syncScheduler = get(),
            selections = get(),
            endpoints = get(),
            hostDiscovery = get(),
            pinResolver = get(),
            hostProbe = get(),
            pairingEndedListeners = listOf(
                get<CoreTrackingCapabilityCache>(),
                CorePairingEndedListener { get<TrackerCredentialSyncer>().wipe() },
            ),
        )
    }
    single { CoreSessionTransportFactory(get(), BuildConfig.VERSION_NAME) }
    single<CoreEndpointResolver> {
        AndroidCoreEndpointResolver(app, get(), BuildConfig.VERSION_NAME)
    }
    single {
        BookAssetCoordinator(
            database = get(),
            credentials = get(),
            endpoints = get(),
            transports = get(),
            coverStorageDirectory = File(app.filesDir, "books/covers"),
        )
    }
    single { EpigraphCoreCoverClient(get(), get(), get()) }
    single<CoreCoverByteSource> { get<EpigraphCoreCoverClient>() }
    single<CoreCatalogCoverStore> {
        val coverCache = get<eu.kanade.tachiyomi.data.cache.CoverCache>()
        val cursorPreferences = app.getSharedPreferences(CORE_COVER_QUEUE_PREFERENCES, Context.MODE_PRIVATE)
        object : CoreCatalogCoverStore {
            override fun target(reference: String) = coverCache.getCoverFile(reference, false)

            override fun loadCursor(): Int = cursorPreferences.getInt(CORE_COVER_QUEUE_CURSOR, 0)

            override fun saveCursor(cursor: Int) {
                cursorPreferences.edit().putInt(CORE_COVER_QUEUE_CURSOR, cursor).apply()
            }
        }
    }
    single<CoreCatalogCoverSink> { CoreCatalogCoverCache(get(), get()) }
    single { AuthenticatedEpigraphCoreSourceGateway(get(), get(), get()) }
    single { EpigraphCoreSource(get<AuthenticatedEpigraphCoreSourceGateway>()) }
    single { SqlDelightCoreIdentityInventoryStore(get()) }
    single { ExtensionReconciliationStore(get()) }
    single { EpigraphCoreBridgeLabeler(get(), get()) }
    single { ExtensionReconciliationNotifier(app) }
    single<CoreSourceRelinkStore> { SqlDelightCoreSourceRelinkStore(get()) }
    single<CoreSourceRegistry> { InstalledCoreSourceRegistry(get(), get()) }
    single { CoreSourceRelinker(get(), get()) }
    single { ExtensionReconciliationCoordinator(get(), get(), get(), get(), get(), get(), get()) }
    single {
        InstalledExtensionRelinkObserver(
            extensions = get(),
            sources = get(),
            reconciliation = get(),
            scheduler = get(),
        )
    }
    single<CoreReplicaSyncPort>(named(EXTENSION_INVENTORY_REPLICA)) {
        ExtensionInventoryReplicaSync(get(), get(), get(), get(), get())
    }
    single<CoreNovelDependencyReader> { ReplicaCoreNovelDependencyReader(get()) }
    single<LnReaderPluginGateway> { ManagedLnReaderPluginGateway(get(), get(), get()) }
    single<LnReaderDependencyInventoryStore> { SqlDelightLnReaderDependencyInventoryStore(get()) }
    single<LnReaderDependencyActionGateway> {
        ManagedLnReaderDependencyActionGateway(get(), get(), get())
    }
    single<CoreNovelPluginArtifactGateway> {
        ManagedCoreNovelPluginArtifactGateway(app, get(), get(), get(), get(), BuildConfig.VERSION_NAME)
    }
    single { LnReaderDependencyActionCoordinator(get(), get(), get(), get()) }
    single<CoreReplicaSyncPort>(named(NOVEL_PLUGIN_REPLICA)) {
        LnReaderPluginReplicaSync(get(), get(), get(), get())
    }
    single<SuwayomiCatalogPageSource> { CoreSuwayomiCatalogPageSource(get(), get()) }
    single { CoreSuwayomiProjectionStatusSource(get(), get()) }

    single {
        EpigraphMutationCoordinator(get()) {
            get<CoreBackgroundSyncScheduler>().enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING)
        }
    }
    single {
        EpigraphReaderProgressRouter(
            coordinator = get(),
            deviceId = DeviceId(get<CoreDeviceIdentityProvider>().currentDeviceId()),
            scopeId = SyncScopeId("novels:profile:legacy_unbound"),
            mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
            scopeProvider = get(),
        )
    }
    single {
        EpigraphLibraryMutationRouter(
            coordinator = get(),
            deviceId = DeviceId(get<CoreDeviceIdentityProvider>().currentDeviceId()),
            scopeId = SyncScopeId("novels:profile:legacy_unbound"),
            mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
            comicScopeId = SyncScopeId("comics:profile:legacy_unbound"),
            scopeProvider = get(),
        )
    }
    single { LocalNovelLibraryOutboxRepair(get(), get(), get(), get()) }
    single { SyncedChapterStateWriter(get(), get()) }
    single {
        EpigraphCategoryMutationRouter(
            coordinator = get(),
            deviceId = DeviceId(get<CoreDeviceIdentityProvider>().currentDeviceId()),
            mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
            scopeProvider = get(),
        )
    }
    single {
        EpigraphTrackingMutationRouter(
            coordinator = get(),
            deviceId = DeviceId(get<CoreDeviceIdentityProvider>().currentDeviceId()),
            mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
            scopeProvider = get(),
            gate = get(),
        )
    }
    single {
        EpigraphBookMutationRouter(
            coordinator = get(),
            deviceId = DeviceId(get<CoreDeviceIdentityProvider>().currentDeviceId()),
            mutationIds = ClientMutationIdFactory { ClientMutationId(UUID.randomUUID().toString()) },
        )
    }
    single<CoreOutboxStore> {
        EpigraphCoordinatorOutboxStore(
            coordinator = get(),
            projectHeldRecord = { key -> get<SqlDelightCoreReplicaStore>().projectHeldRecord(key) },
        )
    }
    single { CoreV1OutboxAdapter() }
    single<CoreLamportSource> { SqlDelightCoreLamportSource(get()) }
    single<CoreRequestIdSource> { UuidCoreRequestIdSource() }
    single<CoreOutboxRetryPlanner> { ExponentialCoreOutboxRetryPlanner() }
    single { CoreOutboxDrainerFactory(get(), get(), get(), get(), get()) }
    single<CoreOutboxSyncConnectionFactory> {
        PinnedCoreOutboxSyncConnectionFactory(get(), get(), get(), get(), get())
    }
    single<CoreDeviceIdentityProvider> { AndroidCoreDeviceIdentityProvider(get()) }
    single { SuwayomiMutationQueueDrainer(get()) }
    single<CorePendingOutbox> { CoordinatorPendingOutbox(get(), get()) }
    single<CoreSyncWakeStore> { SqlDelightCoreSyncWakeStore(get()) }
    single { EpigraphCoreDomainProjection(privateBookStorageDirectory = File(app.filesDir, "books")) }
    single<CoreReplicaProjection> { get<EpigraphCoreDomainProjection>() }
    single { SqlDelightCoreReplicaStore(get(), get<CoreReplicaProjection>()) }
    single<CoreReplicaStore> { get<SqlDelightCoreReplicaStore>() }
    single<CoreReplicaCheckpointReader> { get<SqlDelightCoreReplicaStore>() }
    single<CoreReplicaCheckpointResetter> { get<SqlDelightCoreReplicaStore>() }
    single<CoreReplicaRecordReader> { get<SqlDelightCoreReplicaStore>() }
    single { NovelChapterCoverageCheck(get()) }
    single { CoreReplicaApplier(get()) }
    single {
        CoreLiveEventSupervisor(
            context = app,
            credentialsStore = get(),
            endpointResolver = get(),
            transports = get(),
            policyResolver = get(),
            devices = get(),
            checkpoints = get(),
            applier = get(),
            scheduler = get(),
        )
    }
    single { SnapshotCoreReplicaSync(get(), get(), get(), get(), get()) }
    single<CoreReplicaSyncPort>(named(CATALOG_REPLICA)) {
        SuwayomiCatalogSync(get(), get(), get(), get(), projectionStatus = get<CoreSuwayomiProjectionStatusSource>())
    }
    single<CoreReplicaSyncPort>(named(PORTABLE_MANIFEST_REPLICA)) {
        PortableManifestSync(get(), get(), get(), get())
    }
    single<CoreReplicaSyncPort>(named(PORTABLE_NOVEL_MANIFEST_REPLICA)) {
        PortableNovelManifestSync(get(), get(), get(), get())
    }
    single<PortableLocalEntityLookup> { EpigraphPortableLocalEntityLookup(get(), get()) }
    single<PortableWorkMaterializer> { EpigraphPortableWorkMaterializer(get(), get(), get()) }
    single<PortableChapterMaterializer> { EpigraphPortableChapterMaterializer(get(), get(), get()) }
    single<ComicDependencyRegistry> { MihonComicDependencyRegistry(get(), get()) }
    single<NovelDependencyRegistry> { LnReaderNovelDependencyRegistry(get()) }
    single<PortableContentProvider>(named(PORTABLE_COMICS_PROVIDER)) {
        MihonPortableProvider(get(), get(), get(), get())
    }
    single<PortableContentProvider>(named(PORTABLE_NOVELS_PROVIDER)) {
        LnReaderPortableProvider(get(), get(), get(), get())
    }
    single<PortableHydrationStore> { SqlDelightPortableHydrationStore(get()) }
    single {
        PortableHydrationCoordinator(
            get(),
            get(named(PORTABLE_COMICS_PROVIDER)),
            get(named(PORTABLE_NOVELS_PROVIDER)),
        )
    }
    single<CoreReplicaSyncPort> {
        CompositeCoreReplicaSync(
            get<SnapshotCoreReplicaSync>(),
            get(named(CATALOG_REPLICA)),
            get(named(EXTENSION_INVENTORY_REPLICA)),
            get(named(NOVEL_PLUGIN_REPLICA)),
            get(),
            get(),
            get(named(PORTABLE_MANIFEST_REPLICA)),
            get(named(PORTABLE_NOVEL_MANIFEST_REPLICA)),
        )
    }
    single { CoreTrackingCapabilityCache.create(app) }
    single<TrackingSyncGate> { get<CoreTrackingCapabilityCache>() }
    single { TrackerCredentialVault.create(app) }
    single {
        TrackerCredentialSyncer(
            vault = get(),
            source = TrackManagerCredentialSource(get(), get()),
            deviceId = { get<CoreDeviceIdentityProvider>().currentDeviceId() },
        )
    }
    single {
        val database = get<DatabaseHandler>()
        val categoryRouter = get<EpigraphCategoryMutationRouter>()
        CoreOutboxSyncRunner(
            get(),
            get(),
            get(),
            get(),
            get(),
            get(),
            negotiatedHooks = listOf(
                TrackerSyncSessionHook(get<CoreTrackingCapabilityCache>(), get()),
                SuwayomiCategoryCreateHook(
                    categories = UnpublishedComicCategorySource {
                        database.awaitList { aethon_syncQueries.selectUnpublishedComicCategories() }
                            .map { UnpublishedComicCategory(localCategoryId = it._id, name = it.name) }
                    },
                    binder = CreatedComicCategoryBinder { localCategoryId, expectedName, categoryEntityId, suwayomiOrder ->
                        categoryRouter.bindCreatedComicCategory(localCategoryId, expectedName, categoryEntityId, suwayomiOrder)
                    },
                ),
                SuwayomiExtensionPublishHook(
                    phone = {
                        val extensions = get<eu.kanade.tachiyomi.extension.ExtensionManager>()
                        PhoneExtensionState(
                            packageNames = if (extensions.isInitialized.value) {
                                extensions.installedExtensionsFlow.value.map { it.pkgName }
                            } else {
                                emptyList()
                            },
                            repoIndexUrls = get<yokai.domain.extension.repo.interactor.GetExtensionRepo>().getAll()
                                .map { it.baseUrl.trimEnd('/') + "/index.min.json" },
                        )
                    },
                    ledger = SharedPreferencesPublishedExtensionLedger(app),
                ),
            ),
            replicaAppliedHooks = listOf(
                CoreReplicaAppliedHook { now -> get<EpigraphTrackingMutationRouter>().reconcileWithReplica(now) },
            ),
        )
    }
}

private const val CORE_COVER_QUEUE_PREFERENCES = "aethon_core_cover_queue_v1"
private const val CORE_COVER_QUEUE_CURSOR = "next_missing_cover"

private const val PAIRING_HTTP_CLIENT = "epigraphCorePairingHttp"
private const val CATALOG_REPLICA = "epigraphCatalogReplica"
private const val PORTABLE_MANIFEST_REPLICA = "epigraphPortableManifestReplica"
private const val PORTABLE_NOVEL_MANIFEST_REPLICA = "epigraphPortableNovelManifestReplica"
private const val PORTABLE_COMICS_PROVIDER = "epigraphPortableComicsProvider"
private const val PORTABLE_NOVELS_PROVIDER = "epigraphPortableNovelsProvider"
private const val EXTENSION_INVENTORY_REPLICA = "epigraphExtensionInventoryReplica"
private const val NOVEL_PLUGIN_REPLICA = "epigraphNovelPluginReplica"
