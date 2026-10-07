package epigraph.novel.plugin

import android.content.Context
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.data.preference.plusAssign
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.util.system.withIOContext
import epigraph.novel.js.JsPluginLoader
import epigraph.novel.js.NovelJsBridgeImpl
import epigraph.novel.plugin.model.NovelPlugin
import epigraph.novel.plugin.model.NovelPluginIndex
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.source.NovelSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import okhttp3.Request
import java.io.File
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import yokai.domain.base.models.Version

/**
 * Manages LNReader JavaScript novel plugins.
 * Handles: discovery from repos, downloading, installing, updating, creating NovelSource instances.
 */
class NovelPluginManager(
    private val context: Context,
    private val repoRepository: NovelRepoRepository,
    private val networkHelper: NetworkHelper,
    private val preferences: PreferencesHelper,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true }
    private val bridge = NovelJsBridgeImpl(context)
    private val pluginLoader = JsPluginLoader(context)
    private val cache = NovelPluginCache(context, json)

    private val pluginsDir: File
        get() = File(context.filesDir, "novel_plugins/plugins").also { it.mkdirs() }

    private val _installedSourcesFlow = MutableStateFlow<List<NovelSource>>(emptyList())
    val installedSourcesFlow = _installedSourcesFlow.asStateFlow()

    private val _availablePluginsFlow = MutableStateFlow<List<NovelPluginIndex>>(emptyList())
    val availablePluginsFlow = _availablePluginsFlow.asStateFlow()

    private val _installedPluginsFlow = MutableStateFlow<List<NovelPlugin.Installed>>(emptyList())
    val installedPluginsFlow = _installedPluginsFlow.asStateFlow()

    /**
     * Becomes true once [ensureInstalledPluginsLoaded] has completed for the first time.
     * Consumers that need to resolve a source by id on cold start (e.g. ReaderViewModel,
     * SourceManager.awaitSource) can suspend on `loadedFlow.first { it }` instead of racing
     * against the fire-and-forget init coroutine and falling back to a StubSource. See #9.
     */
    private val _loadedFlow = MutableStateFlow(false)
    val loadedFlow = _loadedFlow.asStateFlow()

    // ConcurrentHashMap so concurrent reads (isInstalled, getOrStub) are safe even between
    // mutex-guarded mutations — and so iteration during put/remove can't ConcurrentModificationException.
    private val installedSources = ConcurrentHashMap<String, NovelSource>()
    // Single mutex serializes the initial disk load and all install/uninstall mutations so
    // they can never race with each other on `installedSources` or the flow values.
    private val installMutex = Mutex()
    @Volatile
    private var installedPluginsLoaded = false

    // Read the user agent lazily from NetworkHelper (preference-backed, no WebView).
    // The previous eager `WebSettings.getDefaultUserAgent(context)` from this constructor
    // could deadlock on cold start (issue #14): if NovelPluginManager is first injected
    // from an IO scope (via SourceManager.init), the WebSettings call's internal WebView
    // initialization needs the Main looper — but the Main thread can in turn be blocked
    // waiting for this same constructor to finish. Plus computeUserAgent's try/catch only
    // catches thrown exceptions; a hang is silent. NetworkHelper.defaultUserAgent reads a
    // preference and never touches a WebView, so it's safe to call from any thread.
    private val cachedUserAgent: String
        get() = networkHelper.defaultUserAgent

    init {
        // Load installed plugins on startup. Opportunistically prefetch any missing icons
        // after the initial load completes (issue #10) so the next cold start renders
        // source rows entirely from disk.
        scope.launch {
            ensureInstalledPluginsLoaded()
            prefetchMissingIcons()
        }
        // Watch repos for changes
        scope.launch {
            repoRepository.subscribeAll().collectLatest {
                refreshAvailablePlugins()
            }
        }
    }

    /**
     * Load all locally installed plugins from disk.
     */
    private suspend fun loadInstalledPlugins() {
        val pluginDirs = pluginsDir.listFiles()?.filter { it.isDirectory } ?: return

        // Each metadata extraction creates its own QuickJS instance, so plugins can load in parallel.
        val loaded = coroutineScope {
            pluginDirs.map { dir ->
                async { loadSinglePlugin(dir) }
            }.awaitAll()
        }.filterNotNull()

        val sources = loaded.map { it.first }
        val installed = loaded.map { it.second }
        installedSources.clear()
        for (source in sources) {
            installedSources[source.pluginId] = source
        }

        _installedSourcesFlow.value = sources
        _installedPluginsFlow.value = installed
    }

    private suspend fun loadSinglePlugin(dir: File): Pair<NovelSource, NovelPlugin.Installed>? {
        val jsFile = File(dir, "index.js")
        if (!jsFile.exists()) return null

        return try {
            val savedMeta = readPluginIndex(dir)
            val cachedSource = cache.readInstalledSource(dir)

            // Only run QuickJS metadata extraction if the cache is missing required fields.
            // For installed plugins this is the cold-start hot path: each call evaluates ~5
            // minified JS bundles (cheerio, dayjs, ...) and easily takes 700ms+ per plugin.
            val needsExtraction = cachedSource == null ||
                cachedSource.id.isBlank() ||
                cachedSource.name.isBlank() ||
                cachedSource.siteUrl.isBlank()
            val metadata = if (needsExtraction) pluginLoader.extractMetadata(jsFile.readText()) else null

            val sourceId = cachedSource?.id ?: metadata?.id ?: return null
            val sourceName = cachedSource?.name ?: metadata?.name ?: return null
            val sourceSiteUrl = cachedSource?.siteUrl ?: metadata?.site ?: return null
            val sourceVersion = cachedSource?.version ?: metadata?.version ?: ""
            val sourceFilters = cachedSource?.filters ?: metadata?.filters

            val lang = savedMeta?.let { langFromLnReaderLang(it.lang) }
                ?: cachedSource?.lang?.takeIf { it.isNotBlank() }
                ?: getLangCode(sourceId)
            val iconUrl = savedMeta?.iconUrl ?: cachedSource?.iconUrl

            // Prefer the on-disk icon (issue #10): when present, UI binders skip the network
            // entirely. iconFile in the cache stores a relative filename so we don't have to
            // re-hash plugin directory paths if the app's filesDir changes between installs.
            val iconFileName = cachedSource?.iconFile ?: DEFAULT_ICON_FILE_NAME
            val iconFile = File(dir, iconFileName).takeIf { it.exists() }

            val source = NovelSource(
                pluginId = sourceId,
                pluginName = sourceName,
                lang = lang,
                siteUrl = sourceSiteUrl,
                // Provider closes over the file path, not the code, so we don't keep tens of
                // KB of JS source resident per installed plugin.
                pluginCodeProvider = { jsFile.readText() },
                pluginFilters = sourceFilters,
                iconUrl = iconUrl,
                iconFile = iconFile,
                context = context,
                bridge = bridge,
                userAgent = cachedUserAgent,
            )

            if (metadata != null) {
                cache.writeInstalledSource(dir, savedMeta, metadata, cachedSource?.iconFile)
            }

            Logger.d { "NovelPluginManager: Loaded plugin '$sourceName' ($sourceId)" }
            source to NovelPlugin.Installed(
                id = sourceId,
                name = sourceName,
                lang = lang,
                version = sourceVersion,
                siteUrl = sourceSiteUrl,
                iconUrl = iconUrl,
                source = source,
                iconFile = iconFile,
            )
        } catch (e: Exception) {
            Logger.e(e) { "NovelPluginManager: Failed to load plugin from ${dir.name}" }
            null
        }
    }

    suspend fun ensureInstalledPluginsLoaded() {
        if (installedPluginsLoaded) {
            // Make sure late subscribers (e.g. awaitSource invoked after the very first load
            // completed but before this branch was reached) still see the flag flip.
            if (!_loadedFlow.value) _loadedFlow.value = true
            return
        }

        installMutex.withLock {
            if (installedPluginsLoaded) {
                if (!_loadedFlow.value) _loadedFlow.value = true
                return
            }
            loadInstalledPlugins()
            // One-shot: surface installed plugin languages in Browse (mirrors
            // ExtensionManager's first-run sub-language enablement). Languages are
            // also enabled at install time; this covers plugins installed before the
            // language preference existed or restored from disk.
            val enabledLangs = preferences.enabledLanguages().get()
            val missingLangs = _installedPluginsFlow.value
                .mapNotNull { it.lang.takeIf { lang -> lang.isNotBlank() && lang !in enabledLangs } }
                .toSet()
            if (missingLangs.isNotEmpty()) {
                preferences.enabledLanguages() += missingLangs
            }
            installedPluginsLoaded = true
            _loadedFlow.value = true
        }
    }

    /**
     * Fetch available plugins from all configured repos.
     */
    suspend fun refreshAvailablePlugins() {
        val repos = repoRepository.getAll()
        if (repos.isEmpty()) {
            _availablePluginsFlow.value = emptyList()
            return
        }

        val cachedPlugins = repos.flatMap { cache.readRepoPlugins(it.baseUrl) }
        if (cachedPlugins.isNotEmpty()) {
            _availablePluginsFlow.value = dedupePlugins(cachedPlugins)
        }

        val allPlugins = mutableListOf<NovelPluginIndex>()

        for (repo in repos) {
            allPlugins += refreshRepositoryPlugins(repo.baseUrl)
        }

        val resolvedPlugins = dedupePlugins(allPlugins)
        _availablePluginsFlow.value = resolvedPlugins
    }

    /**
     * Reads one configured LNReader repository without mixing entries from other repositories.
     * Sync reconciliation uses this boundary so a plugin can only be resolved from the repository
     * that declared it on the paired profile.
     */
    suspend fun refreshRepositoryPlugins(repoUrl: String): List<NovelPluginIndex> {
        return try {
            // Network I/O must run off the main thread (NetworkOnMainThreadException otherwise).
            val body = withIOContext {
                val request = Request.Builder()
                    .url(repoUrl)
                    .addHeader("pragma", "no-cache")
                    .addHeader("cache-control", "no-cache")
                    .build()
                val response = networkHelper.client.newCall(request).execute()
                response.use {
                    if (!it.isSuccessful) return@use null
                    it.body.string()
                }
            }
            if (body.isNullOrBlank()) return cache.readRepoPlugins(repoUrl)

            val plugins = json.decodeFromString<List<NovelPluginIndex>>(body)
            cache.writeRepoPlugins(repoUrl, plugins)
            Logger.d { "NovelPluginManager: Fetched ${plugins.size} plugins from $repoUrl" }
            plugins
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (e: Exception) {
            Logger.e(e) { "NovelPluginManager: Failed to fetch plugins from $repoUrl" }
            cache.readRepoPlugins(repoUrl)
        }
    }

    /**
     * Install a plugin by downloading its JS code.
     */
    suspend fun installPlugin(plugin: NovelPluginIndex): Boolean =
        installPlugin(plugin, expectedSha256 = null, expectedByteLength = null)

    /**
     * Installs bytes fetched from the LNReader manifest only after optional Core evidence matches.
     */
    suspend fun installPlugin(
        plugin: NovelPluginIndex,
        expectedSha256: String?,
        expectedByteLength: Long?,
    ): Boolean {
        return try {
            // Network I/O must run off the main thread (NetworkOnMainThreadException otherwise).
            val bytes = withIOContext {
                val request = Request.Builder()
                    .url(plugin.url)
                    .addHeader("pragma", "no-cache")
                    .addHeader("cache-control", "no-cache")
                    .build()
                val response = networkHelper.client.newCall(request).execute()
                response.use {
                    if (!it.isSuccessful) return@use null
                    it.body.bytes()
                }
            } ?: return false
            installPluginArtifact(plugin, bytes, expectedSha256, expectedByteLength)
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (e: Exception) {
            Logger.e(e) { "NovelPluginManager: Failed to fetch plugin ${plugin.id}" }
            false
        }
    }

    /**
     * Installs already-materialized plugin bytes after immutable evidence validation.
     *
     * This is also the boundary used by Epigraph Core for an exact desktop plugin artifact that is
     * no longer present in its declared public repository. Callers must still require an explicit
     * user install action; this method never runs as part of background reconciliation.
     */
    suspend fun installPluginArtifact(
        plugin: NovelPluginIndex,
        bytes: ByteArray,
        expectedSha256: String?,
        expectedByteLength: Long?,
    ): Boolean {
        return try {
            if (!NovelPluginArtifactVerifier.matches(bytes, expectedSha256, expectedByteLength)) {
                Logger.w { "NovelPluginManager: Plugin artifact did not match declared evidence for ${plugin.id}" }
                return false
            }
            val code = bytes.toString(Charsets.UTF_8)

            // Validate plugin loads correctly
            val metadata = pluginLoader.extractMetadata(code) ?: return false

            val pluginDir: File
            installMutex.withLock {
                // Save to disk
                pluginDir = File(pluginsDir, metadata.id).also { it.mkdirs() }
                val jsFile = File(pluginDir, "index.js").also { it.writeText(code) }

                // Save metadata for lang resolution
                File(pluginDir, "meta.json").writeText(
                    json.encodeToString(NovelPluginIndex.serializer(), plugin),
                )
                cache.writeInstalledSource(pluginDir, plugin, metadata, iconFile = null)

                // Replace any prior in-memory source for this plugin id and dispose its runtime
                // before swapping it out, so the previous QuickJS context isn't leaked.
                installedSources.remove(metadata.id)?.destroy()

                val source = NovelSource(
                    pluginId = metadata.id,
                    pluginName = metadata.name,
                    lang = langFromLnReaderLang(plugin.lang),
                    siteUrl = metadata.site,
                    // Provider closes over the on-disk file, not the network response, so the
                    // plugin code is dropped from heap as soon as `code` falls out of scope.
                    pluginCodeProvider = { jsFile.readText() },
                    pluginFilters = metadata.filters,
                    iconUrl = plugin.iconUrl,
                    iconFile = null,
                    context = context,
                    bridge = bridge,
                    userAgent = cachedUserAgent,
                )

                installedSources[metadata.id] = source

                // Update flows
                _installedSourcesFlow.value = _installedSourcesFlow.value
                    .filter { it.pluginId != metadata.id } + source

                _installedPluginsFlow.value = _installedPluginsFlow.value
                    .filter { it.id != metadata.id } +
                    NovelPlugin.Installed(
                        id = metadata.id,
                        name = metadata.name,
                        lang = langFromLnReaderLang(plugin.lang),
                        version = metadata.version,
                        siteUrl = metadata.site,
                        iconUrl = plugin.iconUrl,
                        source = source,
                        iconFile = null,
                    )

                Logger.d { "NovelPluginManager: Installed plugin '${metadata.name}'" }
            }

            // Surface the plugin in Browse by enabling its language, mirroring
            // ExtensionManager.enableAdditionalSubLanguages for manga extensions. Without
            // this, sources whose language isn't in enabledLanguages are filtered out of
            // the Novel tab even though the plugin is installed.
            val lang = langFromLnReaderLang(plugin.lang)
            if (lang.isNotBlank() && lang !in preferences.enabledLanguages().get()) {
                preferences.enabledLanguages() += lang
            }

            // Fire-and-forget icon download. Failures are silent — the UI falls back to the
            // network-loaded iconUrl until the next install/prefetch attempt succeeds (#10).
            if (!plugin.iconUrl.isNullOrBlank()) {
                scope.launch { downloadPluginIcon(pluginDir, plugin.iconUrl) }
            }
            true
        } catch (cancelled: kotlinx.coroutines.CancellationException) {
            throw cancelled
        } catch (e: Exception) {
            Logger.e(e) { "NovelPluginManager: Failed to install plugin ${plugin.id}" }
            false
        }
    }

    /**
     * Uninstall a plugin. Suspends because [NovelSource.destroy] holds a mutex that may be
     * contended with an in-flight ensureRuntime() call from another coroutine.
     */
    suspend fun uninstallPlugin(pluginId: String) {
        installMutex.withLock {
            installedSources.remove(pluginId)?.destroy()

            // Delete from disk
            File(pluginsDir, pluginId).deleteRecursively()

            // Update flows
            _installedSourcesFlow.value = _installedSourcesFlow.value.filter { it.pluginId != pluginId }
            _installedPluginsFlow.value = _installedPluginsFlow.value.filter { it.id != pluginId }

            Logger.d { "NovelPluginManager: Uninstalled plugin '$pluginId'" }
        }
    }

    /**
     * Check if a plugin is installed.
     */
    fun isInstalled(pluginId: String): Boolean = installedSources.containsKey(pluginId)

    /** Language code each known plugin gets as a source here; installed plugins win. */
    fun knownPluginLangs(): Map<String, String> =
        availablePluginsFlow.value.associate { it.id to langFromLnReaderLang(it.lang) } +
            installedSourcesFlow.value.associate { it.pluginId to it.lang }

    /**
     * Get installed version of a plugin, or null.
     */
    fun getInstalledVersion(pluginId: String): String? {
        return _installedPluginsFlow.value.find { it.id == pluginId }?.version
    }

    fun installedArtifactMatches(
        pluginId: String,
        expectedVersion: String,
        expectedSha256: String,
        expectedByteLength: Long,
    ): Boolean {
        if (getInstalledVersion(pluginId) != expectedVersion) return false
        val artifact = File(pluginsDir, pluginId).resolve("index.js")
        val bytes = runCatching { artifact.readBytes() }.getOrNull() ?: return false
        return NovelPluginArtifactVerifier.matches(bytes, expectedSha256, expectedByteLength)
    }

    fun getPluginLastModified(pluginId: String): Long {
        val pluginDir = File(pluginsDir, pluginId)
        return if (pluginDir.exists()) pluginDir.lastModified() else 0L
    }

    /**
     * Get language code from LNReader's plugin directory name or metadata.
     */
    private fun getLangCode(pluginId: String): String {
        val pluginDir = File(pluginsDir, pluginId)
        val savedMeta = readPluginIndex(pluginDir)
        return savedMeta?.let { langFromLnReaderLang(it.lang) } ?: "en"
    }

    private fun readPluginIndex(pluginDir: File): NovelPluginIndex? {
        val metaFile = File(pluginDir, "meta.json")
        if (!metaFile.exists()) return null
        return runCatching {
            json.decodeFromString<NovelPluginIndex>(metaFile.readText())
        }.getOrNull()
    }

    /**
     * Walks installed plugins after the initial load and downloads any missing icons.
     * Runs once per process from [init] (fire-and-forget). Old installs predating the
     * icon-on-disk feature, or installs whose download failed transiently, will pick up
     * an icon here without forcing the user to reinstall.
     */
    private suspend fun prefetchMissingIcons() {
        val plugins = _installedPluginsFlow.value
        for (plugin in plugins) {
            if (plugin.iconFile != null && plugin.iconFile.exists()) continue
            val iconUrl = plugin.iconUrl
            if (iconUrl.isNullOrBlank()) continue
            val pluginDir = File(pluginsDir, plugin.id)
            if (!pluginDir.exists()) continue
            downloadPluginIcon(pluginDir, iconUrl)
        }
    }

    /**
     * Download an icon from [iconUrl] into `<pluginDir>/icon.png`. On success: write the
     * cache, refresh the in-memory NovelSource and NovelPlugin.Installed so the new file
     * is observed by collectors, and update both flows. On failure, leaves any existing
     * file untouched and the cache un-updated.
     */
    private suspend fun downloadPluginIcon(pluginDir: File, iconUrl: String) {
        try {
            val request = Request.Builder().url(iconUrl).build()
            val bytes = networkHelper.client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return
                response.body.bytes()
            }
            if (bytes.isEmpty()) return

            val target = File(pluginDir, DEFAULT_ICON_FILE_NAME)
            val tmp = File(pluginDir, "$DEFAULT_ICON_FILE_NAME.tmp")
            try {
                tmp.writeBytes(bytes)
                if (!tmp.renameTo(target)) {
                    target.delete()
                    if (!tmp.renameTo(target)) {
                        target.writeBytes(bytes)
                        tmp.delete()
                    }
                }
            } catch (e: Throwable) {
                tmp.delete()
                throw e
            }

            installMutex.withLock {
                cache.updateIconFile(pluginDir, DEFAULT_ICON_FILE_NAME)
                val pluginId = pluginDir.name
                val existingInstalled = _installedPluginsFlow.value.firstOrNull { it.id == pluginId }
                    ?: return@withLock
                // Surface the new icon file to UI binders without rebuilding the QuickJS
                // runtime. We update the cached `iconFile` reference on the Installed plugin
                // (which UI binders read via `plugin.iconFile`) and leave the NovelSource
                // instance — which owns the live runtime — completely untouched. NovelSource
                // is referenced by id from sourceMapFlow, so emitting a new Installed with
                // the same .source is safe and avoids tearing down any in-flight browse/search.
                _installedPluginsFlow.value = _installedPluginsFlow.value.map { installed ->
                    if (installed.id == pluginId) installed.copy(iconFile = target) else installed
                }
                // For SourceHolder which goes through `source as NovelSource` we DO need a
                // replacement NovelSource since `iconFile` is a constructor val. Re-derive
                // it from the cache via the same loadSinglePlugin path so we don't have to
                // duplicate filter parsing logic here. The cache write above means the
                // re-read will pick up the new iconFile.
                val reloaded = loadSinglePlugin(pluginDir)?.first
                if (reloaded != null) {
                    installedSources.remove(pluginId)?.destroy()
                    installedSources[pluginId] = reloaded
                    _installedSourcesFlow.value = _installedSourcesFlow.value
                        .map { if (it.pluginId == pluginId) reloaded else it }
                    _installedPluginsFlow.value = _installedPluginsFlow.value.map { installed ->
                        if (installed.id == pluginId) installed.copy(source = reloaded) else installed
                    }
                }
            }
        } catch (e: Exception) {
            Logger.w(e) { "NovelPluginManager: Failed to download icon for ${pluginDir.name}" }
        }
    }

    private fun dedupePlugins(plugins: List<NovelPluginIndex>): List<NovelPluginIndex> {
        return plugins
            .groupBy { it.id }
            .values
            .map { candidates ->
                candidates.reduce { preferred, candidate ->
                    when {
                        comparePluginVersions(candidate.version, preferred.version) > 0 -> candidate
                        comparePluginVersions(candidate.version, preferred.version) == 0 &&
                            preferred.url.isBlank() && candidate.url.isNotBlank() -> candidate
                        else -> preferred
                    }
                }
            }
            .sortedWith(compareBy({ langFromLnReaderLang(it.lang) }, { it.name }))
    }

    companion object {
        /**
         * Default filename for on-disk plugin icons. Stored under each plugin's directory.
         * Kept as a raw .png even if the source URL has a different extension — Coil
         * decodes by content, not file extension.
         */
        const val DEFAULT_ICON_FILE_NAME = "icon.png"

        /**
         * Convert LNReader plugin lang strings to ISO 639-1 codes.
         *
         * LNReader's plugins.min.json reports `lang` as the native endonym
         * (e.g. "Русский", "中文, 汉语, 漢語") rather than the English name, so
         * matching by English keyword would miss all but "English".
         */
        fun langFromLnReaderLang(lang: String): String {
            // Strip BiDi marks (LRM U+200E, RLM U+200F) that prefix some entries,
            // collapse whitespace, lowercase. Without this "‎العربية" wouldn't match.
            val normalized = lang
                .replace("‎", "")
                .replace("‏", "")
                .trim()
                .lowercase()
            return when (normalized) {
                "english" -> "en"
                "العربية", "arabic" -> "ar"
                "中文, 汉语, 漢語", "chinese" -> "zh"
                "français", "french" -> "fr"
                "deutsch", "german" -> "de"
                "bahasa indonesia", "indonesian" -> "id"
                "italiano", "italian" -> "it"
                "日本語", "japanese" -> "ja"
                "조선말, 한국어", "korean" -> "ko"
                "polski", "polish" -> "pl"
                "português", "portuguese" -> "pt"
                "русский", "russian" -> "ru"
                "español", "spanish" -> "es"
                "ไทย", "thai" -> "th"
                "türkçe", "turkish" -> "tr"
                "українська", "ukrainian" -> "uk"
                "tiếng việt", "vietnamese" -> "vi"
                "multi", "multilingual" -> "all"
                else -> "other"
            }
        }

        /** The code a plugin's source id uses: LNReader names the language ("Português"). */
        fun langCode(lang: String): String =
            lang.takeIf { it.length <= 3 && it.all(Char::isLowerCase) } ?: langFromLnReaderLang(lang)

        fun isVersionNewer(candidate: String, installed: String): Boolean {
            return comparePluginVersions(candidate, installed) > 0
        }

        private fun comparePluginVersions(left: String, right: String): Int {
            return runCatching {
                Version.parse(left).compareTo(Version.parse(right))
            }.getOrElse {
                left.compareTo(right)
            }
        }
    }
}

internal object NovelPluginArtifactVerifier {
    fun matches(bytes: ByteArray, expectedSha256: String?, expectedByteLength: Long?): Boolean {
        if (expectedByteLength != null && expectedByteLength >= 0 && bytes.size.toLong() != expectedByteLength) {
            return false
        }
        if (expectedSha256 == null) return true
        if (!SHA_256.matches(expectedSha256)) return false
        val actual = MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
        return actual == expectedSha256
    }

    private val SHA_256 = Regex("[0-9a-f]{64}")
}
