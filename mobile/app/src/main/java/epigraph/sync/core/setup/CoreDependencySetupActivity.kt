package epigraph.sync.core.setup

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.icerock.moko.resources.compose.stringResource
import epigraph.sync.core.extensions.ComicRepositoryRow
import epigraph.sync.core.extensions.ExtensionParityItem
import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionParityStatus
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.extensions.RepositoryApprovalOutcome
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.novels.LnReaderPluginParityStatus
import epigraph.sync.core.novels.LnReaderPluginInstallResult
import epigraph.sync.core.novels.LnReaderRepositoryApprovalResult
import epigraph.sync.core.novels.LnReaderRepositoryParityStatus
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.util.system.setThemeByPref
import co.touchlab.kermit.Logger
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import yokai.i18n.MR
import yokai.presentation.theme.YokaiTheme
import yokai.util.koin.injectLazy

class CoreDependencySetupActivity : AppCompatActivity() {
    private val preferences: PreferencesHelper by injectLazy()
    private val coordinator: ExtensionReconciliationCoordinator by injectLazy()
    private val novelCoordinator: LnReaderDependencyActionCoordinator by injectLazy()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setThemeByPref(preferences)
        lifecycleScope.launch { coordinator.refreshFromStore() }
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID)?.takeIf(String::isNotBlank)
        val profileId = intent.getStringExtra(EXTRA_PROFILE_ID)?.takeIf(String::isNotBlank)
        val startAtExtensions = intent.getBooleanExtra(EXTRA_START_AT_EXTENSIONS, false)
        setContent {
            YokaiTheme {
                CoreDependencySetupContent(
                    coordinator = coordinator,
                    novelCoordinator = novelCoordinator,
                    serverId = serverId,
                    profileId = profileId,
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

        fun intent(
            context: Context,
            serverId: String? = null,
            profileId: String? = null,
            startAtExtensions: Boolean = false,
        ): Intent = Intent(context, CoreDependencySetupActivity::class.java)
            .apply {
                serverId?.let { putExtra(EXTRA_SERVER_ID, it) }
                profileId?.let { putExtra(EXTRA_PROFILE_ID, it) }
                putExtra(EXTRA_START_AT_EXTENSIONS, startAtExtensions)
            }
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CoreDependencySetupContent(
    coordinator: ExtensionReconciliationCoordinator,
    novelCoordinator: LnReaderDependencyActionCoordinator,
    serverId: String?,
    profileId: String?,
    startAtExtensions: Boolean,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val uiState by coordinator.state.collectAsState()
    val report = uiState.report

    var step by remember { mutableStateOf(if (startAtExtensions) 2 else 1) }
    var tab by remember { mutableStateOf(0) }
    var comicRows by remember { mutableStateOf<List<ComicRepositoryRow>>(emptyList()) }
    var novelInventory by remember { mutableStateOf<LnReaderDependencyInventory?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf(false) }

    val effectiveServerId = serverId ?: report?.serverId
    val effectiveProfileId = profileId ?: report?.profileId

    LaunchedEffect(report) {
        if (report != null) {
            comicRows = coordinator.desktopRepositories(report)
        }
    }

    LaunchedEffect(effectiveServerId, effectiveProfileId) {
        if (effectiveServerId != null && effectiveProfileId != null) {
            novelInventory = novelCoordinator.inventory(effectiveServerId, effectiveProfileId)
        }
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

    val isBusy = busy ||
        uiState.installation.activePackageName != null ||
        uiState.repositoryApproval.activeIndexUrl != null

    BackHandler {
        if (isBusy) {
            onClose()
        } else if (step == 2) {
            step = 1
        } else {
            onClose()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        stringResource(
                            if (step == 1) MR.strings.epigraph_core_setup_repositories
                            else MR.strings.epigraph_core_setup_extensions,
                        ),
                    )
                },
                actions = {
                    IconButton(onClick = onClose) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(MR.strings.action_close))
                    }
                },
            )
        },
    ) { padding ->
        Column(modifier = Modifier.fillMaxSize().padding(padding)) {
            LinearProgressIndicator(
                progress = { if (step == 1) 0.5f else 1f },
                modifier = Modifier.fillMaxWidth(),
            )

            val showTabs = report != null && novelInventory != null
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

            if (report == null && novelInventory == null) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(stringResource(MR.strings.epigraph_core_setup_nothing))
                }
            } else {
                when (step) {
                    1 -> {
                        val showComics = report != null
                        val showNovels = novelInventory != null
                        Box(modifier = Modifier.weight(1f)) {
                        if (showComics && showNovels) {
                            if (tab == 0) {
                                ComicRepositoryList(
                                    rows = comicRows,
                                    isBusy = isBusy,
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
                            onNext = { step = 2 },
                        )
                    }
                    2 -> {
                        val showComics = report != null
                        val showNovels = novelInventory != null
                        Box(modifier = Modifier.weight(1f)) {
                        if (showComics && showNovels) {
                            if (tab == 0) {
                                ComicExtensionList(
                                    items = report!!.items,
                                    isBusy = isBusy,
                                    activePackageName = uiState.installation.activePackageName,
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
                                activePackageName = uiState.installation.activePackageName,
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
                                if (tab == 0) report!!.items.any {
                                    it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                                        it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                                }
                                else novelInventory!!.plugins.any {
                                    it.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                                        it.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                                        it.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                                }
                            } else if (showComics) {
                                report!!.items.any {
                                    it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
                                        it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                                }
                            } else {
                                novelInventory!!.plugins.any {
                                    it.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                                        it.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                                        it.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                                }
                            },
                            onBack = { step = 1 },
                            onInstallAll = {
                                error = false
                                launchAction {
                                    if (showComics && showNovels) {
                                        if (tab == 0) {
                                            coordinator.installAllMissing()
                                        } else {
                                            novelInventory!!.plugins
                                                .filter {
                                                    it.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                                                        it.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                                                        it.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                                                }
                                                .forEach { item ->
                                                    novelCoordinator.installPlugin(
                                                        effectiveServerId!!,
                                                        effectiveProfileId!!,
                                                        item.requirement.pluginId,
                                                    )
                                                }
                                        }
                                    } else if (showComics) {
                                        coordinator.installAllMissing()
                                    } else {
                                        novelInventory!!.plugins
                                            .filter {
                                                it.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                                                    it.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                                                    it.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                                            }
                                            .forEach { item ->
                                                novelCoordinator.installPlugin(
                                                    effectiveServerId!!,
                                                    effectiveProfileId!!,
                                                    item.requirement.pluginId,
                                                )
                                            }
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
                headlineContent = { Text(row.name) },
                supportingContent = {
                    Text(
                        runCatching { java.net.URI(row.indexUrl).host }.getOrNull().orEmpty(),
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
                headlineContent = { Text(item.requirement.displayName) },
                supportingContent = {
                    Text(
                        runCatching { java.net.URI(item.requirement.canonicalUrl).host }.getOrNull().orEmpty(),
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
    isBusy: Boolean,
    activePackageName: String?,
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
                headlineContent = { Text(item.displayName) },
                supportingContent = {
                    Text(
                        statusText(item.status),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                },
                trailingContent = {
                    when {
                        activePackageName == item.packageName ->
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
                    -> 0
                    LnReaderPluginParityStatus.IDENTITY_MISMATCH,
                    LnReaderPluginParityStatus.UNTRUSTED_OR_BLOCKED,
                    -> 1
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
            val canInstall = item.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                item.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                item.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
            ListItem(
                headlineContent = {
                    Text(item.requirement.name.ifBlank { item.requirement.pluginId })
                },
                supportingContent = {
                    Text(
                        pluginStatusText(item.status),
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
