package yokai.presentation.settings.screen

import epigraph.sync.core.pairing.EpigraphCorePairingController
import epigraph.sync.core.extensions.ExtensionReconciliationActivity
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.novels.LnReaderDependencyActivity
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.pairing.CorePairingUiState
import epigraph.sync.core.pairing.PairingBundleFailure
import epigraph.sync.core.pairing.PairingErrorCode
import epigraph.sync.core.pairing.PairingStage
import epigraph.sync.core.pairing.PairingSyncSelection
import epigraph.sync.core.policy.SyncDomain
import epigraph.sync.core.policy.DependencyInventoryMode
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.stringResource
import kotlinx.collections.immutable.persistentListOf
import org.koin.core.context.GlobalContext
import yokai.i18n.MR
import yokai.presentation.component.preference.Preference
import yokai.presentation.settings.ComposableSettings

object SettingsEpigraphCoreScreen : ComposableSettings() {
    private fun readResolve() = SettingsEpigraphCoreScreen

    @Composable
    override fun getTitleRes(): StringResource = MR.strings.epigraph_core

    @Composable
    override fun getPreferences(): List<Preference> {
        val controller = remember { GlobalContext.get().get<EpigraphCorePairingController>() }
        val extensionReconciliation = remember {
            GlobalContext.get().get<ExtensionReconciliationCoordinator>()
        }
        val novelDependencies = remember {
            GlobalContext.get().get<LnReaderDependencyActionCoordinator>()
        }
        val state by controller.state.collectAsState()
        val persistedSelection by controller.selection.collectAsState()
        val extensionState by extensionReconciliation.state.collectAsState()
        val context = LocalContext.current
        var showPasteDialog by remember { mutableStateOf(false) }
        var bundleText by remember { mutableStateOf("") }
        var syncComics by remember { mutableStateOf(true) }
        var syncNovels by remember { mutableStateOf(true) }
        var syncBooks by remember { mutableStateOf(true) }
        var compareComicRepositories by remember { mutableStateOf(true) }
        var compareComicExtensions by remember { mutableStateOf(true) }
        var compareNovelRepositories by remember { mutableStateOf(true) }
        var compareNovelPlugins by remember { mutableStateOf(true) }
        var showSelectionEditor by remember { mutableStateOf(false) }
        var novelInventory by remember { mutableStateOf<LnReaderDependencyInventory?>(null) }

        LaunchedEffect(controller) { controller.refresh() }
        LaunchedEffect(extensionReconciliation) { extensionReconciliation.refreshFromStore() }
        LaunchedEffect(persistedSelection?.serverId, persistedSelection?.profileId) {
            val selection = persistedSelection
            novelInventory = if (selection == null) {
                null
            } else {
                novelDependencies.inventory(selection.serverId, selection.profileId)
            }
        }
        LaunchedEffect((state as? CorePairingUiState.Selecting)?.serverId, showSelectionEditor) {
            if (state is CorePairingUiState.Selecting) {
                syncComics = true
                syncNovels = true
                syncBooks = true
                compareComicRepositories = true
                compareComicExtensions = true
                compareNovelRepositories = true
                compareNovelPlugins = true
            } else if (showSelectionEditor && persistedSelection != null) {
                val selection = persistedSelection ?: return@LaunchedEffect
                syncComics = SyncDomain.COMICS in selection.enabledDomains
                syncNovels = SyncDomain.NOVELS in selection.enabledDomains
                syncBooks = SyncDomain.BOOKS in selection.enabledDomains
                compareComicRepositories =
                    selection.comicRepositories == DependencyInventoryMode.INVENTORY_ONLY
                compareComicExtensions = selection.comicExtensions == DependencyInventoryMode.INVENTORY_ONLY
                compareNovelRepositories = selection.novelRepositories == DependencyInventoryMode.INVENTORY_ONLY
                compareNovelPlugins = selection.novelPlugins == DependencyInventoryMode.INVENTORY_ONLY
            }
        }

        fun beginPairing(bundle: String) {
            controller.startPairing(bundle)
        }

        val scanner = rememberLauncherForActivityResult(ScanContract()) { result ->
            result.contents?.takeIf(String::isNotBlank)?.let(::beginPairing)
        }
        val scannerPrompt = stringResource(MR.strings.epigraph_core_scan_qr_summary)
        val busy = state is CorePairingUiState.Pairing ||
            state is CorePairingUiState.Loading ||
            state is CorePairingUiState.Selecting

        val selectingPairing = state is CorePairingUiState.Selecting
        if (selectingPairing || showSelectionEditor) {
            val selectedDomains = buildSet {
                if (syncComics) add(SyncDomain.COMICS)
                if (syncNovels) add(SyncDomain.NOVELS)
                if (syncBooks) add(SyncDomain.BOOKS)
            }
            AlertDialog(
                onDismissRequest = {
                    if (selectingPairing) controller.cancelPairingSelection() else showSelectionEditor = false
                },
                title = { Text(stringResource(MR.strings.epigraph_core_sync_selection_title)) },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        Text(
                            stringResource(MR.strings.epigraph_core_sync_selection_summary),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        SyncDomainChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_comics),
                            summary = stringResource(MR.strings.epigraph_core_sync_comics_summary),
                            checked = syncComics,
                            onCheckedChange = { syncComics = it },
                        )
                        InventoryChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_comic_repositories),
                            checked = compareComicRepositories,
                            enabled = syncComics && compareComicExtensions,
                            onCheckedChange = { compareComicRepositories = it },
                        )
                        InventoryChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_comic_extensions),
                            checked = compareComicExtensions,
                            enabled = syncComics,
                            onCheckedChange = { compareComicExtensions = it },
                        )
                        SyncDomainChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_novels),
                            summary = stringResource(MR.strings.epigraph_core_sync_novels_summary),
                            checked = syncNovels,
                            onCheckedChange = { syncNovels = it },
                        )
                        InventoryChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_novel_repositories),
                            checked = compareNovelRepositories,
                            enabled = syncNovels,
                            onCheckedChange = { compareNovelRepositories = it },
                        )
                        InventoryChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_novel_plugins),
                            checked = compareNovelPlugins,
                            enabled = syncNovels,
                            onCheckedChange = { compareNovelPlugins = it },
                        )
                        SyncDomainChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_books),
                            summary = stringResource(MR.strings.epigraph_core_sync_books_summary),
                            checked = syncBooks,
                            onCheckedChange = { syncBooks = it },
                        )
                        Text(
                            stringResource(MR.strings.epigraph_core_sync_selection_install_notice),
                            modifier = Modifier.padding(top = 8.dp),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                },
                confirmButton = {
                    TextButton(
                        enabled = selectedDomains.isNotEmpty(),
                        onClick = {
                            val selection = PairingSyncSelection(
                                enabledDomains = selectedDomains,
                                compareComicRepositories = compareComicRepositories,
                                compareComicExtensions = compareComicExtensions,
                                compareNovelRepositories = compareNovelRepositories,
                                compareNovelPlugins = compareNovelPlugins,
                            )
                            if (selectingPairing) controller.confirmPairing(selection) else controller.updateSelection(selection)
                            showSelectionEditor = false
                        },
                    ) {
                        Text(
                            stringResource(
                                if (selectingPairing) {
                                    MR.strings.epigraph_core_sync_continue
                                } else {
                                    MR.strings.epigraph_core_sync_save_selection
                                },
                            ),
                        )
                    }
                },
                dismissButton = {
                    TextButton(onClick = {
                        if (selectingPairing) controller.cancelPairingSelection() else showSelectionEditor = false
                    }) {
                        Text(stringResource(MR.strings.action_cancel))
                    }
                },
            )
        }

        if (showPasteDialog) {
            AlertDialog(
                onDismissRequest = {
                    if (!busy) {
                        bundleText = ""
                        showPasteDialog = false
                    }
                },
                title = { Text(stringResource(MR.strings.epigraph_core_pairing_bundle)) },
                text = {
                    OutlinedTextField(
                        value = bundleText,
                        onValueChange = { bundleText = it },
                        enabled = !busy,
                        singleLine = false,
                        minLines = 4,
                        label = { Text(stringResource(MR.strings.epigraph_core_pairing_bundle)) },
                    )
                },
                confirmButton = {
                    TextButton(
                        enabled = bundleText.isNotBlank() && !busy,
                        onClick = {
                            val submitted = bundleText
                            bundleText = ""
                            showPasteDialog = false
                            beginPairing(submitted)
                        },
                    ) { Text(stringResource(MR.strings.epigraph_core_pair)) }
                },
                dismissButton = {
                    TextButton(
                        enabled = !busy,
                        onClick = {
                            bundleText = ""
                            showPasteDialog = false
                        },
                    ) { Text(stringResource(MR.strings.action_cancel)) }
                },
            )
        }

        return persistentListOf(
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.epigraph_core),
                preferenceItems = persistentListOf(
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_status),
                        subtitle = statusText(state),
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_scan_qr),
                        subtitle = stringResource(MR.strings.epigraph_core_scan_qr_summary),
                        enabled = !busy,
                        onClick = {
                            scanner.launch(
                                ScanOptions()
                                    .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                                    .setPrompt(scannerPrompt)
                                    .setBeepEnabled(false)
                                    .setBarcodeImageEnabled(false)
                                    .setOrientationLocked(false),
                            )
                        },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_paste_bundle),
                        subtitle = stringResource(MR.strings.epigraph_core_paste_bundle_summary),
                        enabled = !busy,
                        onClick = { showPasteDialog = true },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_sync_selection_title),
                        subtitle = syncSelectionSummary(state, persistedSelection),
                        enabled = state is CorePairingUiState.Paired && persistedSelection != null,
                        onClick = { showSelectionEditor = true },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_disconnect),
                        subtitle = stringResource(MR.strings.epigraph_core_disconnect_summary),
                        enabled = state is CorePairingUiState.Paired,
                        onClick = { controller.startDisconnect() },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_extensions_title),
                        subtitle = extensionState.report?.let { report ->
                            stringResource(
                                MR.strings.epigraph_core_extensions_summary,
                                report.installedCount,
                                report.availableToInstallCount,
                                report.unavailableCount,
                            )
                        } ?: stringResource(MR.strings.epigraph_core_extensions_no_inventory),
                        enabled = extensionState.report != null,
                        onClick = {
                            context.startActivity(ExtensionReconciliationActivity.intent(context))
                        },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_novel_dependencies_title),
                        subtitle = novelInventory?.let { inventory ->
                            stringResource(
                                MR.strings.epigraph_core_novel_dependencies_summary,
                                inventory.repositories.size,
                                inventory.plugins.size,
                            )
                        } ?: stringResource(MR.strings.epigraph_core_novel_dependencies_no_inventory),
                        enabled = state is CorePairingUiState.Paired &&
                            persistedSelection?.novelRepositories == DependencyInventoryMode.INVENTORY_ONLY,
                        onClick = {
                            val selection = persistedSelection ?: return@TextPreference
                            context.startActivity(
                                LnReaderDependencyActivity.intent(
                                    context,
                                    selection.serverId,
                                    selection.profileId,
                                ),
                            )
                        },
                    ),
                ),
            ),
        )
    }

    @Composable
    private fun syncSelectionSummary(
        state: CorePairingUiState,
        selection: epigraph.sync.core.policy.DeviceSyncSelectionV1?,
    ): String {
        val paired = state as? CorePairingUiState.Paired
            ?: return stringResource(MR.strings.epigraph_core_sync_selection_summary)
        val selected = selection ?: return stringResource(MR.strings.epigraph_core_sync_selection_summary)
        val requiredScopes = selected.enabledDomains.map { domain ->
            when (domain) {
                SyncDomain.COMICS -> "comics:profile:${paired.profileId}"
                SyncDomain.NOVELS -> "novels:profile:${paired.profileId}"
                SyncDomain.BOOKS -> "books:global"
            }
        }
        return if (requiredScopes.any { it !in paired.scopes }) {
            stringResource(MR.strings.epigraph_core_sync_authorization_required)
        } else {
            stringResource(MR.strings.epigraph_core_sync_selection_summary)
        }
    }

    @Composable
    private fun statusText(state: CorePairingUiState): String = when (state) {
        CorePairingUiState.Loading -> stringResource(MR.strings.epigraph_core_loading)
        CorePairingUiState.Unpaired -> stringResource(MR.strings.epigraph_core_not_paired)
        is CorePairingUiState.Selecting ->
            stringResource(MR.strings.epigraph_core_sync_selection_title)
        is CorePairingUiState.Paired -> if (state.verifiedInThisProcess) {
            stringResource(MR.strings.epigraph_core_paired, state.profileId, state.origin)
        } else {
            stringResource(MR.strings.epigraph_core_connection_saved, state.profileId, state.origin)
        }
        is CorePairingUiState.Pairing -> when (state.stage) {
            PairingStage.VALIDATING -> stringResource(MR.strings.epigraph_core_pairing_validating)
            PairingStage.CLAIMING -> stringResource(MR.strings.epigraph_core_pairing_claiming)
            PairingStage.WAITING_FOR_DESKTOP -> stringResource(MR.strings.epigraph_core_pairing_waiting)
            PairingStage.EXCHANGING_TOKEN -> stringResource(MR.strings.epigraph_core_pairing_exchanging)
            PairingStage.SAVING_CREDENTIAL -> stringResource(MR.strings.epigraph_core_pairing_saving)
        }
        is CorePairingUiState.CredentialFailed ->
            stringResource(MR.strings.epigraph_core_error_credentials)
        is CorePairingUiState.PairingFailed -> pairingErrorText(state.error, state.bundleFailure)
    }

    @Composable
    private fun SyncDomainChoice(
        title: String,
        summary: String,
        checked: Boolean,
        onCheckedChange: (Boolean) -> Unit,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 12.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Checkbox(checked = checked, onCheckedChange = onCheckedChange)
            Spacer(Modifier.width(8.dp))
            Column(modifier = Modifier.fillMaxWidth()) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(
                    summary,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }

    @Composable
    private fun InventoryChoice(
        title: String,
        checked: Boolean,
        enabled: Boolean,
        onCheckedChange: (Boolean) -> Unit,
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 40.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Checkbox(
                checked = checked && enabled,
                enabled = enabled,
                onCheckedChange = onCheckedChange,
            )
            Text(
                title,
                style = MaterialTheme.typography.bodySmall,
                color = if (enabled) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
                },
            )
        }
    }

    @Composable
    private fun pairingErrorText(
        error: PairingErrorCode,
        bundleFailure: PairingBundleFailure?,
    ): String = when (error) {
        PairingErrorCode.INVALID_BUNDLE -> {
            val base = stringResource(MR.strings.epigraph_core_error_invalid_bundle)
            bundleFailure?.let { "$base (${it.name})" } ?: base
        }
        PairingErrorCode.EXPIRED,
        PairingErrorCode.SESSION_NOT_FOUND,
        -> stringResource(MR.strings.epigraph_core_error_expired)
        PairingErrorCode.REJECTED,
        PairingErrorCode.ALREADY_CLAIMED,
        PairingErrorCode.APPROVED_FOR_OTHER_DEVICE,
        -> stringResource(MR.strings.epigraph_core_error_rejected)
        PairingErrorCode.TLS_MISMATCH -> stringResource(MR.strings.epigraph_core_error_tls)
        PairingErrorCode.NETWORK -> stringResource(MR.strings.epigraph_core_error_network)
        PairingErrorCode.PROTOCOL_MISMATCH,
        PairingErrorCode.CLIENT_UPGRADE_REQUIRED,
        -> stringResource(MR.strings.epigraph_core_error_upgrade)
        PairingErrorCode.UNAUTHORIZED,
        PairingErrorCode.INVALID_SESSION_STATUS,
        PairingErrorCode.INVALID_RESPONSE,
        -> stringResource(MR.strings.epigraph_core_error_generic)
    }
}
