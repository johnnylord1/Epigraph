package epigraph.sync.core.novels

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
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

class LnReaderDependencyActivity : AppCompatActivity() {
    private val preferences: PreferencesHelper by injectLazy()
    private val coordinator: LnReaderDependencyActionCoordinator by injectLazy()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val serverId = intent.getStringExtra(EXTRA_SERVER_ID)?.takeIf(String::isNotBlank)
        val profileId = intent.getStringExtra(EXTRA_PROFILE_ID)?.takeIf(String::isNotBlank)
        if (serverId == null || profileId == null) {
            finish()
            return
        }
        setThemeByPref(preferences)
        setContent {
            YokaiTheme {
                LnReaderDependencyContent(
                    serverId = serverId,
                    profileId = profileId,
                    coordinator = coordinator,
                    onClose = ::finish,
                )
            }
        }
    }

    companion object {
        private const val EXTRA_SERVER_ID = "epigraph.lnreader_dependencies.server_id"
        private const val EXTRA_PROFILE_ID = "epigraph.lnreader_dependencies.profile_id"

        fun intent(context: Context, serverId: String, profileId: String): Intent =
            Intent(context, LnReaderDependencyActivity::class.java)
                .putExtra(EXTRA_SERVER_ID, serverId)
                .putExtra(EXTRA_PROFILE_ID, profileId)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
}

private enum class DependencyFeedback { COMPLETED, APPROVAL_REQUIRED, FAILED }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LnReaderDependencyContent(
    serverId: String,
    profileId: String,
    coordinator: LnReaderDependencyActionCoordinator,
    onClose: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    var inventory by remember { mutableStateOf<LnReaderDependencyInventory?>(null) }
    var loading by remember { mutableStateOf(true) }
    var busyKey by remember { mutableStateOf<String?>(null) }
    var feedback by remember { mutableStateOf<DependencyFeedback?>(null) }

    suspend fun refresh() {
        inventory = coordinator.inventory(serverId, profileId)
        loading = false
    }

    LaunchedEffect(serverId, profileId) { refresh() }
    BackHandler(enabled = busyKey == null, onBack = onClose)

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(MR.strings.epigraph_core_novel_dependencies_title)) },
                actions = {
                    IconButton(onClick = onClose, enabled = busyKey == null) {
                        Icon(Icons.Outlined.Close, contentDescription = stringResource(MR.strings.action_close))
                    }
                },
            )
        },
    ) { padding ->
        if (loading) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) { CircularProgressIndicator() }
            return@Scaffold
        }
        val current = inventory
        if (current == null) {
            Column(
                modifier = Modifier.fillMaxSize().padding(padding),
                verticalArrangement = Arrangement.Center,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) { Text(stringResource(MR.strings.epigraph_core_novel_dependencies_no_inventory)) }
            return@Scaffold
        }
        LazyColumn(modifier = Modifier.fillMaxSize().padding(padding)) {
            item {
                Column(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Text(
                        stringResource(
                            MR.strings.epigraph_core_novel_dependencies_summary,
                            current.repositories.size,
                            current.plugins.size,
                        ),
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    feedback?.let { Text(feedbackText(it), style = MaterialTheme.typography.bodySmall) }
                }
            }
            if (current.repositories.isNotEmpty()) {
                item { SectionTitle(stringResource(MR.strings.epigraph_core_novel_repositories)) }
            }
            items(current.repositories, key = { it.requirement.repositoryId }) { item ->
                ListItem(
                    headlineContent = { Text(item.requirement.displayName) },
                    supportingContent = {
                        Text(
                            item.requirement.canonicalUrl,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    trailingContent = if (item.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED) {
                        {
                            TextButton(
                                enabled = busyKey == null,
                                onClick = {
                                    busyKey = "repository:${item.requirement.repositoryId}"
                                    feedback = null
                                    scope.launch {
                                        feedback = when (
                                            coordinator.approveRepository(
                                                serverId,
                                                profileId,
                                                item.requirement.repositoryId,
                                            )
                                        ) {
                                            is LnReaderRepositoryApprovalResult.Approved,
                                            is LnReaderRepositoryApprovalResult.AlreadyApproved,
                                            -> DependencyFeedback.COMPLETED
                                            else -> DependencyFeedback.FAILED
                                        }
                                        refresh()
                                        busyKey = null
                                    }
                                },
                            ) { Text(stringResource(MR.strings.epigraph_core_novel_repository_approve)) }
                        }
                    } else null,
                )
                HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
            }
            if (current.plugins.isNotEmpty()) {
                item { SectionTitle(stringResource(MR.strings.epigraph_core_novel_plugins)) }
            }
            items(current.plugins, key = { it.requirement.pluginId }) { item ->
                val canInstall = item.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                    item.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                    item.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
                ListItem(
                    headlineContent = { Text(item.requirement.pluginId) },
                    supportingContent = {
                        Text(
                            "${item.requirement.sourceId} · ${item.requirement.version} · ${pluginStatusText(item.status)}",
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    trailingContent = if (canInstall) {
                        {
                            Button(
                                shape = MaterialTheme.shapes.small,
                                enabled = busyKey == null,
                                onClick = {
                                    busyKey = "plugin:${item.requirement.pluginId}"
                                    feedback = null
                                    scope.launch {
                                        feedback = when (
                                            coordinator.installPlugin(serverId, profileId, item.requirement.pluginId)
                                        ) {
                                            LnReaderPluginInstallResult.Installed,
                                            LnReaderPluginInstallResult.AlreadyInstalled,
                                            -> DependencyFeedback.COMPLETED
                                            LnReaderPluginInstallResult.RepositoryApprovalRequired ->
                                                DependencyFeedback.APPROVAL_REQUIRED
                                            else -> DependencyFeedback.FAILED
                                        }
                                        refresh()
                                        busyKey = null
                                    }
                                },
                            ) { Text(stringResource(MR.strings.epigraph_core_novel_plugin_install)) }
                        }
                    } else null,
                )
                HorizontalDivider(modifier = Modifier.padding(horizontal = 20.dp))
            }
        }
    }
}

@Composable
private fun SectionTitle(title: String) {
    Text(
        title,
        style = MaterialTheme.typography.titleSmall,
        fontWeight = FontWeight.SemiBold,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 10.dp),
    )
}

@Composable
private fun feedbackText(feedback: DependencyFeedback): String = when (feedback) {
    DependencyFeedback.COMPLETED -> stringResource(MR.strings.epigraph_core_novel_dependency_completed)
    DependencyFeedback.APPROVAL_REQUIRED ->
        stringResource(MR.strings.epigraph_core_novel_dependency_approval_required)
    DependencyFeedback.FAILED -> stringResource(MR.strings.epigraph_core_novel_dependency_failed)
}

@Composable
private fun pluginStatusText(status: LnReaderPluginParityStatus): String = when (status) {
    LnReaderPluginParityStatus.INSTALLED -> stringResource(MR.strings.epigraph_core_extension_installed)
    LnReaderPluginParityStatus.UPDATE_AVAILABLE ->
        stringResource(MR.strings.epigraph_core_extension_update_available)
    LnReaderPluginParityStatus.MISSING_AVAILABLE -> stringResource(MR.strings.epigraph_core_extension_missing)
    LnReaderPluginParityStatus.MISSING_UNAVAILABLE ->
        stringResource(MR.strings.epigraph_core_extension_unavailable)
    LnReaderPluginParityStatus.IDENTITY_MISMATCH -> stringResource(MR.strings.epigraph_core_extension_mismatch)
    LnReaderPluginParityStatus.UNTRUSTED_OR_BLOCKED ->
        stringResource(MR.strings.epigraph_core_extension_blocked)
}
