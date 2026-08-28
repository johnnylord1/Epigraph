package epigraph.sync.core.extensions

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.activity.compose.BackHandler
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.Button
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.icerock.moko.resources.compose.stringResource
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.util.system.setThemeByPref
import kotlinx.coroutines.launch
import yokai.i18n.MR
import yokai.presentation.theme.YokaiTheme
import yokai.util.koin.injectLazy

class ExtensionReconciliationActivity : AppCompatActivity() {
    private val preferences: PreferencesHelper by injectLazy()
    private val coordinator: ExtensionReconciliationCoordinator by injectLazy()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setThemeByPref(preferences)
        lifecycleScope.launch { coordinator.refreshFromStore() }
        val autoInstall = intent.getBooleanExtra(EXTRA_INSTALL_ALL, false)
        setContent {
            YokaiTheme {
                ExtensionReconciliationContent(
                    coordinator = coordinator,
                    autoInstall = autoInstall,
                    onClose = {
                        coordinator.acknowledge()
                        finish()
                    },
                )
            }
        }
    }

    companion object {
        private const val EXTRA_INSTALL_ALL = "epigraph.extension_reconciliation.install_all"

        fun intent(context: Context, installAll: Boolean = false): Intent =
            Intent(context, ExtensionReconciliationActivity::class.java)
                .putExtra(EXTRA_INSTALL_ALL, installAll)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ExtensionReconciliationContent(
    coordinator: ExtensionReconciliationCoordinator,
    autoInstall: Boolean,
    onClose: () -> Unit,
) {
    val state by coordinator.state.collectAsState()
    val scope = rememberCoroutineScope()
    var autoInstallStarted by remember { mutableStateOf(false) }
    var pendingRepositoryUrl by remember { mutableStateOf<String?>(null) }
    var recommendedRepositoryUrls by remember { mutableStateOf(emptyList<String>()) }
    val report = state.report
    val installing = state.installation.activePackageName != null
    val missingTitle = stringResource(MR.strings.epigraph_core_extensions_missing)
    val installedTitle = stringResource(MR.strings.epigraph_core_extensions_installed)
    val unavailableTitle = stringResource(MR.strings.epigraph_core_extensions_unavailable)
    val blockedTitle = stringResource(MR.strings.epigraph_core_extensions_blocked_title)
    val downloadLabel = stringResource(MR.strings.epigraph_core_extensions_download)
    val trustLabel = stringResource(MR.strings.epigraph_core_extension_trust)
    val repositoryApprovalBusy = state.repositoryApproval.activeIndexUrl != null

    pendingRepositoryUrl?.let { indexUrl ->
        AlertDialog(
            onDismissRequest = { if (!repositoryApprovalBusy) pendingRepositoryUrl = null },
            title = { Text(stringResource(MR.strings.epigraph_core_extensions_repository_confirm_title)) },
            text = {
                Text(
                    stringResource(
                        MR.strings.epigraph_core_extensions_repository_confirm_body,
                        repositoryDisplayName(indexUrl),
                    ),
                )
            },
            dismissButton = {
                TextButton(
                    onClick = { pendingRepositoryUrl = null },
                    enabled = !repositoryApprovalBusy,
                ) {
                    Text(stringResource(MR.strings.action_cancel))
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        scope.launch {
                            coordinator.approveRepository(indexUrl)
                            pendingRepositoryUrl = null
                        }
                    },
                    enabled = !repositoryApprovalBusy,
                ) {
                    Text(stringResource(MR.strings.epigraph_core_extensions_repository_add))
                }
            },
        )
    }

    BackHandler { if (!installing) onClose() }

    LaunchedEffect(report) {
        recommendedRepositoryUrls = report
            ?.let { coordinator.recommendedMobileRepositoryIndexUrls(it) }
            .orEmpty()
    }

    val pendingRepositoryIndexUrls = report
        ?.let {
            it.items
                .filter { item -> item.status == ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED }
                .mapNotNull { item -> item.repositoryHintUrl }
                .plus(recommendedRepositoryUrls)
                .map(ExtensionParityResolver::repositoryIndexUrl)
                .distinct()
        }
        .orEmpty()

    // A notification action is an explicit user request for "download all", but it must not
    // bypass repository approval. The effect waits until the user has approved every required
    // repository and the catalog exposes installable artifacts; individual rows remain explicit
    // actions through the same coordinator.
    val hasPendingRepositoryApproval = report?.items?.any {
        it.status == ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED
    } == true
    LaunchedEffect(autoInstall, report?.inventoryHash, report?.installableCount, hasPendingRepositoryApproval) {
        if (
            autoInstall && report != null && !autoInstallStarted &&
            !hasPendingRepositoryApproval && report.installableCount > 0
        ) {
            autoInstallStarted = true
            coordinator.installAllMissing()
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(MR.strings.epigraph_core_extensions_title)) },
                actions = {
                    IconButton(onClick = onClose, enabled = !installing) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(MR.strings.action_close))
                    }
                },
            )
        },
        bottomBar = {
            if (report != null) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp, Alignment.End),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    TextButton(onClick = onClose, enabled = !installing) {
                        Text(stringResource(MR.strings.epigraph_core_extensions_later))
                    }
                    if (pendingRepositoryIndexUrls.isNotEmpty()) {
                        Button(
                            onClick = { scope.launch { coordinator.approveAllRecommendedRepositories() } },
                            enabled = !installing && !repositoryApprovalBusy,
                        ) {
                            Text(stringResource(MR.strings.epigraph_core_extensions_add_all_repositories))
                        }
                    }
                    Button(
                        onClick = { scope.launch { coordinator.installAllMissing() } },
                        // Repository approval is a separate explicit step. Do not start a batch
                        // while an inventory still needs trust, even if another package is already
                        // available from a configured repository.
                        enabled = report.installableCount > 0 &&
                            pendingRepositoryIndexUrls.isEmpty() &&
                            !installing,
                    ) {
                        Text(stringResource(MR.strings.epigraph_core_extensions_download_all))
                    }
                }
            }
        },
    ) { padding ->
        if (report == null) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Text(stringResource(MR.strings.epigraph_core_extensions_no_inventory))
            }
            return@Scaffold
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
        ) {
            item {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        text = stringResource(
                            MR.strings.epigraph_core_extensions_summary,
                            report.installedCount,
                            report.availableToInstallCount,
                            report.unavailableCount,
                        ),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    if (state.installation.total > 0) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (installing) CircularProgressIndicator()
                            Text(
                                stringResource(
                                    MR.strings.epigraph_core_extensions_install_progress,
                                    state.installation.completed,
                                    state.installation.total,
                                    state.installation.installed,
                                    state.installation.cancelled,
                                    state.installation.failed,
                                ),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                    repositoryApprovalMessage(state.repositoryApproval.outcome)?.let { message ->
                        Text(message, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
            repositorySection(
                indexUrls = pendingRepositoryIndexUrls,
                actionEnabled = !installing && !repositoryApprovalBusy,
                onAction = { pendingRepositoryUrl = it },
            )
            extensionSection(
                title = missingTitle,
                items = report.items.filter { it.status == ExtensionParityStatus.MISSING_AVAILABLE },
                actionLabel = downloadLabel,
                actionEnabled = !installing,
                onAction = { packageName -> scope.launch { coordinator.installOne(packageName) } },
            )
            extensionSection(
                title = installedTitle,
                items = report.items.filter {
                    it.status == ExtensionParityStatus.INSTALLED ||
                        it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE
                },
                actionLabel = downloadLabel,
                actionEnabled = !installing && pendingRepositoryIndexUrls.isEmpty(),
                onAction = { packageName -> scope.launch { coordinator.installOne(packageName) } },
                showAction = { it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE },
            )
            extensionSection(
                title = blockedTitle,
                items = report.items.filter {
                    it.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
                },
                actionLabel = trustLabel,
                actionEnabled = !installing,
                onAction = { packageName -> scope.launch { coordinator.trustUntrusted(packageName) } },
            )
            extensionSection(
                title = unavailableTitle,
                items = report.items.filter {
                    it.status != ExtensionParityStatus.MISSING_AVAILABLE &&
                        it.status != ExtensionParityStatus.INSTALLED &&
                        it.status != ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE &&
                        it.status != ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
                },
            )
        }
    }
}

private fun androidx.compose.foundation.lazy.LazyListScope.extensionSection(
    title: String,
    items: List<ExtensionParityItem>,
    actionLabel: String? = null,
    actionEnabled: Boolean = false,
    onAction: (String) -> Unit = {},
    showAction: (ExtensionParityItem) -> Boolean = { true },
) {
    if (items.isEmpty()) return
    item {
        Text(
            text = title,
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
        )
    }
    items(items, key = { it.packageName }) { item ->
        ListItem(
            headlineContent = {
                Text(item.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
            },
            supportingContent = {
                Column {
                    Text(
                        item.sourceNames.joinToString().ifBlank { item.packageName },
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Text(statusText(item.status), style = MaterialTheme.typography.bodySmall)
                }
            },
            trailingContent = actionLabel?.takeIf { showAction(item) }?.let {
                {
                    TextButton(onClick = { onAction(item.packageName) }, enabled = actionEnabled) {
                        Text(actionLabel)
                    }
                }
            },
        )
        HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
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

private fun androidx.compose.foundation.lazy.LazyListScope.repositorySection(
    indexUrls: List<String>,
    actionEnabled: Boolean,
    onAction: (String) -> Unit,
) {
    if (indexUrls.isEmpty()) return
    item {
        Text(
            text = stringResource(MR.strings.epigraph_core_extensions_repositories_title),
            style = MaterialTheme.typography.titleSmall,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
        )
    }
    items(indexUrls, key = { it }) { indexUrl ->
        ListItem(
            headlineContent = { Text(repositoryDisplayName(indexUrl)) },
            supportingContent = {
                Text(stringResource(MR.strings.epigraph_core_extensions_repository_required))
            },
            trailingContent = {
                TextButton(onClick = { onAction(indexUrl) }, enabled = actionEnabled) {
                    Text(stringResource(MR.strings.epigraph_core_extensions_repository_review))
                }
            },
        )
        HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
    }
}

private fun repositoryDisplayName(indexUrl: String): String = runCatching {
    java.net.URI(indexUrl).host
}.getOrNull().orEmpty().ifBlank { indexUrl }

@Composable
private fun repositoryApprovalMessage(outcome: RepositoryApprovalOutcome?): String? = when (outcome) {
    RepositoryApprovalOutcome.ADDED ->
        stringResource(MR.strings.epigraph_core_extensions_repository_added)
    RepositoryApprovalOutcome.ALREADY_CONFIGURED ->
        stringResource(MR.strings.epigraph_core_extensions_repository_already_added)
    RepositoryApprovalOutcome.INVALID ->
        stringResource(MR.strings.epigraph_core_extensions_repository_invalid)
    RepositoryApprovalOutcome.DUPLICATE_FINGERPRINT ->
        stringResource(MR.strings.epigraph_core_extensions_repository_conflict)
    RepositoryApprovalOutcome.FAILED ->
        stringResource(MR.strings.epigraph_core_extensions_repository_failed)
    null -> null
}
