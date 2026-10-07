package epigraph.sync.core.setup

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.graphics.drawable.toBitmap
import coil3.compose.AsyncImage
import dev.icerock.moko.resources.compose.pluralStringResource
import dev.icerock.moko.resources.compose.stringResource
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.source.NovelSource
import epigraph.sync.core.extensions.ComicRepositoryRow
import epigraph.sync.core.extensions.ExtensionParityItem
import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionParityResolver
import epigraph.sync.core.extensions.ExtensionParityStatus
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.extensions.RepositoryApprovalOutcome
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.novels.LnReaderPluginInventoryItem
import epigraph.sync.core.novels.LnReaderPluginParityStatus
import epigraph.sync.core.novels.LnReaderPluginInstallResult
import epigraph.sync.core.novels.LnReaderRepositoryApprovalResult
import epigraph.sync.core.novels.LnReaderRepositoryParityStatus
import epigraph.sync.core.pairing.CorePairingUiState
import epigraph.sync.core.pairing.EpigraphCorePairingController
import epigraph.sync.core.pairing.PairingSyncSelection
import epigraph.sync.core.policy.SyncDomain
import epigraph.sync.core.work.CoreSyncStatus
import epigraph.sync.core.work.CoreSyncStatusMonitor
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.util.system.setThemeByPref
import co.touchlab.kermit.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import yokai.domain.manga.interactor.GetManga
import yokai.i18n.MR
import yokai.presentation.theme.YokaiTheme
import yokai.util.koin.injectLazy

class CoreDependencySetupActivity : AppCompatActivity() {
    private val preferences: PreferencesHelper by injectLazy()
    private val coordinator: ExtensionReconciliationCoordinator by injectLazy()
    private val novelCoordinator: LnReaderDependencyActionCoordinator by injectLazy()
    private val pairingController: EpigraphCorePairingController by injectLazy()
    private val syncMonitor: CoreSyncStatusMonitor by injectLazy()
    private val getManga: GetManga by injectLazy()
    private val novelPluginManager: NovelPluginManager by injectLazy()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setThemeByPref(preferences)
        // Follows installs, trusts and removals made while the screen is open or away from it.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) { coordinator.followDeviceExtensions() }
        }
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID)?.takeIf(String::isNotBlank)
        val profileId = intent.getStringExtra(EXTRA_PROFILE_ID)?.takeIf(String::isNotBlank)
        val startAtExtensions = intent.getBooleanExtra(EXTRA_START_AT_EXTENSIONS, false)
        val startWithPairing = intent.getBooleanExtra(EXTRA_START_WITH_PAIRING, false)
        setContent {
            YokaiTheme {
                CoreDependencySetupContent(
                    coordinator = coordinator,
                    novelCoordinator = novelCoordinator,
                    pairingController = pairingController,
                    syncMonitor = syncMonitor,
                    getManga = getManga,
                    novelPluginManager = novelPluginManager,
                    serverId = serverId,
                    profileId = profileId,
                    startWithPairing = startWithPairing,
                    startAtExtensions = startAtExtensions,
                    onClose = {
                        coordinator.acknowledge()
                        finish()
                    },
                )
            }
        }
    }

    companion object {
        private const val EXTRA_SERVER_ID = "epigraph.dependency_setup.server_id"
        private const val EXTRA_PROFILE_ID = "epigraph.dependency_setup.profile_id"
        private const val EXTRA_START_AT_EXTENSIONS = "epigraph.dependency_setup.start_at_extensions"
        private const val EXTRA_START_WITH_PAIRING = "epigraph.dependency_setup.start_with_pairing"

        fun intent(
            context: Context,
            serverId: String? = null,
            profileId: String? = null,
            startAtExtensions: Boolean = false,
            /**
             * Finishes a pairing waiting on "what to sync", follows the first sync, then shows
             * repositories and extensions.
             */
            startWithPairing: Boolean = false,
        ): Intent = Intent(context, CoreDependencySetupActivity::class.java)
            .apply {
                serverId?.let { putExtra(EXTRA_SERVER_ID, it) }
                profileId?.let { putExtra(EXTRA_PROFILE_ID, it) }
                putExtra(EXTRA_START_AT_EXTENSIONS, startAtExtensions)
                putExtra(EXTRA_START_WITH_PAIRING, startWithPairing)
            }
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CoreDependencySetupContent(
    coordinator: ExtensionReconciliationCoordinator,
    novelCoordinator: LnReaderDependencyActionCoordinator,
    pairingController: EpigraphCorePairingController,
    syncMonitor: CoreSyncStatusMonitor,
    getManga: GetManga,
    novelPluginManager: NovelPluginManager,
    serverId: String?,
    profileId: String?,
    startWithPairing: Boolean,
    startAtExtensions: Boolean,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uiState by coordinator.state.collectAsState()
    val report = uiState.report

    val firstStep = remember {
        when {
            startWithPairing -> STEP_SELECTION
            startAtExtensions -> STEP_EXTENSIONS
            else -> STEP_REPOSITORIES
        }
    }
    var step by remember { mutableStateOf(firstStep) }
    var tab by remember { mutableStateOf(0) }
    var comicRows by remember { mutableStateOf<List<ComicRepositoryRow>>(emptyList()) }
    var novelInventory by remember { mutableStateOf<LnReaderDependencyInventory?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }

    // Right after pairing the selection is persisted only once the pairing completes.
    val persistedSelection by pairingController.selection.collectAsState()
    val effectiveServerId = serverId ?: report?.serverId ?: persistedSelection?.serverId
    val effectiveProfileId = profileId ?: report?.profileId ?: persistedSelection?.profileId

    LaunchedEffect(report) {
        if (report != null) {
            comicRows = coordinator.desktopRepositories(report)
        }
    }

    // The novel inventory arrives with a sync, which may finish after the screen opened.
    val syncStatus by remember(syncMonitor) { syncMonitor.status() }.collectAsState(initial = null)
    val lastSyncAtMs = (syncStatus as? CoreSyncStatus.Synced)?.lastSyncAtMs
    LaunchedEffect(effectiveServerId, effectiveProfileId, lastSyncAtMs) {
        if (effectiveServerId != null && effectiveProfileId != null) {
            novelInventory = novelCoordinator.inventory(effectiveServerId, effectiveProfileId)
        }
    }

    var syncRequestedAtMs by remember { mutableStateOf(System.currentTimeMillis()) }
    // The repositories page waits on the first sync after pairing, which brings the desktop's list.
    var awaitingSync by remember { mutableStateOf(false) }
    val pairingState by pairingController.state.collectAsState()
    val selecting = pairingState as? CorePairingUiState.Selecting
    var selectionDraft by remember { mutableStateOf(SyncSelectionDraft()) }
    LaunchedEffect(pairingState) {
        when {
            // Expired or cancelled: there is nothing left to confirm.
            step == STEP_SELECTION && pairingState !is CorePairingUiState.Selecting -> onClose()
            // A failed pairing has nothing to sync; the Core screen shows why.
            awaitingSync && pairingState is CorePairingUiState.PairingFailed -> onClose()
        }
    }
    // Leaving before confirming "what to sync" cancels the pairing.
    val close: () -> Unit = {
        if (step == STEP_SELECTION) pairingController.cancelPairingSelection()
        onClose()
    }
    val onConfirmSelection: () -> Unit = {
        syncRequestedAtMs = System.currentTimeMillis()
        awaitingSync = true
        step = STEP_REPOSITORIES
        pairingController.confirmPairing(selectionDraft.toPairingSelection())
    }

    // Library works per source, to show how many works each repository and extension serves.
    var worksRefresh by remember { mutableStateOf(0) }
    var worksBySource by remember { mutableStateOf<Map<Long, Int>>(emptyMap()) }
    LaunchedEffect(worksRefresh, lastSyncAtMs) {
        worksBySource = try {
            // Works still served by the Core count toward the desktop source they come from.
            val bridged = coordinator.bridgedWorkSources()
            withContext(Dispatchers.IO) {
                getManga.awaitFavorites()
                    .groupingBy { manga -> manga.id?.let(bridged::get) ?: manga.source }
                    .eachCount()
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: Exception) {
            Logger.e(failure) { "Could not count library works per source" }
            emptyMap()
        }
    }
    val comicRepositoryWorks = remember(report, worksBySource) {
        report?.items.orEmpty()
            .groupBy { it.repositoryIndexUrl() }
            .mapNotNull { (indexUrl, items) ->
                indexUrl?.let { it to items.sumOf { item -> item.works(worksBySource) } }
            }
            .toMap()
    }
    val comicExtensionWorks: (ExtensionParityItem) -> Int = { it.works(worksBySource) }
    val installedNovelPlugins by novelPluginManager.installedPluginsFlow.collectAsState()
    val availableNovelPlugins by novelPluginManager.availablePluginsFlow.collectAsState()
    val novelPluginWorks: (LnReaderPluginInventoryItem) -> Int = { item ->
        val requirement = item.requirement
        val installed = installedNovelPlugins.firstOrNull {
            it.id == requirement.pluginId || it.id == requirement.sourceId
        }
        val available = availableNovelPlugins.firstOrNull { it.id == requirement.pluginId }
        val langSourceIds = listOfNotNull(requirement.lang, installed?.lang, available?.lang)
            .filter(String::isNotBlank)
            .map { NovelSource.sourceIdFor(requirement.pluginId, NovelPluginManager.langCode(it)) }
        (listOfNotNull(installed?.source?.id) + langSourceIds)
            .distinct()
            .sumOf { worksBySource[it] ?: 0 }
    }
    val novelPluginIcon: (LnReaderPluginInventoryItem) -> Any? = { item ->
        val requirement = item.requirement
        val installed = installedNovelPlugins.firstOrNull {
            it.id == requirement.pluginId || it.id == requirement.sourceId
        }
        installed?.iconFile?.takeIf { it.exists() }
            ?: installed?.iconUrl
            ?: availableNovelPlugins.firstOrNull { it.id == requirement.pluginId }?.iconUrl
    }
    val novelRepositoryWorks: (String) -> Int = { repositoryId ->
        novelInventory?.plugins.orEmpty()
            .filter { it.requirement.repositoryId == repositoryId }
            .sumOf { novelPluginWorks(it) }
    }

    // Every action runs here so a failure is shown instead of crashing, and the screen never stays
    // locked as busy after an action ends.
    val launchAction: (suspend () -> Unit) -> Unit = { action ->
        busy = true
        scope.launch {
            try {
                action()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                Logger.e(failure) { "Dependency setup action failed" }
                error = true
            } finally {
                busy = false
            }
        }
    }

    // The sync may have brought new works and a new desktop inventory.
    val onSyncFinished: () -> Unit = {
        if (awaitingSync) {
            awaitingSync = false
            launchAction {
                coordinator.refreshFromStore()
                if (effectiveServerId != null && effectiveProfileId != null) {
                    novelInventory = novelCoordinator.inventory(effectiveServerId, effectiveProfileId)
                }
                worksRefresh += 1
            }
        }
    }

    val installNovelPlugins: suspend () -> Unit = {
        novelInventory?.plugins.orEmpty()
            .filter { it.status in NOVEL_INSTALLABLE_STATUSES }
            .forEach { item ->
                val result = novelCoordinator.installPlugin(
                    effectiveServerId!!,
                    effectiveProfileId!!,
                    item.requirement.pluginId,
                )
                if (
                    result != LnReaderPluginInstallResult.Installed &&
                    result != LnReaderPluginInstallResult.AlreadyInstalled
                ) {
                    error = true
                }
            }
    }

    val isBusy = busy ||
        uiState.installation.activePackageNames.isNotEmpty() ||
        uiState.repositoryApproval.activeIndexUrl != null

    BackHandler {
        when {
            isBusy -> onClose()
            step == STEP_EXTENSIONS -> step = STEP_REPOSITORIES
            else -> close()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(
                            when (step) {
                                STEP_SELECTION -> MR.strings.epigraph_core_sync_selection_title
                                STEP_REPOSITORIES -> MR.strings.epigraph_core_setup_repositories
                                else -> MR.strings.epigraph_core_setup_extensions
                            },
                        ),
                    )
                },
                actions = {
                    IconButton(onClick = close) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(MR.strings.action_close))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            LinearProgressIndicator(
                progress = { (step - firstStep + 1f) / (STEP_EXTENSIONS - firstStep + 1) },
                modifier = Modifier.fillMaxWidth(),
            )

            val showTabs = step >= STEP_REPOSITORIES && !awaitingSync && report != null && novelInventory != null
            if (showTabs) {
                TabRow(selectedTabIndex = tab) {
                    Tab(
                        selected = tab == 0,
                        onClick = { tab = 0 },
                        text = { Text(stringResource(MR.strings.epigraph_core_sync_comics)) },
                    )
                    Tab(
                        selected = tab == 1,
                        onClick = { tab = 1 },
                        text = { Text(stringResource(MR.strings.epigraph_core_sync_novels)) },
                    )
                }
            }

            if (error) {
                Text(
                    stringResource(MR.strings.epigraph_core_setup_failed),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
                )
            }

            if (step == STEP_SELECTION) {
                SyncSelectionPage(
                    selecting = selecting,
                    draft = selectionDraft,
                    onChange = { selectionDraft = it },
                    modifier = Modifier.weight(1f),
                )
                SelectionBottomBar(
                    enabled = selecting != null && selectionDraft.domains.isNotEmpty(),
                    onContinue = onConfirmSelection,
                )
            } else if (awaitingSync) {
                SyncProgressPage(
                    syncMonitor = syncMonitor,
                    requestedAtMs = syncRequestedAtMs,
                    onFinished = onSyncFinished,
                    modifier = Modifier.weight(1f),
                )
                SyncBottomBar(onSkip = onSyncFinished)
            } else if (report == null && novelInventory == null) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(stringResource(MR.strings.epigraph_core_setup_nothing))
                }
            } else {
                when (step) {
                    STEP_REPOSITORIES -> {
                        val showComics = report != null
                        val showNovels = novelInventory != null
                        Box(modifier = Modifier.weight(1f)) {
                        if (showComics && showNovels) {
                            if (tab == 0) {
                                ComicRepositoryList(
                                    rows = comicRows,
                                    isBusy = isBusy,
                                    works = comicRepositoryWorks,
                                    activeIndexUrl = uiState.repositoryApproval.activeIndexUrl,
                                    onAdd = { row ->
                                        error = false
                                        launchAction {
                                            coordinator.approveRepository(row.indexUrl)
                                            val outcome = coordinator.state.value.repositoryApproval.outcome
                                            if (outcome != RepositoryApprovalOutcome.ADDED &&
                                                outcome != RepositoryApprovalOutcome.ALREADY_CONFIGURED
                                            ) {
                                                error = true
                                            }
                                            comicRows = coordinator.desktopRepositories(report!!)
                                            busy = false
                                        }
                                    },
                                )
                            } else {
                                NovelRepositoryList(
                                    inventory = novelInventory!!,
                                    isBusy = isBusy,
                                    worksFor = novelRepositoryWorks,
                                    onAdd = { repositoryId ->
                                        error = false
                                        launchAction {
                                            val result = novelCoordinator.approveRepository(
                                                effectiveServerId!!,
                                                effectiveProfileId!!,
                                                repositoryId,
                                            )
                                            if (
                                                result !is LnReaderRepositoryApprovalResult.Approved &&
                                                result !is LnReaderRepositoryApprovalResult.AlreadyApproved
                                            ) {
                                                error = true
                                            }
                                            novelInventory = novelCoordinator.inventory(
                                                effectiveServerId!!,
                                                effectiveProfileId!!,
                                            )
                                            busy = false
                                        }
                                    },
                                )
                            }
                        } else if (showComics) {
                            ComicRepositoryList(
                                rows = comicRows,
                                isBusy = isBusy,
                                works = comicRepositoryWorks,
                                activeIndexUrl = uiState.repositoryApproval.activeIndexUrl,
                                onAdd = { row ->
                                    error = false
                                    launchAction {
                                        coordinator.approveRepository(row.indexUrl)
                                        val outcome = coordinator.state.value.repositoryApproval.outcome
                                        if (outcome != RepositoryApprovalOutcome.ADDED &&
                                            outcome != RepositoryApprovalOutcome.ALREADY_CONFIGURED
                                        ) {
                                            error = true
                                        }
                                        comicRows = coordinator.desktopRepositories(report!!)
                                        busy = false
                                    }
                                },
                            )
                        } else {
                            NovelRepositoryList(
                                inventory = novelInventory!!,
                                isBusy = isBusy,
                                worksFor = novelRepositoryWorks,
                                onAdd = { repositoryId ->
                                    error = false
                                    launchAction {
                                        val result = novelCoordinator.approveRepository(
                                            effectiveServerId!!,
                                            effectiveProfileId!!,
                                            repositoryId,
                                        )
                                        if (
                                            result !is LnReaderRepositoryApprovalResult.Approved &&
                                            result !is LnReaderRepositoryApprovalResult.AlreadyApproved
                                        ) {
                                            error = true
                                        }
                                        novelInventory = novelCoordinator.inventory(
                                            effectiveServerId!!,
                                            effectiveProfileId!!,
                                        )
                                        busy = false
                                    }
                                },
                            )
                        }
                        }

                        Step1BottomBar(
                            isBusy = isBusy,
                            hasUnadded = if (showComics && showNovels) {
                                if (tab == 0) comicRows.any { !it.added }
                                else novelInventory!!.repositories.any {
                                    it.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED
                                }
                            } else if (showComics) {
                                comicRows.any { !it.added }
                            } else {
                                novelInventory!!.repositories.any {
                                    it.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED
                                }
                            },
                            onAddAll = {
                                error = false
                                launchAction {
                                    if (showComics && showNovels) {
                                        if (tab == 0) {
                                            comicRows.filter { !it.added }.forEach { row ->
                                                coordinator.approveRepository(row.indexUrl)
                                            }
                                        } else {
                                            novelInventory!!.repositories
                                                .filter { it.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED }
                                                .forEach { item ->
                                                    novelCoordinator.approveRepository(
                                                        effectiveServerId!!,
                                                        effectiveProfileId!!,
                                                        item.requirement.repositoryId,
                                                    )
                                                }
                                        }
                                    } else if (showComics) {
                                        comicRows.filter { !it.added }.forEach { row ->
                                            coordinator.approveRepository(row.indexUrl)
                                        }
                                    } else {
                                        novelInventory!!.repositories
                                            .filter { it.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED }
                                            .forEach { item ->
                                                novelCoordinator.approveRepository(
                                                    effectiveServerId!!,
                                                    effectiveProfileId!!,
                                                    item.requirement.repositoryId,
                                                )
                                            }
                                    }
                                    comicRows = report?.let { coordinator.desktopRepositories(it) } ?: emptyList()
                                    if (effectiveServerId != null && effectiveProfileId != null) {
                                        novelInventory = novelCoordinator.inventory(effectiveServerId, effectiveProfileId)
                                    }
                                    busy = false
                                }
                            },
                            onNext = { step = STEP_EXTENSIONS },
                        )
                    }
                    else -> {
                        val showComics = report != null
                        val showNovels = novelInventory != null
                        Box(modifier = Modifier.weight(1f)) {
                        if (showComics && showNovels) {
                            if (tab == 0) {
                                ComicExtensionList(
                                    items = report!!.items,
                                    isBusy = isBusy,
                                    worksFor = comicExtensionWorks,
                                    activePackageNames = uiState.installation.activePackageNames,
                                    onInstall = { packageName ->
                                        error = false
                                        launchAction {
                                            coordinator.installOne(packageName)
                                            busy = false
                                        }
                                    },
                                    onTrust = { packageName ->
                                        error = false
                                        launchAction {
                                            coordinator.trustUntrusted(packageName)
                                            busy = false
                                        }
                                    },
                                )
                            } else {
                                NovelPluginList(
                                    inventory = novelInventory!!,
                                    isBusy = isBusy,
                                    worksFor = novelPluginWorks,
                                    iconFor = novelPluginIcon,
                                    onInstall = { pluginId ->
                                        error = false
                                        launchAction {
                                            val result = novelCoordinator.installPlugin(
                                                effectiveServerId!!,
                                                effectiveProfileId!!,
                                                pluginId,
                                            )
                                            if (
                                                result != LnReaderPluginInstallResult.Installed &&
                                                result != LnReaderPluginInstallResult.AlreadyInstalled
                                            ) {
                                                error = true
                                            }
                                            novelInventory = novelCoordinator.inventory(
                                                effectiveServerId!!,
                                                effectiveProfileId!!,
                                            )
                                            busy = false
                                        }
                                    },
                                )
                            }
                        } else if (showComics) {
                            ComicExtensionList(
                                items = report!!.items,
                                isBusy = isBusy,
                                worksFor = comicExtensionWorks,
                                activePackageNames = uiState.installation.activePackageNames,
                                onInstall = { packageName ->
                                    error = false
                                    launchAction {
                                        coordinator.installOne(packageName)
                                        busy = false
                                    }
                                },
                                onTrust = { packageName ->
                                    error = false
                                    launchAction {
                                        coordinator.trustUntrusted(packageName)
                                        busy = false
                                    }
                                },
                            )
                        } else {
                            NovelPluginList(
                                inventory = novelInventory!!,
                                isBusy = isBusy,
                                worksFor = novelPluginWorks,
                                iconFor = novelPluginIcon,
                                onInstall = { pluginId ->
                                    error = false
                                    launchAction {
                                        val result = novelCoordinator.installPlugin(
                                            effectiveServerId!!,
                                            effectiveProfileId!!,
                                            pluginId,
                                        )
                                        if (
                                            result != LnReaderPluginInstallResult.Installed &&
                                            result != LnReaderPluginInstallResult.AlreadyInstalled
                                        ) {
                                            error = true
                                        }
                                        novelInventory = novelCoordinator.inventory(
                                            effectiveServerId!!,
                                            effectiveProfileId!!,
                                        )
                                        busy = false
                                    }
                                },
                            )
                        }
                        }

                        Step2BottomBar(
                            isBusy = isBusy,
                            hasInstallable = if (showComics && showNovels) {
                                if (tab == 0) report!!.items.any { it.status in COMIC_ACTIONABLE_STATUSES }
                                else novelInventory!!.plugins.any { it.status in NOVEL_INSTALLABLE_STATUSES }
                            } else if (showComics) {
                                report!!.items.any { it.status in COMIC_ACTIONABLE_STATUSES }
                            } else {
                                novelInventory!!.plugins.any { it.status in NOVEL_INSTALLABLE_STATUSES }
                            },
                            onBack = { step = STEP_REPOSITORIES },
                            onInstallAll = {
                                error = false
                                launchAction {
                                    if (showComics && showNovels) {
                                        if (tab == 0) {
                                            coordinator.trustAllUntrusted()
                                            coordinator.installAllMissing()
                                        } else {
                                            installNovelPlugins()
                                        }
                                    } else if (showComics) {
                                        coordinator.trustAllUntrusted()
                                        coordinator.installAllMissing()
                                    } else {
                                        installNovelPlugins()
                                    }
                                    if (effectiveServerId != null && effectiveProfileId != null) {
                                        novelInventory = novelCoordinator.inventory(effectiveServerId, effectiveProfileId)
                                    }
                                    busy = false
                                }
                            },
                            onDone = onClose,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ComicRepositoryList(
    rows: List<ComicRepositoryRow>,
    works: Map<String, Int>,
    isBusy: Boolean,
    activeIndexUrl: String?,
    onAdd: (ComicRepositoryRow) -> Unit,
) {
    if (rows.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(MR.strings.epigraph_core_setup_nothing),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(rows, key = { it.indexUrl }) { row ->
            ListItem(
                leadingContent = { DependencyIcon(label = row.name, model = repositoryIconUrl(row.indexUrl)) },
                headlineContent = { Text(row.name) },
                supportingContent = {
                    Text(
                        withWorks(
                            runCatching { java.net.URI(row.indexUrl).host }.getOrNull().orEmpty(),
                            works[row.indexUrl] ?: 0,
                        ),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    if (row.added) {
                        Icon(
                            Icons.Outlined.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    } else if (activeIndexUrl == row.indexUrl) {
                        CircularProgressIndicator(modifier = Modifier.size(20.dp))
                    } else {
                        TextButton(
                            enabled = !isBusy,
                            onClick = { onAdd(row) },
                        ) { Text(stringResource(MR.strings.epigraph_core_setup_add)) }
                    }
                },
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
        }
    }
}

@Composable
private fun NovelRepositoryList(
    inventory: LnReaderDependencyInventory,
    worksFor: (String) -> Int,
    isBusy: Boolean,
    onAdd: (String) -> Unit,
) {
    if (inventory.repositories.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(MR.strings.epigraph_core_setup_nothing),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(inventory.repositories, key = { it.requirement.repositoryId }) { item ->
            ListItem(
                leadingContent = {
                    DependencyIcon(
                        label = item.requirement.displayName,
                        model = repositoryIconUrl(item.requirement.canonicalUrl),
                    )
                },
                headlineContent = { Text(item.requirement.displayName) },
                supportingContent = {
                    Text(
                        withWorks(
                            runCatching { java.net.URI(item.requirement.canonicalUrl).host }.getOrNull().orEmpty(),
                            worksFor(item.requirement.repositoryId),
                        ),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    if (item.status == LnReaderRepositoryParityStatus.INSTALLED) {
                        Icon(
                            Icons.Outlined.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    } else if (item.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED) {
                        TextButton(
                            enabled = !isBusy,
                            onClick = { onAdd(item.requirement.repositoryId) },
                        ) { Text(stringResource(MR.strings.epigraph_core_setup_add)) }
                    }
                },
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
        }
    }
}

@Composable
private fun Step1BottomBar(
    isBusy: Boolean,
    hasUnadded: Boolean,
    onAddAll: () -> Unit,
    onNext: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (hasUnadded) {
            TextButton(
                enabled = !isBusy,
                onClick = onAddAll,
            ) { Text(stringResource(MR.strings.epigraph_core_setup_add_all)) }
            Spacer(Modifier.width(12.dp))
        }
        Button(
            shape = MaterialTheme.shapes.small,
            enabled = !isBusy,
            onClick = onNext,
        ) { Text(stringResource(MR.strings.epigraph_core_setup_next)) }
    }
}

@Composable
private fun statusText(status: ExtensionParityStatus): String = when (status) {
    ExtensionParityStatus.INSTALLED -> stringResource(MR.strings.epigraph_core_extension_installed)
    ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE ->
        stringResource(MR.strings.epigraph_core_extension_update_available)
    ExtensionParityStatus.MISSING_AVAILABLE -> stringResource(MR.strings.epigraph_core_extension_missing)
    ExtensionParityStatus.MISSING_UNAVAILABLE -> stringResource(MR.strings.epigraph_core_extension_unavailable)
    ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED ->
        stringResource(MR.strings.epigraph_core_extension_repository_required)
    ExtensionParityStatus.SOURCE_ID_MISMATCH -> stringResource(MR.strings.epigraph_core_extension_mismatch)
    ExtensionParityStatus.UNTRUSTED_OR_BLOCKED -> stringResource(MR.strings.epigraph_core_extension_blocked)
}

@Composable
private fun pluginStatusText(status: LnReaderPluginParityStatus): String = when (status) {
    LnReaderPluginParityStatus.INSTALLED -> stringResource(MR.strings.epigraph_core_extension_installed)
    LnReaderPluginParityStatus.UPDATE_AVAILABLE ->
        stringResource(MR.strings.epigraph_core_extension_update_available)
    LnReaderPluginParityStatus.MISSING_AVAILABLE -> stringResource(MR.strings.epigraph_core_extension_missing)
    LnReaderPluginParityStatus.MISSING_UNAVAILABLE ->
        stringResource(MR.strings.epigraph_core_novel_plugin_from_desktop)
    LnReaderPluginParityStatus.IDENTITY_MISMATCH -> stringResource(MR.strings.epigraph_core_extension_mismatch)
    LnReaderPluginParityStatus.UNTRUSTED_OR_BLOCKED ->
        stringResource(MR.strings.epigraph_core_extension_blocked)
}

@Composable
private fun ComicExtensionList(
    items: List<ExtensionParityItem>,
    worksFor: (ExtensionParityItem) -> Int,
    isBusy: Boolean,
    activePackageNames: Set<String>,
    onInstall: (String) -> Unit,
    onTrust: (String) -> Unit,
) {
    val sorted = items.sortedWith(
        compareBy(
            {
                when (it.status) {
                    ExtensionParityStatus.MISSING_AVAILABLE,
                    ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE,
                    ExtensionParityStatus.UNTRUSTED_OR_BLOCKED,
                    -> 0
                    ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED,
                    ExtensionParityStatus.MISSING_UNAVAILABLE,
                    ExtensionParityStatus.SOURCE_ID_MISMATCH,
                    -> 1
                    ExtensionParityStatus.INSTALLED -> 2
                }
            },
            { it.displayName },
        ),
    )
    if (sorted.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(MR.strings.epigraph_core_setup_nothing),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(sorted, key = { it.packageName }) { item ->
            ListItem(
                leadingContent = {
                    DependencyIcon(
                        label = item.displayName,
                        model = item.iconUrl(),
                        installedPackageName = item.packageName.takeIf {
                            item.status == ExtensionParityStatus.INSTALLED ||
                                item.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE ||
                                item.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
                        },
                    )
                },
                headlineContent = { Text(item.displayName) },
                supportingContent = {
                    Text(
                        withWorks(statusText(item.status), worksFor(item)),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    when {
                        item.packageName in activePackageNames ->
                            CircularProgressIndicator(modifier = Modifier.size(20.dp))
                        item.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                            item.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE ->
                            TextButton(
                                enabled = !isBusy,
                                onClick = { onInstall(item.packageName) },
                            ) { Text(stringResource(MR.strings.epigraph_core_novel_plugin_install)) }
                        item.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED ->
                            TextButton(
                                enabled = !isBusy,
                                onClick = { onTrust(item.packageName) },
                            ) { Text(stringResource(MR.strings.epigraph_core_extension_trust)) }
                        item.status == ExtensionParityStatus.INSTALLED ->
                            Icon(
                                Icons.Outlined.Check,
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.primary,
                            )
                    }
                },
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
        }
    }
}

@Composable
private fun NovelPluginList(
    inventory: LnReaderDependencyInventory,
    worksFor: (LnReaderPluginInventoryItem) -> Int,
    iconFor: (LnReaderPluginInventoryItem) -> Any?,
    isBusy: Boolean,
    onInstall: (String) -> Unit,
) {
    val sorted = inventory.plugins.sortedWith(
        compareBy(
            {
                when (it.status) {
                    LnReaderPluginParityStatus.MISSING_AVAILABLE,
                    LnReaderPluginParityStatus.UPDATE_AVAILABLE,
                    LnReaderPluginParityStatus.MISSING_UNAVAILABLE,
                    LnReaderPluginParityStatus.IDENTITY_MISMATCH,
                    -> 0
                    LnReaderPluginParityStatus.UNTRUSTED_OR_BLOCKED -> 1
                    LnReaderPluginParityStatus.INSTALLED -> 2
                }
            },
            { it.requirement.name.ifBlank { it.requirement.pluginId } },
        ),
    )
    if (sorted.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize(),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                stringResource(MR.strings.epigraph_core_setup_nothing),
                modifier = Modifier.padding(24.dp),
            )
        }
        return
    }
    LazyColumn(modifier = Modifier.fillMaxSize()) {
        items(sorted, key = { it.requirement.pluginId }) { item ->
            val canInstall = item.status in NOVEL_INSTALLABLE_STATUSES
            ListItem(
                leadingContent = {
                    DependencyIcon(
                        label = item.requirement.name.ifBlank { item.requirement.pluginId },
                        model = iconFor(item),
                    )
                },
                headlineContent = {
                    Text(item.requirement.name.ifBlank { item.requirement.pluginId })
                },
                supportingContent = {
                    Text(
                        withWorks(pluginStatusText(item.status), worksFor(item)),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    if (canInstall) {
                        TextButton(
                            enabled = !isBusy,
                            onClick = { onInstall(item.requirement.pluginId) },
                        ) { Text(stringResource(MR.strings.epigraph_core_novel_plugin_install)) }
                    } else if (item.status == LnReaderPluginParityStatus.INSTALLED) {
                        Icon(
                            Icons.Outlined.Check,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                        )
                    }
                },
            )
            HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
        }
    }
}

@Composable
private fun Step2BottomBar(
    isBusy: Boolean,
    hasInstallable: Boolean,
    onBack: () -> Unit,
    onInstallAll: () -> Unit,
    onDone: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(
            enabled = !isBusy,
            onClick = onBack,
        ) { Text(stringResource(MR.strings.epigraph_core_setup_back)) }
        Spacer(Modifier.width(12.dp))
        if (hasInstallable) {
            TextButton(
                enabled = !isBusy,
                onClick = onInstallAll,
            ) { Text(stringResource(MR.strings.epigraph_core_setup_install_all)) }
            Spacer(Modifier.width(12.dp))
        }
        Button(
            shape = MaterialTheme.shapes.small,
            enabled = !isBusy,
            onClick = onDone,
        ) { Text(stringResource(MR.strings.epigraph_core_setup_done)) }
    }
}

private const val STEP_SELECTION = 0
private const val STEP_REPOSITORIES = 1
private const val STEP_EXTENSIONS = 2

/** "What to sync" while it is edited; the same rules as the Core screen's selection editor. */
private data class SyncSelectionDraft(
    val comics: Boolean = true,
    val novels: Boolean = true,
    val books: Boolean = true,
    val comicRepositories: Boolean = true,
    val comicExtensions: Boolean = true,
    val novelRepositories: Boolean = true,
    val novelPlugins: Boolean = true,
) {
    val domains: Set<SyncDomain>
        get() = buildSet {
            if (comics) add(SyncDomain.COMICS)
            if (novels) add(SyncDomain.NOVELS)
            if (books) add(SyncDomain.BOOKS)
        }

    fun toPairingSelection() = PairingSyncSelection(
        enabledDomains = domains,
        compareComicRepositories = comicRepositories,
        compareComicExtensions = comicExtensions,
        compareNovelRepositories = novelRepositories,
        compareNovelPlugins = novelPlugins,
    )
}

@Composable
private fun SyncSelectionPage(
    selecting: CorePairingUiState.Selecting?,
    draft: SyncSelectionDraft,
    onChange: (SyncSelectionDraft) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 20.dp, vertical = 12.dp),
    ) {
        selecting?.let { VerificationCodeHeader(it.verificationCode, it.desktopName) }
        Text(
            stringResource(MR.strings.epigraph_core_sync_selection_summary),
            style = MaterialTheme.typography.bodyMedium,
        )
        SyncDomainChoice(
            title = stringResource(MR.strings.epigraph_core_sync_comics),
            summary = stringResource(MR.strings.epigraph_core_sync_comics_summary),
            checked = draft.comics,
            onCheckedChange = { onChange(draft.copy(comics = it)) },
        )
        InventoryChoice(
            title = stringResource(MR.strings.epigraph_core_sync_comic_repositories),
            checked = draft.comicRepositories,
            enabled = draft.comics && draft.comicExtensions,
            onCheckedChange = { onChange(draft.copy(comicRepositories = it)) },
        )
        InventoryChoice(
            title = stringResource(MR.strings.epigraph_core_sync_comic_extensions),
            checked = draft.comicExtensions,
            enabled = draft.comics,
            onCheckedChange = { onChange(draft.copy(comicExtensions = it)) },
        )
        SyncDomainChoice(
            title = stringResource(MR.strings.epigraph_core_sync_novels),
            summary = stringResource(MR.strings.epigraph_core_sync_novels_summary),
            checked = draft.novels,
            onCheckedChange = { onChange(draft.copy(novels = it)) },
        )
        InventoryChoice(
            title = stringResource(MR.strings.epigraph_core_sync_novel_repositories),
            checked = draft.novelRepositories,
            enabled = draft.novels,
            onCheckedChange = { onChange(draft.copy(novelRepositories = it)) },
        )
        InventoryChoice(
            title = stringResource(MR.strings.epigraph_core_sync_novel_plugins),
            checked = draft.novelPlugins,
            enabled = draft.novels,
            onCheckedChange = { onChange(draft.copy(novelPlugins = it)) },
        )
        SyncDomainChoice(
            title = stringResource(MR.strings.epigraph_core_sync_books),
            summary = stringResource(MR.strings.epigraph_core_sync_books_summary),
            checked = draft.books,
            onCheckedChange = { onChange(draft.copy(books = it)) },
        )
        Text(
            stringResource(MR.strings.epigraph_core_sync_selection_install_notice),
            modifier = Modifier.padding(top = 8.dp),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun SelectionBottomBar(
    enabled: Boolean,
    onContinue: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Button(
            shape = MaterialTheme.shapes.small,
            enabled = enabled,
            onClick = onContinue,
        ) { Text(stringResource(MR.strings.epigraph_core_sync_continue)) }
    }
}

/**
 * Follows the first sync after pairing and moves on once it ran: either a run was seen and has
 * ended, or the last finished run is newer than the request.
 */
@Composable
private fun SyncProgressPage(
    syncMonitor: CoreSyncStatusMonitor,
    requestedAtMs: Long,
    onFinished: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val status by remember(syncMonitor) { syncMonitor.status() }.collectAsState(initial = null)
    val currentOnFinished by rememberUpdatedState(onFinished)
    var sawRunning by remember(requestedAtMs) { mutableStateOf(false) }
    LaunchedEffect(status) {
        val current = status ?: return@LaunchedEffect
        if (current is CoreSyncStatus.Syncing || current is CoreSyncStatus.Queued) {
            sawRunning = true
            return@LaunchedEffect
        }
        val finishedSinceRequest = current is CoreSyncStatus.Synced && current.lastSyncAtMs >= requestedAtMs
        if (sawRunning || finishedSinceRequest) currentOnFinished()
    }
    Column(
        modifier = modifier.fillMaxWidth().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        CircularProgressIndicator()
        Spacer(Modifier.height(16.dp))
        Text(
            stringResource(MR.strings.epigraph_core_setup_syncing),
            style = MaterialTheme.typography.titleMedium,
        )
        val detail = when (val current = status) {
            is CoreSyncStatus.Syncing ->
                stringResource(MR.strings.epigraph_core_sync_status_syncing, current.counts.unsettled)
            is CoreSyncStatus.Queued ->
                stringResource(MR.strings.epigraph_core_sync_status_queued, current.counts.unsettled)
            else -> null
        }
        if (detail != null) {
            Spacer(Modifier.height(4.dp))
            Text(
                detail,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun SyncBottomBar(
    onSkip: () -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(16.dp),
        horizontalArrangement = Arrangement.End,
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onSkip) { Text(stringResource(MR.strings.epigraph_core_setup_skip)) }
    }
}

/**
 * The icon of a repository, extension or plugin: the installed app icon when there is one,
 * otherwise [model] loaded over the first letter of [label].
 */
@Composable
private fun DependencyIcon(
    label: String,
    model: Any?,
    installedPackageName: String? = null,
) {
    val context = LocalContext.current
    val appIcon = remember(installedPackageName) {
        installedPackageName?.let { packageName ->
            runCatching {
                context.packageManager.getApplicationIcon(packageName).toBitmap(96, 96).asImageBitmap()
            }.getOrNull()
        }
    }
    Box(
        modifier = Modifier
            .size(40.dp)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.secondaryContainer),
        contentAlignment = Alignment.Center,
    ) {
        if (appIcon != null) {
            Image(bitmap = appIcon, contentDescription = null, modifier = Modifier.fillMaxSize())
        } else {
            var loaded by remember(model) { mutableStateOf(false) }
            if (!loaded) {
                Text(
                    label.trim().take(1).uppercase(),
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onSecondaryContainer,
                )
            }
            if (model != null) {
                AsyncImage(
                    model = model,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                    onSuccess = { loaded = true },
                )
            }
        }
    }
}

/** The avatar of the GitHub owner serving a repository, when it is served from GitHub. */
private fun repositoryIconUrl(url: String): String? = runCatching {
    val uri = java.net.URI(url)
    val host = uri.host?.lowercase() ?: return@runCatching null
    val segments = uri.path.orEmpty().split('/').filter(String::isNotEmpty)
    val owner = when {
        host == "raw.githubusercontent.com" || host == "github.com" -> segments.firstOrNull()
        host.endsWith(".github.io") -> host.removeSuffix(".github.io")
        host == "cdn.jsdelivr.net" && segments.firstOrNull() == "gh" -> segments.getOrNull(1)
        else -> null
    }
    owner?.let { "https://github.com/$it.png?size=96" }
}.getOrNull()

@Composable
private fun withWorks(text: String, works: Int): String {
    val count = pluralStringResource(MR.plurals.epigraph_core_setup_works, works, works)
    return if (text.isBlank()) count else "$text · $count"
}

private fun ExtensionParityItem.repositoryIndexUrl(): String? =
    (repositoryHintUrl ?: storeIndexUrl)?.let(ExtensionParityResolver::repositoryIndexUrl)

private fun ExtensionParityItem.iconUrl(): String? =
    repositoryIndexUrl()?.let { "${ExtensionParityResolver.repositoryBaseUrl(it)}/icon/$packageName.png" }

private fun ExtensionParityItem.works(worksBySource: Map<Long, Int>): Int =
    sourceIds.distinct().sumOf { worksBySource[it] ?: 0 }

/** Comic statuses "install all" settles: untrusted packages are trusted, the rest installed. */
private val COMIC_ACTIONABLE_STATUSES = setOf(
    ExtensionParityStatus.MISSING_AVAILABLE,
    ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE,
    ExtensionParityStatus.UNTRUSTED_OR_BLOCKED,
)

/** A mismatched version is replaced by the desktop's exact artifact. */
private val NOVEL_INSTALLABLE_STATUSES = setOf(
    LnReaderPluginParityStatus.MISSING_AVAILABLE,
    LnReaderPluginParityStatus.UPDATE_AVAILABLE,
    LnReaderPluginParityStatus.MISSING_UNAVAILABLE,
    LnReaderPluginParityStatus.IDENTITY_MISMATCH,
)
