package epigraph.sync.debug

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import epigraph.novel.plugin.NovelPluginManager
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.sourceprefs.AndroidNovelPluginSettingStore
import epigraph.sync.core.sourceprefs.AndroidSourcePreferenceStore
import epigraph.sync.v4.SqlDelightV4SyncStore
import epigraph.sync.v4.CompositeV4DomainBridge
import epigraph.sync.v4.V4BookDomainBridge
import epigraph.sync.v4.V4ComicDomainBridge
import epigraph.sync.v4.V4CoreHttpClient
import epigraph.sync.v4.V4ExtensionPreferences
import epigraph.sync.v4.V4NovelDomainBridge
import epigraph.sync.v4.V4SseClient
import epigraph.sync.v4.V4SyncEngine
import epigraph.sync.v4.V4SyncRunResult
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.extension.ExtensionManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withTimeout
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.koin.core.context.GlobalContext
import yokai.data.Database
import yokai.data.DatabaseHandler
import java.io.File

/** Test entry point for the actual APK using the normal paired credential and pinned transport. */
class V4SyncDebugReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION || !executing.tryLock()) return
        val result = goAsync()
        val app = context.applicationContext
        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                // Android bounds the lifetime of an asynchronous broadcast. Complete larger
                // transfers in the sync service once the V4 engine is selected in production.
                withTimeout(55_000) { sync(app) }
            } catch (error: Exception) {
                Log.w(TAG, "V4 sync failed (${error.javaClass.simpleName})")
            } finally {
                executing.unlock()
                result.finish()
            }
        }
    }

    private suspend fun sync(context: Context) {
        val started = android.os.SystemClock.elapsedRealtime()
        val koin = GlobalContext.get()
        val credential = checkNotNull(koin.get<CoreCredentialStore>().load()) { "No active pairing" }
        credential.use { session ->
            val origin = koin.get<CoreEndpointResolver>().resolve(session).origin.toHttpUrl()
            val client = koin.get<EpigraphCoreTlsClientFactory>().create(session.tlsCertSha256)
            val version = BuildConfig.VERSION_NAME
            val http = V4CoreHttpClient(client, origin, version)
            val handler = koin.get<DatabaseHandler>()
            val extensions = koin.get<ExtensionManager>()
            val plugins = koin.get<NovelPluginManager>()
            extensions.isInitialized.first { it }
            plugins.ensureInstalledPluginsLoaded()
            val preferences = V4ExtensionPreferences(
                handler,
                AndroidSourcePreferenceStore(context, extensions),
                AndroidNovelPluginSettingStore(plugins),
            )
            val bridge = CompositeV4DomainBridge(
                V4ComicDomainBridge(handler),
                V4NovelDomainBridge(handler, plugins::knownPluginLangs),
                V4BookDomainBridge(handler, File(context.filesDir, "books")),
                preferences,
            )
            session.withAccessTokenString { token ->
                val capabilities = (http.capabilities(token) as? CoreHttpResult.Success)?.value
                    ?: error("Core V4 capability negotiation failed")
                check(capabilities.profileId == session.profileId)
                val engine = V4SyncEngine(
                    session.serverId,
                    session.profileId,
                    capabilities.deviceId,
                    SqlDelightV4SyncStore(koin.get<Database>()),
                    http,
                    V4SseClient(client, origin, version),
                    bridge,
                )
                when (val sync = engine.syncOnce(token)) {
                    is V4SyncRunResult.Synced -> {
                        Log.i(TAG, "V4 complete elapsedMs=${android.os.SystemClock.elapsedRealtime() - started} " +
                            "uploaded=${sync.uploadedCount} applied=${sync.appliedCount} seq=${sync.serverSeq}")
                        preferences.drain(session.serverId, session.profileId, syncComics = true, syncNovels = true)
                    }
                    is V4SyncRunResult.Failed -> Log.w(TAG, "V4 sync rejected status=${sync.statusCode}")
                }
            }
        }
    }

    private companion object {
        const val ACTION = "epigraph.debug.SYNC_V4"
        const val TAG = "EpigraphV4Smoke"
        val executing = Mutex()
    }
}
