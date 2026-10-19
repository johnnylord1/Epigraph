package epigraph.sync.core.setup

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.icerock.moko.resources.compose.stringResource
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.repo.NovelRepoRepository
import epigraph.sync.core.novels.CoreNovelDependencyIds
import kotlinx.coroutines.CancellationException
import org.koin.core.context.GlobalContext
import yokai.i18n.MR

// "What to sync" choices, shared by the pairing setup and the Core screen's selection editor.

@Composable
internal fun SyncDomainChoice(
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
internal fun InventoryChoice(
    title: String,
    checked: Boolean,
    enabled: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    detail: String? = null,
) {
    val color = if (enabled) {
        MaterialTheme.colorScheme.onSurfaceVariant
    } else {
        MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
    }
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
        Column {
            Text(title, style = MaterialTheme.typography.bodySmall, color = color)
            detail?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = color) }
        }
    }
}

/** This device's LNReader repositories and plugins that pairing would share, by name. */
internal data class LocalNovelInventoryPreview(
    val repositories: List<String>,
    val plugins: List<String>,
)

@Composable
internal fun rememberLocalNovelInventoryPreview(): LocalNovelInventoryPreview {
    val pluginManager = remember { GlobalContext.get().get<NovelPluginManager>() }
    val repositoryStore = remember { GlobalContext.get().get<NovelRepoRepository>() }
    val installed by pluginManager.installedPluginsFlow.collectAsState()
    val repositories by remember { repositoryStore.subscribeAll() }.collectAsState(initial = emptyList())
    LaunchedEffect(pluginManager) {
        try {
            pluginManager.ensureInstalledPluginsLoaded()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            // The preview stays empty; pairing does not depend on it.
        }
    }
    return LocalNovelInventoryPreview(
        // Private repositories stay on this device, as the publisher decides.
        repositories = repositories
            .filter { CoreNovelDependencyIds.canonicalRepositoryUrl(it.baseUrl) != null }
            .map { it.displayName }
            .distinct()
            .sorted(),
        plugins = installed.map { it.name }.distinct().sorted(),
    )
}

@Composable
internal fun inventoryDetail(names: List<String>): String =
    if (names.isEmpty()) {
        stringResource(MR.strings.epigraph_core_sync_nothing_on_this_device)
    } else {
        val shown = names.take(PREVIEW_NAMES).joinToString(", ")
        val more = names.size - PREVIEW_NAMES
        stringResource(MR.strings.epigraph_core_sync_from_this_device, if (more > 0) "$shown +$more" else shown)
    }

private const val PREVIEW_NAMES = 5

@Composable
internal fun VerificationCodeHeader(code: String, desktopName: String?) {
    Column(modifier = Modifier.padding(bottom = 12.dp)) {
        desktopName?.let { name ->
            Text(
                stringResource(MR.strings.epigraph_core_selection_desktop, name),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Text(
            stringResource(MR.strings.epigraph_core_verification_code, code),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
        )
        Text(
            stringResource(MR.strings.epigraph_core_verification_code_hint),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
