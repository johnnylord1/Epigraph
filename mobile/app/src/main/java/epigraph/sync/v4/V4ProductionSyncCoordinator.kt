package epigraph.sync.v4

import android.content.Context
import co.touchlab.kermit.Logger
import epigraph.novel.plugin.NovelPluginManager
import epigraph.sync.core.assets.BookAssetDrainReport
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.outbox.CoreOutboxDrainReport
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import epigraph.sync.core.policy.EffectiveSyncPolicy
import epigraph.sync.core.sourceprefs.AndroidNovelPluginSettingStore
import epigraph.sync.core.sourceprefs.AndroidSourcePreferenceStore
import epigraph.sync.core.work.CoreDeviceIdentityProvider
import epigraph.sync.core.work.CoreOutboxRetryReason
import epigraph.sync.core.work.CoreOutboxSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreSyncReleaseLog
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.extension.ExtensionManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import yokai.data.Database
import yokai.data.DatabaseHandler
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * Production Android coordinator for Epigraph Sync V4.
 *
 * Composes all 5 domain bridges (Comics, Novels, Books, Extension Repos/Inventory, and Extension
 * Preferences) on the Fast State Lane, runs schema-cached preference draining on IO, and hands
 * heavy EPUB/PDF & cover transfers to the async book-asset lane without blocking state sync.
 */
class V4ProductionSyncCoordinator(
    context: Context,
    private val database: Database,
    private val handler: DatabaseHandler,
    private val tlsFactory: EpigraphCoreTlsClientFactory,
    private val devices: CoreDeviceIdentityProvider,
    private val extensions: ExtensionManager,
    private val novelPlugins: NovelPluginManager,
    private val comicPreferenceStore: AndroidSourcePreferenceStore,
    private val novelPreferenceStore: AndroidNovelPluginSettingStore,
    private val clientVersion: String = BuildConfig.VERSION_NAME,
    private val localEditPendingStore: V4LocalEditPendingStore = SharedPreferencesV4LocalEditPendingStore(context.applicationContext),
    private val realtimeRefreshScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO),
) {
    private val realtimeRefreshLock = Any()
    private var realtimeRefreshJob: Job? = null
    private val appContext = context.applicationContext
    private val logger = Logger.withTag("EpigraphSyncV4")
    private val engines = ConcurrentHashMap<EngineKey, V4SyncEngine>()
    private val engineInitMutex = Mutex()
    private val queueOwnerPrefs = appContext.getSharedPreferences("epigraph_v4_queue_owner_v1", Context.MODE_PRIVATE)

    /** Signals that a local edit occurred (online or offline) and must be merged on next V4 pass. */
    fun markLocalEditPending() {
        localEditPendingStore.markPending()
    }

    /**
     * Debounces a digest-baseline refresh after realtime deltas: each delta restarts the 2 s timer,
     * and the refresh runs under the engine's lock with generation 0 (refresh only while no local edit).
     */
    private fun scheduleRealtimeBaselineRefresh(key: EngineKey) {
        synchronized(realtimeRefreshLock) {
            realtimeRefreshJob?.cancel()
            realtimeRefreshJob = realtimeRefreshScope.launch {
                delay(REALTIME_REFRESH_DEBOUNCE_MS)
                val engine = engines[key] ?: return@launch
                runCatching { engine.refreshBaseline(0L) }.onFailure { err ->
                    if (err is CancellationException) throw err
                    logger.w { "V4 realtime baseline refresh skipped: ${err.javaClass.simpleName}" }
                }
            }
        }
    }

    /** Clears persisted V4 sync state and domain progress when unpairing a server. */
    fun clearServerState(serverId: String) {
        val iterator = engines.entries.iterator()
        while (iterator.hasNext()) {
            val entry = iterator.next()
            if (entry.key.serverId == serverId) {
                entry.value.invalidate()
                iterator.remove()
            }
        }
        SqlDelightV4SyncStore(database).clearServerState(serverId, SharedPreferencesV4SyncDomainProgress(appContext))
    }

    /**
     * Hands V4 sync ownership to [serverId] when switching Cores:
     * invalidates and evicts any stale engines for other servers, moves pending `v4_outbox` rows
     * to [serverId] with their original HLCs, and clears other servers' sync state/entity map/progress.
     */
    suspend fun handOverIfNeeded(serverId: String, profileId: String) {
        if (serverId.isBlank() || profileId.isBlank()) return
        if (isQueueOwner(serverId, profileId)) return
        engineInitMutex.withLock {
            if (isQueueOwner(serverId, profileId)) return@withLock
            val stale = engines.entries.filter { it.key.serverId != serverId || it.key.profileId != profileId }
            for (entry in stale) {
                engines.remove(entry.key, entry.value)
                entry.value.invalidateAndAwaitIdle()
            }
            SqlDelightV4SyncStore(database).handOverToServer(
                newServerId = serverId,
                newProfileId = profileId,
                domainProgress = SharedPreferencesV4SyncDomainProgress(appContext),
            )
            queueOwnerPrefs.edit()
                .putString(QUEUE_OWNER_SERVER_KEY, serverId)
                .putString(QUEUE_OWNER_PROFILE_KEY, profileId)
                .commit()
        }
    }

    private fun isQueueOwner(serverId: String, profileId: String): Boolean =
        queueOwnerPrefs.getString(QUEUE_OWNER_SERVER_KEY, null) == serverId &&
            queueOwnerPrefs.getString(QUEUE_OWNER_PROFILE_KEY, null) == profileId

    private data class EngineKey(
        val serverId: String,
        val profileId: String,
        val origin: String,
        val fingerprint: String,
        val deviceId: String,
    )

    private val extensionPreferences = V4ExtensionPreferences(
        database = handler,
        comicPreferences = comicPreferenceStore,
        novelPreferences = novelPreferenceStore,
    )

    private val extensionInventory = V4ExtensionInventoryBridge(
        handler = handler,
        installedExtensionsProvider = {
            buildList {
                if (extensions.isInitialized.value) {
                    for (ext in extensions.installedExtensionsFlow.value.filterNot { it.isNovel }) {
                        add(
                            V4InstalledExtensionDescriptor(
                                kind = "comic",
                                packageId = ext.pkgName,
                                name = ext.name,
                                versionName = ext.versionName,
                                versionCode = ext.versionCode,
                                lang = ext.lang,
                                isNsfw = ext.isNsfw,
                                repoUrl = ext.repoUrl,
                            ),
                        )
                    }
                }
                novelPlugins.ensureInstalledPluginsLoaded()
                for (plugin in novelPlugins.installedPluginsFlow.value) {
                    add(
                        V4InstalledExtensionDescriptor(
                            kind = "novel",
                            packageId = plugin.id,
                            name = plugin.name,
                            versionName = plugin.version,
                            lang = plugin.lang,
                            repoUrl = plugin.siteUrl,
                        ),
                    )
                }
            }
        },
    )

    private val compositeBridge: V4DomainBridge = CompositeV4DomainBridge(
        V4ComicDomainBridge(handler),
        V4NovelDomainBridge(handler, novelPlugins::knownPluginLangs),
        V4BookDomainBridge(handler, File(appContext.filesDir, "books")),
        extensionInventory,
        extensionPreferences,
    )

    private suspend fun getOrCreateEngine(
        session: CoreCredentialSession,
        openedOrigin: String,
    ): V4SyncEngine {
        val deviceId = devices.currentDeviceId()
        val key = EngineKey(
            serverId = session.serverId,
            profileId = session.profileId,
            origin = openedOrigin,
            fingerprint = session.tlsCertSha256,
            deviceId = deviceId,
        )
        engines[key]?.let { return it }
        return engineInitMutex.withLock {
            engines[key]?.let { return@withLock it }
            val pinnedClient = tlsFactory.create(session.tlsCertSha256)
            val originUrl = openedOrigin.toHttpUrl()
            val clock = V4HlcClock(deviceId = deviceId)
            val http = V4CoreHttpClient(pinnedClient, originUrl, clientVersion, clock)
            val sse = V4SseClient(pinnedClient, originUrl, clientVersion, clock)
            val engine = V4SyncEngine(
                serverId = session.serverId,
                profileId = session.profileId,
                deviceId = deviceId,
                store = SqlDelightV4SyncStore(database),
                http = http,
                sse = sse,
                bridge = compositeBridge,
                domainProgress = SharedPreferencesV4SyncDomainProgress(appContext),
                localEditGeneration = localEditPendingStore::snapshotGeneration,
                onRealtimeDelta = { scheduleRealtimeBaselineRefresh(key) },
            )
            engines[key] = engine
            engine
        }
    }

    /**
     * Executes one full Sync V4 pass (Fast State Lane + IO extension preference drain + Pista 2
     * book assets) and maps the result cleanly to [CoreOutboxSyncOutcome].
     */
    suspend fun syncOnce(
        session: CoreCredentialSession,
        openedOrigin: String,
        policy: EffectiveSyncPolicy,
        nowEpochMillis: Long,
        drainBookAssets: suspend (Long) -> BookAssetDrainReport,
    ): CoreOutboxSyncOutcome {
        val startedNs = System.nanoTime()
        handOverIfNeeded(session.serverId, session.profileId)
        val engine = getOrCreateEngine(session, openedOrigin)
        engine.useDomainPolicy(V4SyncDomainPolicy.from(policy))
        val hasLegacyPending = hasPendingLegacyOutbox(session.profileId, policy)
        val pendingGeneration = localEditPendingStore.snapshotGeneration()
        val hadLocalEdits = pendingGeneration != 0L || hasLegacyPending
        val result = session.withAccessTokenString { token ->
            if (hadLocalEdits) {
                engine.syncWithLocalEdits(token)
            } else {
                engine.syncOnce(token)
            }
        }
        return when (result) {
            is V4SyncRunResult.Synced -> {
                if (pendingGeneration != 0L) {
                    localEditPendingStore.clearIfUnchanged(pendingGeneration)
                }
                if (hasLegacyPending) {
                    clearSupersededLegacyOutbox(session.profileId, policy)
                }
                if (extensions.isInitialized.value) {
                    runCatching {
                        extensionPreferences.drain(
                            session.serverId,
                            session.profileId,
                            syncComics = policy.syncComics,
                            syncNovels = policy.syncNovels,
                        )
                    }
                        .onFailure { err ->
                            if (err is CancellationException) throw err
                            logger.w { "V4 preference drain skipped: ${err.javaClass.simpleName}" }
                        }
                }
                val assets = if (policy.transferBookAssets) {
                    runCatching { drainBookAssets(nowEpochMillis) }
                        .onFailure { err ->
                            if (err is CancellationException) throw err
                            logger.w { "V4 book asset lane failed: ${err.javaClass.simpleName}" }
                        }
                        .getOrDefault(BookAssetDrainReport(0, 0, 0, 0))
                } else {
                    BookAssetDrainReport(0, 0, 0, 0)
                }
                val elapsedMs = (System.nanoTime() - startedNs) / 1_000_000
                val summary = CoreSyncReleaseLog.formatV4Synced(
                    elapsedMs = elapsedMs,
                    seq = result.serverSeq,
                    uploaded = result.uploadedCount,
                    applied = result.appliedCount,
                    pending = result.pendingOutboxCount,
                    noop = result.wasNoOpReconnect,
                    assetsSucceeded = assets.succeeded,
                    assetsAttempted = assets.attempted,
                )
                logger.i { summary }
                CoreSyncReleaseLog.info(summary)
                val report = CoreOutboxDrainReport(
                    claimed = result.uploadedCount,
                    submitted = result.uploadedCount,
                    acknowledged = result.uploadedCount,
                    retryScheduled = result.pendingOutboxCount.toInt(),
                    blocked = 0,
                )
                if (result.pendingOutboxCount == 0L) {
                    CoreOutboxSyncOutcome.OutboxDrained(report, CoreReplicaSyncOutcome.APPLIED)
                } else {
                    CoreOutboxSyncOutcome.OutboxDeferred(
                        report = report,
                        replica = CoreReplicaSyncOutcome.APPLIED,
                        pendingCount = result.pendingOutboxCount,
                    )
                }
            }
            is V4SyncRunResult.Failed -> {
                val elapsedMs = (System.nanoTime() - startedNs) / 1_000_000
                val pending = SqlDelightV4SyncStore(database).countPendingOutbox(session.serverId, session.profileId)
                val summary = CoreSyncReleaseLog.formatV4Failed(
                    elapsedMs = elapsedMs,
                    statusCode = result.statusCode,
                    retryable = result.retryable,
                    pending = pending,
                )
                logger.w { summary }
                CoreSyncReleaseLog.warn(summary)
                CoreOutboxSyncOutcome.Retry(pending, CoreOutboxRetryReason.CONNECTION)
            }
        }
    }

    private suspend fun hasPendingLegacyOutbox(profileId: String, policy: EffectiveSyncPolicy): Boolean = handler.await {
        val legacyOutboxPending = policy.selectedScopes.isNotEmpty() &&
            v4_syncQueries.countLegacySyncOutboxPending(policy.selectedScopes.toList()).executeAsOne() > 0L
        val suwayomiPending = policy.syncComics &&
            v4_syncQueries.countLegacySuwayomiQueuePending(profileId).executeAsOne() > 0L
        legacyOutboxPending || suwayomiPending
    }

    private suspend fun clearSupersededLegacyOutbox(profileId: String, policy: EffectiveSyncPolicy) {
        runCatching {
            handler.await(inTransaction = true) {
                if (policy.selectedScopes.isNotEmpty()) {
                    v4_syncQueries.clearLegacySyncOutbox(policy.selectedScopes.toList())
                }
                if (policy.syncComics) v4_syncQueries.clearLegacySuwayomiQueue(profileId)
            }
        }.onFailure { err ->
            if (err is CancellationException) throw err
        }
    }

    /**
     * Keeps the single `/v4/events` SSE stream open for realtime updates (< 100 ms LAN latency).
     */
    suspend fun runRealtimeStream(
        session: CoreCredentialSession,
        openedOrigin: String,
        policy: EffectiveSyncPolicy,
    ) {
        handOverIfNeeded(session.serverId, session.profileId)
        val engine = getOrCreateEngine(session, openedOrigin)
        engine.useDomainPolicy(V4SyncDomainPolicy.from(policy))
        session.withAccessTokenString { token ->
            engine.runRealtimeStream(token, V4SyncDomainPolicy.from(policy))
        }
    }

    companion object {
        private const val QUEUE_OWNER_SERVER_KEY = "server_id"
        private const val QUEUE_OWNER_PROFILE_KEY = "profile_id"
        private const val REALTIME_REFRESH_DEBOUNCE_MS = 2_000L

        /**
         * Enqueues a durable `book.work` tombstone into `v4_outbox` inside the caller's active
         * SQLDelight transaction for every paired V4 Core so deleted books never resurrect.
         */
        fun enqueueBookDeleteInTransaction(
            db: Database,
            bookSha256: String,
            deviceId: String,
            nowMs: Long = System.currentTimeMillis(),
        ) {
            if (bookSha256.isBlank()) return
            val store = SqlDelightV4SyncStore(db, wallClockMs = { nowMs })
            val states = db.v4_syncQueries.selectAllV4SyncStates().executeAsList()
            for (state in states) {
                val clock = V4HlcClock(
                    deviceId = deviceId,
                    wallClockMs = { nowMs },
                    initialLastTsMs = state.hlc_last_ts_ms,
                    initialLastCounter = state.hlc_last_counter,
                    initialClockOffsetMs = state.clock_offset_ms,
                )
                val hlc = clock.next()
                store.enqueueOutbox(
                    serverId = state.server_id,
                    profileId = state.profile_id,
                    domain = "books",
                    entityType = "book.work",
                    entityKey = bookSha256,
                    deleted = true,
                    hlc = hlc,
                    payload = JsonNull,
                )
                val (ts, counter, offset) = clock.snapshotState()
                store.saveState(
                    V4SyncCursorState(
                        serverId = state.server_id,
                        profileId = state.profile_id,
                        serverSeq = state.server_seq,
                        minReplayableSeq = state.min_replayable_seq,
                        lastSnapshotEtag = state.last_snapshot_etag,
                        hlcLastTsMs = ts,
                        hlcLastCounter = counter,
                        clockOffsetMs = offset,
                        initialSyncCompleted = state.initial_sync_completed != 0L,
                    ),
                )
            }
        }
    }
}
