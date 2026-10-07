package epigraph.sync.core.extensions

import epigraph.sync.core.protocol.CoreExtensionInventory
import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.policy.SyncPolicyResolver
import epigraph.sync.core.portable.PortableDependencyTrustCoordinator
import epigraph.sync.core.session.CoreSessionTransportFactory
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.work.CoreReplicaSyncOutcome
import epigraph.sync.core.work.CoreReplicaSyncPort
import epigraph.sync.core.work.CoreDeviceIdentityProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.extension.model.InstallStep
import yokai.domain.extension.repo.interactor.CreateExtensionRepo
import yokai.domain.extension.repo.interactor.GetExtensionRepo
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext

data class ExtensionInstallationProgress(
    val activePackageName: String? = null,
    val completed: Int = 0,
    val total: Int = 0,
    val installed: Int = 0,
    val cancelled: Int = 0,
    val failed: Int = 0,
)

data class ExtensionReconciliationUiState(
    val report: ExtensionParityReport? = null,
    val installation: ExtensionInstallationProgress = ExtensionInstallationProgress(),
    val repositoryApproval: RepositoryApprovalState = RepositoryApprovalState(),
)

enum class RepositoryApprovalOutcome {
    ADDED,
    ALREADY_CONFIGURED,
    INVALID,
    DUPLICATE_FINGERPRINT,
    FAILED,
}

data class RepositoryApprovalState(
    val activeIndexUrl: String? = null,
    val outcome: RepositoryApprovalOutcome? = null,
)

class ExtensionReconciliationCoordinator(
    private val extensionManager: ExtensionManager,
    private val store: ExtensionReconciliationStore,
    private val notifier: ExtensionReconciliationNotifier,
    private val relinker: CoreSourceRelinker,
    private val createExtensionRepo: CreateExtensionRepo,
    private val getExtensionRepo: GetExtensionRepo,
    private val portableTrust: PortableDependencyTrustCoordinator? = null,
) {
    private val installationMutex = Mutex()
    private val repositoryMutex = Mutex()
    // Koin creates this coordinator while Application.onCreate is still on the UI thread. A
    // cached inventory can be large and SQLite may also be busy with bootstrap hydration, so a
    // synchronous read here can turn cold start into an ANR. Load persisted UI state explicitly
    // from a coroutine instead.
    private val _state = MutableStateFlow(ExtensionReconciliationUiState())
    val state = _state.asStateFlow()

    suspend fun reconcile(
        inventory: CoreExtensionInventory,
        compareRepositories: Boolean = true,
    ) {
        extensionManager.isInitialized.first { it }
        // Repository refresh is best-effort. The desktop inventory is still authoritative for
        // parity, and installed/unavailable states must remain visible while the mobile catalog
        // is offline instead of silently suppressing the whole reconciliation report.
        if (compareRepositories) extensionManager.findAvailableExtensions()
        val report = resolve(inventory, includeRepositoryCatalog = compareRepositories)
        relink(report)
        val shouldNotify = store.save(report)
        _state.value = _state.value.copy(report = report)
        if (shouldNotify && notifier.show(report)) {
            store.markNotified(report)
        }
    }

    /**
     * Pairing/bootstrap is deliberately review-only for extension dependencies.
     *
     * This method is kept as a compatibility shim for callers from an older integration, but it
     * must not approve repositories, trust packages, download APKs or open PackageInstaller. The
     * only installation entry points are the explicit actions exposed by
     * [ExtensionReconciliationActivity] (one item or "download all"). This prevents a future
     * pairing callback from silently installing every extension on the device.
     */
    @Deprecated(
        message = "Extension installation requires an explicit user action in the reconciliation screen",
        level = DeprecationLevel.WARNING,
    )
    suspend fun applyPendingAfterPairing() {
        refreshFromStore()
        relinkFromCachedInventories()
    }

    /** Adds every recommended repository (one-tap fallback from the reconciliation screen). */
    suspend fun approveAllRecommendedRepositories() {
        val report = _state.value.report ?: withContext(Dispatchers.IO) { store.latest() } ?: return
        recommendedMobileRepositoryIndexUrls(report).forEach { indexUrl ->
            approveRepository(indexUrl)
        }
    }

    suspend fun refreshFromStore() {
        val report = withContext(Dispatchers.IO) { store.latest() }
        _state.value = _state.value.copy(report = report)
    }

    /**
     * Returns a compatible mobile catalog only as an explicit user-review action. The desktop
     * inventory remains authoritative for package/source identity; this catalog is merely an
     * Android artifact resolver and is never added or trusted during background sync.
     */
    suspend fun recommendedMobileRepositoryIndexUrls(report: ExtensionParityReport): List<String> {
        val needsResolution = report.items.any {
            it.status == ExtensionParityStatus.MISSING_UNAVAILABLE ||
                it.status == ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED ||
                it.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
        }
        if (!needsResolution) return emptyList()

        val configuredBases = getExtensionRepo.getAll()
            .mapTo(mutableSetOf()) { ExtensionParityResolver.repositoryBaseUrl(it.baseUrl) }
        // Offer every repository the desktop actually uses (from the inventory hints), not just
        // a hardcoded default. Extensions can come from several repos (e.g. keiyoushi + riztard).
        val inventoryRepositories = report.items
            .asSequence()
            .mapNotNull { it.repositoryHintUrl ?: it.storeIndexUrl }
            .map(ExtensionParityResolver::repositoryIndexUrl)
            .distinct()
            .filter { ExtensionParityResolver.repositoryBaseUrl(it) !in configuredBases }
            .toList()
        return inventoryRepositories.ifEmpty {
            RECOMMENDED_MOBILE_REPOSITORY_INDEX_URL
                .takeUnless {
                    ExtensionParityResolver.repositoryBaseUrl(it) in configuredBases
                }
                ?.let(::listOf)
                .orEmpty()
        }
    }

    /** Every repository the desktop inventory uses, plus the recommended fallback, with this phone's state. */
    suspend fun desktopRepositories(report: ExtensionParityReport): List<ComicRepositoryRow> {
        val configured = getExtensionRepo.getAll()
        val configuredBases = configured
            .mapTo(mutableSetOf()) { ExtensionParityResolver.repositoryBaseUrl(it.baseUrl) }
        val candidates = (
            report.items.mapNotNull { it.repositoryHintUrl ?: it.storeIndexUrl } +
                recommendedMobileRepositoryIndexUrls(report)
        )
            .map(ExtensionParityResolver::repositoryIndexUrl)
            .distinct()
        return candidates
            .map { indexUrl ->
                ComicRepositoryRow(
                    indexUrl = indexUrl,
                    name = repositoryLabel(indexUrl),
                    // A mirror signed by the same key may serve other versions (and source ids),
                    // so only the same repository address counts as added.
                    added = ExtensionParityResolver.repositoryBaseUrl(indexUrl) in configuredBases,
                )
            }
            .sortedBy { it.added }
    }

    private fun repositoryLabel(indexUrl: String): String = try {
        val uri = java.net.URI(indexUrl)
        when (uri.host) {
            "raw.githubusercontent.com", "github.com" ->
                uri.path.orEmpty().split('/').firstOrNull(String::isNotBlank) ?: indexUrl
            else -> uri.host?.removePrefix("www.") ?: indexUrl
        }
    } catch (_: Exception) {
        indexUrl
    }

    suspend fun refreshRepositories(): Boolean {
        extensionManager.isInitialized.first { it }
        return extensionManager.findAvailableExtensions()
    }

    suspend fun approveRepository(indexUrl: String) = repositoryMutex.withLock {
        _state.value = _state.value.copy(
            repositoryApproval = RepositoryApprovalState(activeIndexUrl = indexUrl),
        )
        var outcome = RepositoryApprovalOutcome.FAILED
        try {
            outcome = addRepository(indexUrl)
        } finally {
            // Also when the screen that started it is closed mid-way: this coordinator outlives it,
            // and a leftover active repository keeps the setup screen locked as busy.
            _state.value = _state.value.copy(
                repositoryApproval = RepositoryApprovalState(outcome = outcome),
            )
        }
    }

    private suspend fun addRepository(indexUrl: String): RepositoryApprovalOutcome {
        val installableIndexUrl = ExtensionParityResolver.repositoryIndexUrl(indexUrl)
        val outcome = when (val result = createExtensionRepo.await(installableIndexUrl)) {
            CreateExtensionRepo.Result.Success -> RepositoryApprovalOutcome.ADDED
            CreateExtensionRepo.Result.RepoAlreadyExists ->
                RepositoryApprovalOutcome.ALREADY_CONFIGURED
            CreateExtensionRepo.Result.InvalidUrl -> RepositoryApprovalOutcome.INVALID
            // Several repositories may share a signer now, so this only comes from an old database.
            is CreateExtensionRepo.Result.DuplicateFingerprint ->
                RepositoryApprovalOutcome.ALREADY_CONFIGURED
            CreateExtensionRepo.Result.Error -> RepositoryApprovalOutcome.FAILED
        }
        if (
            outcome == RepositoryApprovalOutcome.ADDED ||
            outcome == RepositoryApprovalOutcome.ALREADY_CONFIGURED
        ) {
            val isModernStore = _state.value.report?.items?.any { it.storeIndexUrl == indexUrl } == true
            if (isModernStore) _state.value.report?.let { report ->
                portableTrust?.trustComicStore(
                    report.serverId,
                    report.profileId,
                    setOf(indexUrl),
                )
            }
            extensionManager.findAvailableExtensions()
            refreshReportFromCatalog()
            relinkFromCachedInventories()
        }
        return outcome
    }

    suspend fun relinkFromCachedInventories(): CoreSourceRelinkResult {
        val cached = withContext(Dispatchers.IO) { store.all() }
        return relinker.relinkAvailable(cached.map(::packageScope))
    }

    /** Desktop source of each bridged work, so works still served by the Core count toward their extension. */
    suspend fun bridgedWorkSources(): Map<Long, Long> = withContext(Dispatchers.IO) { relinker.bridgedWorkSources() }

    fun acknowledge() {
        _state.value.report?.let(store::acknowledge)
        notifier.dismiss()
    }

    /**
     * Trusts an already-installed extension that is currently untrusted/blocked on this device,
     * so it can be loaded and relinked. Used by the reconciliation flow to clear
     * [ExtensionParityStatus.UNTRUSTED_OR_BLOCKED] items coming from the desktop inventory.
     */
    suspend fun trustUntrusted(packageName: String) {
        val untrusted = extensionManager.untrustedExtensionsFlow.value
            .firstOrNull { it.pkgName == packageName }
            ?: return
        extensionManager.trust(untrusted.pkgName, untrusted.versionCode, untrusted.signatureHash)
        // Trusting loads the extension in the background; classifying before it lands showed the
        // package as missing and offered to install it again.
        withTimeoutOrNull(INSTALLED_FLOW_TIMEOUT_MS) {
            extensionManager.installedExtensionsFlow.first { installed ->
                installed.any { it.pkgName == packageName }
            }
        }
        refreshReportFromCatalog()
        relinkFromCachedInventories()
    }

    /** Trusts every installed package the desktop needs that this device still blocks. */
    suspend fun trustAllUntrusted() {
        _state.value.report?.items
            ?.filter { it.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED }
            ?.forEach { trustUntrusted(it.packageName) }
    }

    /**
     * Keeps the report in step with this device while a screen shows it. The persisted report is
     * from the last classification, so an extension installed, trusted or removed since then (or
     * an install whose result arrived late) kept offering the old action until the next sync.
     */
    @OptIn(FlowPreview::class)
    suspend fun followDeviceExtensions() {
        refreshFromStore()
        extensionManager.isInitialized.first { it }
        if (extensionManager.availableExtensionsFlow.value.isEmpty()) {
            extensionManager.findAvailableExtensions()
        }
        combine(
            extensionManager.installedExtensionsFlow,
            extensionManager.untrustedExtensionsFlow,
            extensionManager.availableExtensionsFlow,
        ) { installed, untrusted, available ->
            Triple(
                installed.mapTo(mutableSetOf()) { it.pkgName to it.versionCode },
                untrusted.mapTo(mutableSetOf()) { it.pkgName to it.versionCode },
                available.mapTo(mutableSetOf()) { it.pkgName to it.versionCode },
            )
        }
            .distinctUntilChanged()
            .debounce(DEVICE_STATE_DEBOUNCE_MS)
            .collect {
                // A failed pass keeps the last report; the next device change retries.
                try {
                    refreshReportFromCatalog()
                    relinkFromCachedInventories()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Exception) {
                }
            }
    }

    suspend fun installAllMissing() {
        val packages = _state.value.report?.items
            ?.filter {
                it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                    it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
            }
            ?.map { it.packageName }
            .orEmpty()
        installPackages(packages)
    }

    suspend fun installOne(packageName: String) {
        installPackages(listOf(packageName))
    }

    private suspend fun installPackages(packageNames: List<String>) = installationMutex.withLock {
        if (packageNames.isEmpty()) return@withLock
        extensionManager.isInitialized.first { it }
        if (!extensionManager.findAvailableExtensions()) {
            _state.value = _state.value.copy(
                installation = ExtensionInstallationProgress(
                    completed = packageNames.distinct().size,
                    total = packageNames.distinct().size,
                    failed = packageNames.distinct().size,
                ),
            )
            return@withLock
        }
        val uniquePackages = packageNames.distinct()
        var progress = ExtensionInstallationProgress(total = uniquePackages.size)
        _state.value = _state.value.copy(installation = progress)

        try {
            installEach(uniquePackages, progress) { progress = it }
        } finally {
            // Also when the screen that started it is closed mid-way: this coordinator outlives it,
            // and a leftover active package keeps the setup screen locked as busy.
            _state.value = _state.value.copy(installation = progress.copy(activePackageName = null))
        }
    }

    private suspend fun installEach(
        uniquePackages: List<String>,
        initial: ExtensionInstallationProgress,
        onProgress: (ExtensionInstallationProgress) -> Unit,
    ) {
        var progress = initial
        for (packageName in uniquePackages) {
            progress = progress.copy(activePackageName = packageName)
            onProgress(progress)
            _state.value = _state.value.copy(installation = progress)
            val outcome = installPackage(packageName)
            progress = when (outcome) {
                InstallOutcome.INSTALLED -> progress.copy(
                    completed = progress.completed + 1,
                    installed = progress.installed + 1,
                )
                InstallOutcome.CANCELLED -> progress.copy(
                    completed = progress.completed + 1,
                    cancelled = progress.cancelled + 1,
                )
                InstallOutcome.FAILED -> progress.copy(
                    completed = progress.completed + 1,
                    failed = progress.failed + 1,
                )
            }
            onProgress(progress)
            refreshReportFromCatalog()
            relinkFromCachedInventories()
            _state.value = _state.value.copy(installation = progress)
        }
    }

    private suspend fun installPackage(packageName: String): InstallOutcome {
        // The installer's status poller outlives the install it reports on: once the session is
        // released it waits for a new one forever. Run it in a scope closed here, since as a child
        // of this call it kept the batch (and the setup screen) busy after a finished install.
        val installerJob = SupervisorJob(currentCoroutineContext()[Job])
        return try {
            installPackage(packageName, CoroutineScope(currentCoroutineContext() + installerJob))
        } finally {
            installerJob.cancel()
        }
    }

    private suspend fun installPackage(
        packageName: String,
        installerScope: CoroutineScope,
    ): InstallOutcome = coroutineScope {
        val available = extensionManager.availableExtensionsFlow.value
            .filter { it.pkgName == packageName }
            .maxByOrNull { it.versionCode }
            ?: return@coroutineScope InstallOutcome.FAILED
        val installed = extensionManager.installedExtensionsFlow.value
            .firstOrNull { it.pkgName == packageName }
        if (installed != null && installed.versionCode >= available.versionCode) {
            return@coroutineScope InstallOutcome.INSTALLED
        }
        val targetVersion = available.versionCode

        // Drive the download + user-confirmation install, but confirm completion by observing
        // the device package state (installed or present-but-untrusted) instead of relying only
        // on the installer event flow, which can drop the terminal emission and stall the batch
        // until the timeout. Extensions that land untrusted count as installed here; the report
        // refresh re-classifies them so the user can trust them in-flow.
        var reachedInstaller = false
        val terminal = installerScope.async {
            extensionManager.installExtensionWithUserConfirmation(
                ExtensionManager.ExtensionInfo(available),
                installerScope,
            ).first {
                if (it.first == InstallStep.Installing) reachedInstaller = true
                it.first.isCompleted()
            }
        }
        // Cancelling Android's "install unknown apps" prompt (or backing out of the installer
        // dialog on some builds) leaves the session pending without any status callback. Once
        // the installer was shown and the user is back in Epigraph for a while with nothing
        // installed, treat it as a cancellation instead of blocking the batch until the timeout.
        val processLifecycle = ProcessLifecycleOwner.get().lifecycle
        var leftForInstaller = false
        var resumedSince = 0L
        val outcome: InstallOutcome? = withTimeoutOrNull(INSTALL_TIMEOUT_MS) {
            while (true) {
                val resumed = withContext(Dispatchers.Main) {
                    processLifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)
                }
                if (!resumed) {
                    if (reachedInstaller) leftForInstaller = true
                    resumedSince = 0L
                } else if (leftForInstaller) {
                    val now = System.currentTimeMillis()
                    if (resumedSince == 0L) resumedSince = now
                }
                val present = extensionManager.installedExtensionsFlow.value.any {
                    it.pkgName == packageName && it.versionCode >= targetVersion
                } || extensionManager.untrustedExtensionsFlow.value.any {
                    it.pkgName == packageName && it.versionCode >= targetVersion
                }
                if (present) return@withTimeoutOrNull InstallOutcome.INSTALLED
                if (terminal.isCompleted) {
                    return@withTimeoutOrNull when (
                        runCatching { terminal.await().first }.getOrNull()
                    ) {
                        InstallStep.Installed -> InstallOutcome.INSTALLED
                        InstallStep.Cancelled -> InstallOutcome.CANCELLED
                        else -> InstallOutcome.FAILED
                    }
                }
                if (resumedSince != 0L &&
                    System.currentTimeMillis() - resumedSince >= INSTALLER_ABANDONED_MS
                ) {
                    return@withTimeoutOrNull InstallOutcome.CANCELLED
                }
                delay(500)
            }
            @Suppress("UNREACHABLE_CODE")
            InstallOutcome.FAILED
        }

        when (outcome) {
            InstallOutcome.INSTALLED -> {
                // Android occasionally installs the APK but drops the terminal installer
                // callback. Feed the observed package state back through Epigraph's canonical
                // installer flow so its producer releases the download/session and the batch
                // can advance to the next user-confirmed APK.
                if (!terminal.isCompleted) {
                    extensionManager.setInstallationResult(packageName, result = true)
                    withTimeoutOrNull(INSTALLER_FLOW_SETTLE_MS) { terminal.await() }
                }
                // The installer can report success before the extension list has the package;
                // wait for it so the refreshed report stops offering to install it.
                withTimeoutOrNull(INSTALLED_FLOW_TIMEOUT_MS) {
                    combine(
                        extensionManager.installedExtensionsFlow,
                        extensionManager.untrustedExtensionsFlow,
                    ) { installed, untrusted ->
                        installed.any { it.pkgName == packageName && it.versionCode >= targetVersion } ||
                            untrusted.any { it.pkgName == packageName && it.versionCode >= targetVersion }
                    }.first { it }
                }
            }
            InstallOutcome.CANCELLED -> if (!terminal.isCompleted) {
                // Abandoned installer prompt: release the canonical flow the same way.
                extensionManager.setInstallationResult(packageName, result = false)
                withTimeoutOrNull(INSTALLER_FLOW_SETTLE_MS) { terminal.await() }
            }
            null -> {
                // Close the canonical flow after the user-confirmation deadline.
                extensionManager.setInstallationResult(packageName, result = false)
                withTimeoutOrNull(INSTALLER_FLOW_SETTLE_MS) { terminal.await() }
            }
            else -> Unit
        }
        terminal.cancel()
        outcome ?: InstallOutcome.FAILED
    }

    private suspend fun resolve(
        inventory: CoreExtensionInventory,
        includeRepositoryCatalog: Boolean,
    ): ExtensionParityReport {
        val configuredRepositories = getExtensionRepo.getAll()
            .mapTo(mutableSetOf()) { it.baseUrl }
        return ExtensionParityResolver.resolve(
            inventory = inventory,
            installed = extensionManager.installedExtensionsFlow.value.map { extension ->
                MobileInstalledExtension(
                    packageName = extension.pkgName,
                    versionCode = extension.versionCode,
                    versionName = extension.versionName,
                    sourceIds = extension.sources.mapTo(mutableSetOf()) { it.id },
                )
            },
            available = extensionManager.availableExtensionsFlow.value
                .takeIf { includeRepositoryCatalog }
                .orEmpty()
                .map { extension ->
                MobileAvailableExtension(
                    packageName = extension.pkgName,
                    versionCode = extension.versionCode,
                    versionName = extension.versionName,
                    sourceIds = extension.sources.mapTo(mutableSetOf()) { it.id },
                )
            },
            untrustedPackages = extensionManager.untrustedExtensionsFlow.value.mapTo(mutableSetOf()) {
                it.pkgName
            },
            configuredRepositoryBaseUrls = configuredRepositories,
        )
    }

    private suspend fun refreshReportFromCatalog() {
        val current = _state.value.report ?: return
        val installed = extensionManager.installedExtensionsFlow.value.associateBy { it.pkgName }
        val installedSourceIds = installed.values.flatMapTo(mutableSetOf()) { local -> local.sources.map { it.id } }
        val available = extensionManager.availableExtensionsFlow.value
            .groupBy { it.pkgName }
            .mapValues { (_, values) -> values.maxBy { it.versionCode } }
        val untrusted = extensionManager.untrustedExtensionsFlow.value.mapTo(mutableSetOf()) {
            it.pkgName
        }
        val configuredRepositories = getExtensionRepo.getAll()
            .mapTo(mutableSetOf()) { it.baseUrl }
        val refreshed = current.copy(
            items = current.items.map { item ->
                val local = installed[item.packageName]
                val expectedIds = item.sourceIds.toSet()
                val localIds = local?.sources?.mapTo(mutableSetOf()) { it.id }.orEmpty()
                val update = available[item.packageName]
                item.copy(
                    mobileVersionName = local?.versionName ?: update?.versionName,
                    status = when {
                        // Same rule as ExtensionParityResolver: a newer build with the source fixes it.
                        local != null && update != null && update.versionCode > local.versionCode &&
                            expectedIds.intersect(localIds).isEmpty() &&
                            update.sources.any { it.id in expectedIds } ->
                            ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                        local != null && expectedIds.isNotEmpty() &&
                            expectedIds.intersect(localIds).isEmpty() ->
                            ExtensionParityStatus.SOURCE_ID_MISMATCH
                        local != null && update != null && update.versionCode > local.versionCode ->
                            ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                        local != null -> ExtensionParityStatus.INSTALLED
                        expectedIds.isNotEmpty() && installedSourceIds.containsAll(expectedIds) ->
                            ExtensionParityStatus.INSTALLED
                        item.packageName in untrusted -> ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
                        update != null -> ExtensionParityStatus.MISSING_AVAILABLE
                        item.repositoryHintUrl != null &&
                            ExtensionParityResolver.repositoryBaseUrl(item.repositoryHintUrl) !in
                            configuredRepositories ->
                            ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED
                        else -> ExtensionParityStatus.MISSING_UNAVAILABLE
                    },
                )
            },
        )
        store.save(refreshed)
        _state.value = _state.value.copy(report = refreshed)
    }

    private suspend fun relink(report: ExtensionParityReport): CoreSourceRelinkResult {
        return relinker.relinkAvailable(listOf(packageScope(report)))
    }

    private fun packageScope(report: ExtensionParityReport): CoreSourcePackageScope {
        val packagesBySourceId = report.items
            .flatMap { item -> item.sourceIds.map { sourceId -> sourceId to item.packageName } }
            .groupBy({ it.first }, { it.second })
            .mapNotNull { (sourceId, packages) ->
                packages.distinct().singleOrNull()?.let { sourceId to it }
            }
            .toMap()
        return CoreSourcePackageScope(report.serverId, report.profileId, packagesBySourceId)
    }

    private enum class InstallOutcome { INSTALLED, CANCELLED, FAILED }

    private companion object {
        const val RECOMMENDED_MOBILE_REPOSITORY_INDEX_URL =
            "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json"
        val INSTALL_TIMEOUT_MS = TimeUnit.MINUTES.toMillis(10)
        val INSTALLER_FLOW_SETTLE_MS = TimeUnit.SECONDS.toMillis(5)
        val INSTALLER_ABANDONED_MS = TimeUnit.SECONDS.toMillis(6)
        val INSTALLED_FLOW_TIMEOUT_MS = TimeUnit.SECONDS.toMillis(15)
        const val DEVICE_STATE_DEBOUNCE_MS = 500L
    }
}

/** Best-effort sync stage: extension parity never blocks Core catalog reading. */
class ExtensionInventoryReplicaSync(
    private val transports: CoreSessionTransportFactory,
    private val endpoints: CoreEndpointResolver,
    private val coordinator: ExtensionReconciliationCoordinator,
    private val policyResolver: SyncPolicyResolver? = null,
    private val devices: CoreDeviceIdentityProvider? = null,
) : CoreReplicaSyncPort {
    override suspend fun synchronize(
        credentials: CoreCredentialSession,
        capabilities: CoreCapabilities,
        nowEpochMillis: Long,
    ): CoreReplicaSyncOutcome {
        if (!capabilities.supportsSuwayomiExtensionInventory) {
            return CoreReplicaSyncOutcome.DEFERRED
        }
        if ("comics:profile:${credentials.profileId}" !in credentials.scopes) {
            return CoreReplicaSyncOutcome.DEFERRED
        }
        val policy = policyResolver?.let { resolver ->
            devices?.let { provider ->
                resolver.resolve(credentials, capabilities, provider.currentDeviceId())
            }
        }
        val compareRepositories = policy?.reconcileComicRepositories ?: true
        val compareExtensions = policy?.reconcileComicExtensions ?: true
        if (!compareRepositories && !compareExtensions) return CoreReplicaSyncOutcome.DEFERRED
        if (!compareExtensions) {
            return if (coordinator.refreshRepositories()) {
                CoreReplicaSyncOutcome.APPLIED
            } else {
                CoreReplicaSyncOutcome.DEFERRED
            }
        }
        return try {
            val endpoint = endpoints.resolve(credentials).origin
            credentials.withAccessTokenString { accessToken ->
                when (
                    val response = transports.create(credentials, endpoint).http.suwayomiExtensions(
                        accessToken,
                        credentials.profileId,
                    )
                ) {
                    is CoreHttpResult.Success -> {
                        if (
                            response.value.profileId != credentials.profileId ||
                            response.value.serverId != credentials.serverId
                        ) {
                            CoreReplicaSyncOutcome.DEFERRED
                        } else {
                            coordinator.reconcile(response.value, compareRepositories)
                            CoreReplicaSyncOutcome.APPLIED
                        }
                    }
                    is CoreHttpResult.Failure -> CoreReplicaSyncOutcome.DEFERRED
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            CoreReplicaSyncOutcome.DEFERRED
        }
    }
}
