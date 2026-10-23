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
import epigraph.sync.core.setup.inventoryDetail
import epigraph.sync.core.setup.rememberLocalNovelInventoryPreview
import epigraph.sync.core.extensions.ExtensionReconciliationCoordinator
import epigraph.sync.core.novels.LnReaderDependencyActionCoordinator
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.pairing.CoreHostDiscoveryState
import epigraph.sync.core.pairing.CorePairingUiState
import epigraph.sync.core.pairing.DiscoveredCoreHost
import epigraph.sync.core.pairing.PairingBundleFailure
import epigraph.sync.core.pairing.PairingErrorCode
import epigraph.sync.core.pairing.PairingPin
import epigraph.sync.core.pairing.PairingScanActivity
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
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoStories
import androidx.compose.material.icons.outlined.ContentPaste
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Dialpad
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material.icons.outlined.SyncDisabled
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material.icons.outlined.Sync
import androidx.compose.material.icons.outlined.SyncProblem
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import com.google.zxing.client.android.Intents
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.pluralStringResource
import dev.icerock.moko.resources.compose.stringResource
import kotlinx.collections.immutable.toPersistentList
import kotlinx.coroutines.launch
import org.koin.core.context.GlobalContext
import yokai.i18n.MR
import yokai.presentation.component.preference.Preference
import yokai.presentation.component.preference.widget.PrefsHorizontalPadding
import yokai.presentation.component.preference.widget.TextPreferenceWidget
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
        val syncPaused by controller.syncPaused.collectAsState()
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
        // Right after pairing the desktop's novel list has not arrived yet; it comes with a sync, and
        // the setup screen may add repositories, so read it again after each sync and on return.
        val lastSyncAtMs = (syncStatus as? CoreSyncStatus.Synced)?.lastSyncAtMs
        var novelRefresh by remember { mutableStateOf(0) }
        LifecycleEventEffect(Lifecycle.Event.ON_RESUME) { novelRefresh++ }
        LaunchedEffect(persistedSelection?.serverId, persistedSelection?.profileId, lastSyncAtMs, novelRefresh) {
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
        // A pairing in progress; the pairing options step aside until it ends.
        val busy = state is CorePairingUiState.Pairing ||
            state is CorePairingUiState.Selecting

        if (showSelectionEditor) {
            val selectedDomains = buildSet {
                if (syncComics) add(SyncDomain.COMICS)
                if (syncNovels) add(SyncDomain.NOVELS)
                if (syncBooks) add(SyncDomain.BOOKS)
            }
            val localNovels = rememberLocalNovelInventoryPreview()
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
                            detail = inventoryDetail(localNovels.repositories),
                        )
                        InventoryChoice(
                            title = stringResource(MR.strings.epigraph_core_sync_novel_plugins),
                            checked = compareNovelPlugins,
                            enabled = syncNovels,
                            onCheckedChange = { compareNovelPlugins = it },
                            detail = inventoryDetail(localNovels.plugins),
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
                                // Separators from a pasted "123 456" are kept, but never more than six digits.
                                var digits = 0
                                pinText = value.filter { it.isDigit() || it == ' ' || it == '-' }
                                    .takeWhile { !it.isDigit() || ++digits <= PairingPin.LENGTH }
                                    .take(12)
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

        val paired = state as? CorePairingUiState.Paired
        val openSetup = {
            context.startActivity(
                CoreDependencySetupActivity.intent(
                    context,
                    persistedSelection?.serverId,
                    persistedSelection?.profileId,
                ),
            )
        }

        val statusCard = Preference.PreferenceItem.CustomPreference(
            title = stringResource(MR.strings.epigraph_core_status),
        ) {
            CoreStatusCard(
                state = state,
                syncStatus = syncStatus,
                syncPaused = syncPaused,
                onSyncNow = { coroutineScope.launch { runCatching { syncMonitor.syncNow() } } },
                onReconnect = { controller.setSyncPaused(false) },
            )
        }

        val pairingItems = listOf(
            Preference.PreferenceItem.TextPreference(
                title = stringResource(MR.strings.epigraph_core_scan_qr),
                subtitle = stringResource(MR.strings.epigraph_core_scan_qr_summary),
                icon = Icons.Outlined.QrCodeScanner,
                onClick = {
                    scanner.launch(
                        ScanOptions()
                            .setCaptureActivity(PairingScanActivity::class.java)
                            .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                            .setPrompt(scannerPrompt)
                            .setBeepEnabled(false)
                            .setBarcodeImageEnabled(false)
                            .setOrientationLocked(false)
                            // The pairing link makes a dense code; a slower, thorough decode
                            // reads it off a monitor where the default pass gives up.
                            .addExtra("TRY_HARDER", true)
                            // Also read light-on-dark codes, as older desktop builds draw.
                            .addExtra(Intents.Scan.SCAN_TYPE, Intents.Scan.MIXED_SCAN),
                    )
                },
            ),
            Preference.PreferenceItem.TextPreference(
                title = stringResource(MR.strings.epigraph_core_pin_pair),
                subtitle = stringResource(MR.strings.epigraph_core_pin_pair_summary),
                icon = Icons.Outlined.Dialpad,
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
                icon = Icons.Outlined.ContentPaste,
                onClick = { showPasteDialog = true },
            ),
        )

        return buildList<Preference> {
            add(statusCard)
            if (paired != null) {
                add(
                    Preference.PreferenceGroup(
                        title = stringResource(MR.strings.epigraph_core_sync_group),
                        preferenceItems = listOfNotNull(
                            Preference.PreferenceItem.TextPreference(
                                title = stringResource(MR.strings.epigraph_core_sync_selection_title),
                                subtitle = syncSelectionSummary(paired, persistedSelection),
                                icon = Icons.Outlined.Tune,
                                enabled = persistedSelection != null,
                                onClick = { showSelectionEditor = true },
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
                                icon = Icons.Outlined.Extension,
                                // Shown as soon as paired; the desktop lists load later and only change the summary.
                                onClick = openSetup,
                            ),
                            blockedMutations.takeIf { it.isNotEmpty() }?.let { blocked ->
                                Preference.PreferenceItem.TextPreference(
                                    title = stringResource(MR.strings.epigraph_core_blocked_title),
                                    subtitle = stringResource(MR.strings.epigraph_core_blocked_summary, blocked.size),
                                    icon = Icons.Outlined.SyncProblem,
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
                                    icon = Icons.Outlined.AutoStories,
                                    // The summary points to the dependency setup, so the item opens it.
                                    onClick = openSetup,
                                )
                            },
                        ).toPersistentList(),
                    ),
                )
            }
            // Pairing options wait until the saved connection is read, so they never move under the
            // finger, and step aside while a pairing runs.
            if (state !is CorePairingUiState.Loading && !busy) {
                add(
                    Preference.PreferenceGroup(
                        title = stringResource(
                            if (paired != null) MR.strings.epigraph_core_connection_group else MR.strings.epigraph_core_pair_group,
                        ),
                        preferenceItems = if (paired == null) {
                            pairingItems.toPersistentList()
                        } else {
                            (
                                pairingItems + Preference.PreferenceItem.TextPreference(
                                    title = stringResource(
                                        if (syncPaused) MR.strings.epigraph_core_sync_resume else MR.strings.epigraph_core_sync_pause,
                                    ),
                                    subtitle = stringResource(
                                        if (syncPaused) {
                                            MR.strings.epigraph_core_sync_resume_summary
                                        } else {
                                            MR.strings.epigraph_core_sync_pause_summary
                                        },
                                    ),
                                    icon = if (syncPaused) Icons.Outlined.Sync else Icons.Outlined.SyncDisabled,
                                    // Reversible and keeps the pairing, so it needs no confirmation.
                                    onClick = { controller.setSyncPaused(!syncPaused) },
                                ) + Preference.PreferenceItem.CustomPreference(
                                    title = stringResource(MR.strings.epigraph_core_disconnect),
                                ) { item ->
                                    TextPreferenceWidget(
                                        title = item.title,
                                        subtitle = stringResource(MR.strings.epigraph_core_disconnect_summary),
                                        icon = Icons.Outlined.LinkOff,
                                        iconTint = MaterialTheme.colorScheme.error,
                                        onPreferenceClick = { showDisconnectDialog = true },
                                    )
                                }
                                ).toPersistentList()
                        },
                    ),
                )
            }
        }
    }

    private enum class CoreTone { GOOD, NEUTRAL, PROBLEM }

    /** Where the connection stands and how the last sync went, with the one action that matters most. */
    @Composable
    private fun CoreStatusCard(
        state: CorePairingUiState,
        syncStatus: CoreSyncStatus?,
        syncPaused: Boolean,
        onSyncNow: () -> Unit,
        onReconnect: () -> Unit,
    ) {
        val paired = state as? CorePairingUiState.Paired
        val syncTone = when {
            syncPaused -> CoreTone.NEUTRAL
            else -> when (syncStatus) {
                is CoreSyncStatus.Synced, CoreSyncStatus.Idle -> CoreTone.GOOD
                is CoreSyncStatus.NeedsPairing,
                is CoreSyncStatus.NeedsUserAction,
                is CoreSyncStatus.Blocked,
                -> CoreTone.PROBLEM
                else -> CoreTone.NEUTRAL
            }
        }
        val tone = when {
            state is CorePairingUiState.CredentialFailed || state is CorePairingUiState.PairingFailed -> CoreTone.PROBLEM
            paired == null -> CoreTone.NEUTRAL
            syncTone == CoreTone.PROBLEM -> CoreTone.PROBLEM
            else -> CoreTone.GOOD
        }
        val colors = MaterialTheme.colorScheme
        val (badgeColor, badgeContentColor) = when (tone) {
            CoreTone.GOOD -> colors.primaryContainer to colors.onPrimaryContainer
            CoreTone.PROBLEM -> colors.errorContainer to colors.onErrorContainer
            CoreTone.NEUTRAL -> colors.surfaceVariant to colors.onSurfaceVariant
        }
        val headline = when {
            paired == null -> statusText(state)
            paired.verifiedInThisProcess -> stringResource(MR.strings.epigraph_core_connected)
            else -> stringResource(MR.strings.epigraph_core_connection_waiting)
        }
        val detail = when {
            paired != null -> stringResource(MR.strings.epigraph_core_profile_origin, paired.profileId, paired.origin)
            state is CorePairingUiState.Unpaired -> stringResource(MR.strings.epigraph_core_summary)
            else -> null
        }

        Surface(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = PrefsHorizontalPadding, vertical = 8.dp),
            shape = MaterialTheme.shapes.large,
            color = colors.surfaceContainerHigh,
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier
                            .size(48.dp)
                            .clip(CircleShape)
                            .background(badgeColor),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = if (tone == CoreTone.PROBLEM) Icons.Outlined.ErrorOutline else Icons.Outlined.Devices,
                            contentDescription = null,
                            tint = badgeContentColor,
                        )
                    }
                    Spacer(modifier = Modifier.width(16.dp))
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = headline,
                            style = MaterialTheme.typography.titleMedium,
                            fontWeight = FontWeight.SemiBold,
                            color = if (tone == CoreTone.PROBLEM) colors.error else colors.onSurface,
                        )
                        if (detail != null) {
                            Text(
                                text = detail,
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.onSurfaceVariant,
                            )
                        }
                    }
                }
                if (state is CorePairingUiState.Pairing) {
                    LinearProgressIndicator(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 16.dp),
                    )
                }
                if (paired != null) {
                    HorizontalDivider(modifier = Modifier.padding(vertical = 12.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Box(modifier = Modifier.size(12.dp), contentAlignment = Alignment.Center) {
                            if (!syncPaused && syncStatus is CoreSyncStatus.Syncing) {
                                CircularProgressIndicator(modifier = Modifier.size(12.dp), strokeWidth = 2.dp)
                            } else {
                                Box(
                                    modifier = Modifier
                                        .size(8.dp)
                                        .clip(CircleShape)
                                        .background(
                                            when (syncTone) {
                                                CoreTone.GOOD -> colors.primary
                                                CoreTone.PROBLEM -> colors.error
                                                CoreTone.NEUTRAL -> colors.outline
                                            },
                                        ),
                                )
                            }
                        }
                        Spacer(modifier = Modifier.width(10.dp))
                        Text(
                            text = when {
                                syncPaused -> stringResource(MR.strings.epigraph_core_sync_status_paused)
                                else -> syncStatus?.let { syncStatusText(it) }
                                    ?: stringResource(MR.strings.epigraph_core_loading)
                            },
                            style = MaterialTheme.typography.bodyMedium,
                            color = if (syncTone == CoreTone.PROBLEM) colors.error else colors.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    FilledTonalButton(
                        onClick = if (syncPaused) onReconnect else onSyncNow,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = 12.dp),
                    ) {
                        Icon(
                            imageVector = Icons.Outlined.Sync,
                            contentDescription = null,
                            modifier = Modifier.size(18.dp),
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            stringResource(
                                if (syncPaused) MR.strings.epigraph_core_sync_resume else MR.strings.epigraph_core_sync_now,
                            ),
                        )
                    }
                }
            }
        }
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
        if (requiredScopes.any { it !in paired.scopes }) {
            return stringResource(MR.strings.epigraph_core_sync_authorization_required)
        }
        // What this device syncs, in the order the editor lists it.
        val domains = listOf(
            SyncDomain.COMICS to MR.strings.epigraph_core_sync_comics,
            SyncDomain.NOVELS to MR.strings.epigraph_core_sync_novels,
            SyncDomain.BOOKS to MR.strings.epigraph_core_sync_books,
        ).filter { (domain, _) -> domain in selected.enabledDomains }
            .map { (_, label) -> stringResource(label) }
        return domains.joinToString(" · ").ifEmpty { stringResource(MR.strings.epigraph_core_sync_selection_summary) }
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
