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
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.extension.ExtensionManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonNull
import okhttp3.HttpUrl.Companion.toHttpUrl
import yokai.data.Database
import yokai.data.DatabaseHandler
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

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
) {
    private val appContext = context.applicationContext
    private val logger = Logger.withTag("EpigraphSyncV4")
    private val engines = ConcurrentHashMap<EngineKey, V4SyncEngine>()
    private val engineInitMutex = Mutex()
    private val localEditsPending = AtomicBoolean(false)

    /** Signals that a local edit occurred (online or offline) and must be merged on next V4 pass. */
    fun markLocalEditPending() {
        localEditsPending.set(true)
    }

    /** Clears persisted V4 sync state and domain progress when unpairing a server. */
    fun clearServerState(serverId: String) {
        engines.keys.removeAll { it.serverId == serverId }
        SqlDelightV4SyncStore(database).clearServerState(serverId, SharedPreferencesV4SyncDomainProgress(appContext))
    }

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
        val engine = getOrCreateEngine(session, openedOrigin)
        engine.useDomainPolicy(V4SyncDomainPolicy.from(policy))
        val hasLegacyPending = hasPendingLegacyOutbox(session.profileId, policy)
        val hadLocalEdits = localEditsPending.getAndSet(false) || hasLegacyPending
        val result = session.withAccessTokenString { token ->
            if (hadLocalEdits) {
                engine.syncWithLocalEdits(token)
            } else {
                engine.syncOnce(token)
            }
        }
        return when (result) {
            is V4SyncRunResult.Synced -> {
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
                logger.i {
                    "V4 sync complete in ${elapsedMs}ms: seq=${result.serverSeq} " +
                        "uploaded=${result.uploadedCount} applied=${result.appliedCount} " +
                        "pending=${result.pendingOutboxCount} noop=${result.wasNoOpReconnect} " +
                        "assets=${assets.succeeded}/${assets.attempted}"
                }
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
                if (hadLocalEdits) localEditsPending.set(true)
                logger.w { "V4 sync failed status=${result.statusCode} reason=${result.reason}" }
                val pending = SqlDelightV4SyncStore(database).countPendingOutbox(session.serverId, session.profileId)
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
        val engine = getOrCreateEngine(session, openedOrigin)
        engine.useDomainPolicy(V4SyncDomainPolicy.from(policy))
        session.withAccessTokenString { token ->
            engine.runRealtimeStream(token, V4SyncDomainPolicy.from(policy))
        }
    }

    companion object {
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
