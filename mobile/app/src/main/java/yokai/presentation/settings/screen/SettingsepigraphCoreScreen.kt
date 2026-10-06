package yokai.presentation.settings.screen

import epigraph.contract.ClientMutationId
import epigraph.sync.BlockedMutation
import epigraph.sync.EpigraphMutationCoordinator
import epigraph.sync.core.replica.NovelChapterCoverageCheck
import epigraph.sync.core.pairing.EpigraphCorePairingController
import epigraph.sync.core.extensions.ComicRepositoryRow
import epigraph.sync.core.setup.CoreDependencySetupActivity
import epigraph.sync.core.setup.InventoryChoice
import epigraph.sync.core.setup.SyncDomainChoice
import epigraph.sync.core.setup.coreDependencySetupCounts
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.pairing.CoreHostDiscoveryState
import epigraph.sync.core.pairing.CorePairingUiState
import epigraph.sync.core.pairing.DiscoveredCoreHost
import epigraph.sync.core.pairing.PairingBundleFailure
import epigraph.sync.core.pairing.PairingErrorCode
import epigraph.sync.core.pairing.PairingPin
import epigraph.sync.core.pairing.PairingStage
import epigraph.sync.core.pairing.PairingSyncSelection
import epigraph.sync.core.policy.SyncDomain
import epigraph.sync.core.policy.DependencyInventoryMode
import epigraph.sync.core.work.CoreSyncStatus
import epigraph.sync.core.work.CoreSyncStatusMonitor
import epigraph.sync.core.work.CoreUserActionReason
import eu.kanade.tachiyomi.util.relativeTimeSpanString
import java.util.UUID
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.google.zxing.client.android.Intents
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.pluralStringResource
import dev.icerock.moko.resources.compose.stringResource
import kotlinx.collections.immutable.persistentListOf
import kotlinx.collections.immutable.toPersistentList
import kotlinx.coroutines.launch
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
        val syncMonitor = remember { GlobalContext.get().get<CoreSyncStatusMonitor>() }
        val syncStatus by remember(syncMonitor) { syncMonitor.status() }
            .collectAsState(initial = null)
        val novelCoverageCheck = remember { GlobalContext.get().get<NovelChapterCoverageCheck>() }
        var novelsWithoutChapters by remember { mutableStateOf<List<String>>(emptyList()) }
        // Counts change on every poll while a sync runs; these lists only change when a sync ends.
        val syncStatusKind = syncStatus?.let { it::class }
        LaunchedEffect(syncStatusKind) {
            novelsWithoutChapters = runCatching { novelCoverageCheck.novelsWithoutChapters() }
                .getOrDefault(emptyList())
        }
        val coroutineScope = rememberCoroutineScope()
        val state by controller.state.collectAsState()
        val persistedSelection by controller.selection.collectAsState()
        val extensionState by extensionReconciliation.state.collectAsState()
        val context = LocalContext.current
        var showPasteDialog by remember { mutableStateOf(false) }
        var showDisconnectDialog by remember { mutableStateOf(false) }
        var showPinDialog by remember { mutableStateOf(false) }
        var pinText by remember { mutableStateOf("") }
        var selectedHost by remember { mutableStateOf<DiscoveredCoreHost?>(null) }
        var addressText by remember { mutableStateOf("") }
        var showAddressField by remember { mutableStateOf(false) }
        val discoveryState by controller.discovery.collectAsState()
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
        var comicRepositories by remember { mutableStateOf(emptyList<ComicRepositoryRow>()) }
        val mutationCoordinator = remember { GlobalContext.get().get<EpigraphMutationCoordinator>() }
        var blockedMutations by remember { mutableStateOf<List<BlockedMutation>>(emptyList()) }
        var showBlockedDialog by remember { mutableStateOf(false) }
        var blockedRefresh by remember { mutableStateOf(0) }
        LaunchedEffect(syncStatusKind, blockedRefresh) {
            blockedMutations = runCatching { mutationCoordinator.blockedMutations() }.getOrDefault(emptyList())
            if (blockedMutations.isEmpty()) showBlockedDialog = false
        }

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
        LaunchedEffect(extensionState.report) {
            comicRepositories = extensionState.report?.let { extensionReconciliation.desktopRepositories(it) }.orEmpty()
        }
        LaunchedEffect(showSelectionEditor) {
            if (showSelectionEditor && persistedSelection != null) {
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

        // Pairing continues in the setup window: what to sync, the first sync, then the desktop's
        // repositories and extensions.
        val selectingServerId = (state as? CorePairingUiState.Selecting)?.serverId
        LaunchedEffect(selectingServerId) {
            val selecting = state as? CorePairingUiState.Selecting ?: return@LaunchedEffect
            context.startActivity(
                CoreDependencySetupActivity.intent(
                    context,
                    selecting.serverId,
                    selecting.profileId,
                    startWithPairing = true,
                ),
            )
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

        if (showSelectionEditor) {
            val selectedDomains = buildSet {
                if (syncComics) add(SyncDomain.COMICS)
                if (syncNovels) add(SyncDomain.NOVELS)
                if (syncBooks) add(SyncDomain.BOOKS)
            }
            AlertDialog(
                onDismissRequest = { showSelectionEditor = false },
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
                            controller.updateSelection(selection)
                            showSelectionEditor = false
                        },
                    ) {
                        Text(stringResource(MR.strings.epigraph_core_sync_save_selection))
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showSelectionEditor = false }) {
                        Text(stringResource(MR.strings.cancel))
                    }
                },
            )
        }

        if (showDisconnectDialog) {
            // Forgetting the pairing also signs out tracker logins delivered by Core, so a stray
            // tap must not do it silently.
            AlertDialog(
                onDismissRequest = { showDisconnectDialog = false },
                title = { Text(stringResource(MR.strings.epigraph_core_disconnect)) },
                text = { Text(stringResource(MR.strings.epigraph_core_disconnect_confirm)) },
                confirmButton = {
                    TextButton(
                        onClick = {
                            showDisconnectDialog = false
                            controller.startDisconnect()
                        },
                    ) { Text(stringResource(MR.strings.epigraph_core_disconnect_confirm_action)) }
                },
                dismissButton = {
                    TextButton(onClick = { showDisconnectDialog = false }) {
                        Text(stringResource(MR.strings.cancel))
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
                    ) { Text(stringResource(MR.strings.cancel)) }
                },
            )
        }

        if (showPinDialog) {
            val hosts = (discoveryState as? CoreHostDiscoveryState.Found)?.hosts.orEmpty()
            LaunchedEffect(hosts) {
                if (selectedHost !in hosts) selectedHost = hosts.singleOrNull()
            }
            val normalizedPin = PairingPin.normalize(pinText)
            val closePinDialog = {
                pinText = ""
                selectedHost = null
                addressText = ""
                showAddressField = false
                showPinDialog = false
            }
            AlertDialog(
                onDismissRequest = { if (!busy) closePinDialog() },
                title = { Text(stringResource(MR.strings.epigraph_core_pin_pair)) },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        when (discoveryState) {
                            CoreHostDiscoveryState.Idle,
                            CoreHostDiscoveryState.Searching,
                            -> Text(
                                stringResource(MR.strings.epigraph_core_pin_searching),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            is CoreHostDiscoveryState.Found -> if (hosts.isEmpty()) {
                                Text(
                                    stringResource(MR.strings.epigraph_core_pin_no_hosts),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            } else {
                                hosts.forEach { host ->
                                    Row(
                                        modifier = Modifier.fillMaxWidth(),
                                        verticalAlignment = Alignment.CenterVertically,
                                    ) {
                                        RadioButton(
                                            selected = host == selectedHost,
                                            onClick = { selectedHost = host },
                                        )
                                        Text(
                                            stringResource(
                                                MR.strings.epigraph_core_pin_host,
                                                host.instanceName,
                                                host.verificationCode,
                                            ),
                                            style = MaterialTheme.typography.bodyMedium,
                                        )
                                    }
                                }
                            }
                        }
                        if (discoveryState is CoreHostDiscoveryState.Found) {
                            if (!showAddressField) {
                                TextButton(enabled = !busy, onClick = { showAddressField = true }) {
                                    Text(stringResource(MR.strings.epigraph_core_pin_address_open))
                                }
                            } else {
                                Text(
                                    stringResource(MR.strings.epigraph_core_pin_address_hint),
                                    style = MaterialTheme.typography.bodySmall,
                                    modifier = Modifier.padding(top = 12.dp),
                                )
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    OutlinedTextField(
                                        value = addressText,
                                        onValueChange = { value ->
                                            addressText = value.filterNot(Char::isWhitespace).take(64)
                                        },
                                        enabled = !busy,
                                        singleLine = true,
                                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                                        label = { Text(stringResource(MR.strings.epigraph_core_pin_address_label)) },
                                        modifier = Modifier.weight(1f),
                                    )
                                    TextButton(
                                        enabled = !busy && addressText.isNotBlank(),
                                        onClick = { controller.probeHostAddress(addressText) },
                                    ) { Text(stringResource(MR.strings.epigraph_core_pin_address_find)) }
                                }
                                if ((discoveryState as CoreHostDiscoveryState.Found).addressFailed) {
                                    Text(
                                        stringResource(MR.strings.epigraph_core_pin_address_failed),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        }
                        OutlinedTextField(
                            value = pinText,
                            onValueChange = { value ->
                                pinText = value.filter { it.isDigit() || it == ' ' || it == '-' }.take(12)
                            },
                            enabled = !busy,
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.NumberPassword),
                            label = { Text(stringResource(MR.strings.epigraph_core_pin_label)) },
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(top = 12.dp),
                        )
                    }
                },
                confirmButton = {
                    if (discoveryState is CoreHostDiscoveryState.Found && hosts.isEmpty()) {
                        TextButton(onClick = { controller.discoverHosts() }) {
                            Text(stringResource(MR.strings.epigraph_core_pin_search_again))
                        }
                    } else {
                        TextButton(
                            enabled = !busy && normalizedPin != null && selectedHost != null,
                            onClick = {
                                val host = selectedHost
                                val pin = normalizedPin
                                if (host != null && pin != null) {
                                    closePinDialog()
                                    controller.startPinPairing(host, pin)
                                }
                            },
                        ) { Text(stringResource(MR.strings.epigraph_core_pair)) }
                    }
                },
                dismissButton = {
                    TextButton(enabled = !busy, onClick = { closePinDialog() }) {
                        Text(stringResource(MR.strings.cancel))
                    }
                },
            )
        }

        if (showBlockedDialog && blockedMutations.isNotEmpty()) {
            fun retry(items: List<BlockedMutation>) {
                coroutineScope.launch {
                    val now = System.currentTimeMillis()
                    items.forEach { item ->
                        runCatching {
                            mutationCoordinator.retryBlocked(
                                item.sequence,
                                ClientMutationId(UUID.randomUUID().toString()),
                                now,
                            )
                        }
                    }
                    blockedRefresh += 1
                    runCatching { syncMonitor.syncNow() }
                }
            }
            AlertDialog(
                onDismissRequest = { showBlockedDialog = false },
                title = { Text(stringResource(MR.strings.epigraph_core_blocked_title)) },
                text = {
                    Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                        Text(
                            text = stringResource(MR.strings.epigraph_core_blocked_dialog_body),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        blockedMutations.forEach { item ->
                            Spacer(modifier = Modifier.padding(top = 12.dp))
                            Text(
                                text = "${stringResource(blockedKindLabel(item.entityType))} · ${item.entityType.substringAfter('.')}",
                                style = MaterialTheme.typography.bodyLarge,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Text(
                                text = "${item.errorCode} · ${relativeTimeSpanString(item.createdAtEpochMillis)}",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Row {
                                TextButton(onClick = { retry(listOf(item)) }) {
                                    Text(stringResource(MR.strings.epigraph_core_blocked_retry))
                                }
                                TextButton(
                                    onClick = {
                                        coroutineScope.launch {
                                            runCatching { mutationCoordinator.discardBlocked(item.sequence) }
                                            blockedRefresh += 1
                                        }
                                    },
                                ) {
                                    Text(
                                        stringResource(MR.strings.epigraph_core_blocked_discard),
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { retry(blockedMutations) }) {
                        Text(stringResource(MR.strings.epigraph_core_blocked_retry_all))
                    }
                },
                dismissButton = {
                    TextButton(onClick = { showBlockedDialog = false }) {
                        Text(stringResource(MR.strings.epigraph_core_blocked_close))
                    }
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
                                    .setOrientationLocked(false)
                                    // Also read light-on-dark codes, as older desktop builds draw.
                                    .addExtra(Intents.Scan.SCAN_TYPE, Intents.Scan.MIXED_SCAN),
                            )
                        },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_pin_pair),
                        subtitle = stringResource(MR.strings.epigraph_core_pin_pair_summary),
                        enabled = !busy,
                        onClick = {
                            pinText = ""
                            selectedHost = null
                            addressText = ""
                            showAddressField = false
                            showPinDialog = true
                            controller.discoverHosts()
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
                        onClick = { showDisconnectDialog = true },
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_setup_entry_title),
                        subtitle = run {
                            val counts = coreDependencySetupCounts(comicRepositories, extensionState.report, novelInventory)
                            when {
                                counts.hasPending -> stringResource(
                                    MR.strings.epigraph_core_setup_entry_summary,
                                    counts.repositoriesToAdd,
                                    counts.extensionsToInstall,
                                )
                                extensionState.report != null || novelInventory != null ->
                                    stringResource(MR.strings.epigraph_core_setup_entry_synced)
                                else -> stringResource(MR.strings.epigraph_core_extensions_no_inventory)
                            }
                        },
                        enabled = state is CorePairingUiState.Paired &&
                            (extensionState.report != null || novelInventory != null),
                        onClick = {
                            context.startActivity(
                                CoreDependencySetupActivity.intent(
                                    context,
                                    persistedSelection?.serverId,
                                    persistedSelection?.profileId,
                                ),
                            )
                        },
                    ),
                ),
            ),
            Preference.PreferenceGroup(
                title = stringResource(MR.strings.epigraph_core_sync_group),
                preferenceItems = listOfNotNull(
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_sync_status_title),
                        subtitle = syncStatus?.let { syncStatusText(it) }
                            ?: stringResource(MR.strings.epigraph_core_loading),
                    ),
                    Preference.PreferenceItem.TextPreference(
                        title = stringResource(MR.strings.epigraph_core_sync_now),
                        subtitle = stringResource(MR.strings.epigraph_core_sync_now_summary),
                        // A disabled item collapses out of the list, so it must not follow the sync
                        // status, or the list jumps on every status change.
                        enabled = state is CorePairingUiState.Paired,
                        onClick = { coroutineScope.launch { runCatching { syncMonitor.syncNow() } } },
                    ),
                    blockedMutations.takeIf { it.isNotEmpty() }?.let { blocked ->
                        Preference.PreferenceItem.TextPreference(
                            title = stringResource(MR.strings.epigraph_core_blocked_title),
                            subtitle = stringResource(MR.strings.epigraph_core_blocked_summary, blocked.size),
                            onClick = { showBlockedDialog = true },
                        )
                    },
                    novelsWithoutChapters.takeIf { it.isNotEmpty() }?.let { titles ->
                        Preference.PreferenceItem.TextPreference(
                            title = stringResource(MR.strings.epigraph_core_novels_without_chapters_title),
                            subtitle = stringResource(
                                MR.strings.epigraph_core_novels_without_chapters_summary,
                                titles.size,
                                titles.take(3).joinToString(", ") + if (titles.size > 3) ", …" else "",
                            ),
                        )
                    },
                ).toPersistentList(),
            ),
        )
    }

    private fun blockedKindLabel(entityType: String): StringResource = when (entityType.substringBefore('.')) {
        "comic" -> MR.strings.epigraph_core_blocked_kind_comic
        "novel" -> MR.strings.epigraph_core_blocked_kind_novel
        "book" -> MR.strings.epigraph_core_blocked_kind_book
        else -> MR.strings.epigraph_core_blocked_kind_other
    }

    /** Never reports synced while anything is unsettled; [CoreSyncStatus.Synced] has no counts. */
    @Composable
    private fun syncStatusText(status: CoreSyncStatus): String = when (status) {
        CoreSyncStatus.NotPaired -> stringResource(MR.strings.epigraph_core_sync_status_not_paired)
        is CoreSyncStatus.Syncing ->
            stringResource(MR.strings.epigraph_core_sync_status_syncing, status.counts.unsettled)
        is CoreSyncStatus.Queued ->
            stringResource(MR.strings.epigraph_core_sync_status_queued, status.counts.unsettled)
        is CoreSyncStatus.Retrying ->
            stringResource(MR.strings.epigraph_core_sync_status_retrying, status.counts.unsettled)
        is CoreSyncStatus.NeedsPairing ->
            stringResource(MR.strings.epigraph_core_sync_status_needs_pairing, status.counts.unsettled)
        is CoreSyncStatus.NeedsUserAction -> when (status.reason) {
            CoreUserActionReason.REMOTE_PROJECTION_BLOCKED -> stringResource(
                MR.strings.epigraph_core_sync_status_projection_blocked,
                status.counts.unsettled,
            )
            CoreUserActionReason.AUTHORIZATION_REQUIRED ->
                stringResource(MR.strings.epigraph_core_sync_status_authorization)
            CoreUserActionReason.CORE_INCOMPATIBLE ->
                stringResource(MR.strings.epigraph_core_sync_status_incompatible)
            else -> stringResource(MR.strings.epigraph_core_sync_status_rejected, status.counts.unsettled)
        }
        is CoreSyncStatus.Blocked -> stringResource(
            MR.strings.epigraph_core_sync_status_blocked,
            status.counts.blocked,
            status.counts.unsettled,
        )
        is CoreSyncStatus.Pending ->
            stringResource(MR.strings.epigraph_core_sync_status_pending, status.counts.unsettled)
        is CoreSyncStatus.Synced -> stringResource(
            MR.strings.epigraph_core_sync_status_synced,
            relativeTimeSpanString(status.lastSyncAtMs),
        )
        CoreSyncStatus.Idle -> stringResource(MR.strings.epigraph_core_sync_status_idle)
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
            PairingStage.WAITING_FOR_DESKTOP -> state.verificationCode?.let { code ->
                stringResource(MR.strings.epigraph_core_pairing_waiting_code, code)
            } ?: stringResource(MR.strings.epigraph_core_pairing_waiting)
            PairingStage.EXCHANGING_TOKEN -> stringResource(MR.strings.epigraph_core_pairing_exchanging)
            PairingStage.SAVING_CREDENTIAL -> stringResource(MR.strings.epigraph_core_pairing_saving)
        }
        is CorePairingUiState.CredentialFailed ->
            stringResource(MR.strings.epigraph_core_error_credentials)
        is CorePairingUiState.PairingFailed -> pairingErrorText(state.error, state.bundleFailure)
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
        PairingErrorCode.PIN_NOT_FOUND -> stringResource(MR.strings.epigraph_core_error_pin_not_found)
        PairingErrorCode.PIN_LOCKED -> stringResource(MR.strings.epigraph_core_error_pin_locked)
        PairingErrorCode.PIN_INVALID -> stringResource(MR.strings.epigraph_core_error_pin_invalid)
        PairingErrorCode.HOST_NOT_FOUND -> stringResource(MR.strings.epigraph_core_error_host_not_found)
    }
}
