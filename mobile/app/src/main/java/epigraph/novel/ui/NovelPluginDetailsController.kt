package epigraph.novel.ui

import android.os.Bundle
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import dev.icerock.moko.resources.compose.stringResource
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPlugin
import eu.kanade.tachiyomi.ui.base.controller.BaseComposeController
import eu.kanade.tachiyomi.util.compose.LocalBackPress
import eu.kanade.tachiyomi.util.compose.currentOrThrow
import eu.kanade.tachiyomi.util.system.LocaleHelper
import eu.kanade.tachiyomi.util.system.openInBrowser
import eu.kanade.tachiyomi.util.system.withIOContext
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import yokai.i18n.MR
import yokai.presentation.AppBarType
import yokai.presentation.component.LabeledCheckbox
import yokai.presentation.component.preference.widget.InfoWidget
import yokai.presentation.component.preference.widget.PreferenceGroupHeader
import yokai.presentation.settings.SettingsScaffold
import yokai.util.koin.get
import androidx.compose.ui.res.stringResource as androidStringResource
import android.R as AR

/**
 * Details of an installed novel plugin, the counterpart of the comic extension details screen:
 * icon, version, language, website and uninstall, then the plugin's own options
 * (LNReader `pluginSettings`), stored where the plugin's `storage.get` reads them.
 */
class NovelPluginDetailsController(bundle: Bundle? = null) : BaseComposeController(bundle) {

    constructor(pluginId: String) : this(
        Bundle().apply {
            putString(PLUGIN_ID_KEY, pluginId)
        },
    )

    @Composable
    override fun ScreenContent() {
        NovelPluginDetailsScreen(pluginId = args.getString(PLUGIN_ID_KEY).orEmpty())
    }

    private companion object {
        const val PLUGIN_ID_KEY = "novel_plugin_id"
    }
}

/** One entry of LNReader `pluginSettings`; a missing type is a text field, as in LNReader. */
private data class PluginSetting(
    val key: String,
    val label: String,
    val type: Type,
    val default: JsonElement,
    val options: List<Pair<JsonElement, String>>,
) {
    enum class Type { Switch, Select, CheckboxGroup, Text }
}

private fun parsePluginSettings(raw: JsonObject?): List<PluginSetting> =
    raw.orEmpty().mapNotNull { (key, element) ->
        val setting = element as? JsonObject ?: return@mapNotNull null
        val options = (setting["options"] as? JsonArray).orEmpty().mapNotNull { option ->
            val entry = option as? JsonObject ?: return@mapNotNull null
            val value = entry["value"] ?: return@mapNotNull null
            value to ((entry["label"] as? JsonPrimitive)?.contentOrNull ?: value.toString())
        }
        PluginSetting(
            key = key,
            label = (setting["label"] as? JsonPrimitive)?.contentOrNull ?: key,
            type = when ((setting["type"] as? JsonPrimitive)?.contentOrNull) {
                "Switch" -> PluginSetting.Type.Switch
                "Select" -> PluginSetting.Type.Select
                "CheckboxGroup" -> PluginSetting.Type.CheckboxGroup
                else -> PluginSetting.Type.Text
            },
            default = setting["value"] ?: JsonNull,
            options = options,
        )
    }

@Composable
private fun NovelPluginDetailsScreen(pluginId: String) {
    val context = LocalContext.current
    val onBackPress = LocalBackPress.currentOrThrow
    val manager = remember { get<NovelPluginManager>() }
    val scope = rememberCoroutineScope()
    val installed by manager.installedPluginsFlow.collectAsState()
    val plugin = installed.firstOrNull { it.id == pluginId }
    var settings by remember { mutableStateOf<List<PluginSetting>?>(null) }
    val values = remember { mutableStateMapOf<String, JsonElement>() }
    var confirmUninstall by remember { mutableStateOf(false) }

    LaunchedEffect(pluginId) {
        manager.ensureInstalledPluginsLoaded()
        val loaded = parsePluginSettings(manager.loadPluginSettings(pluginId))
        val stored = withIOContext {
            loaded.mapNotNull { setting ->
                manager.readPluginSetting(pluginId, setting.key)
                    ?.takeIf { it != JsonNull }
                    ?.let { setting.key to it }
            }
        }
        values.putAll(stored)
        settings = loaded
    }

    val onSettingChange: (String, JsonElement) -> Unit = { key, value ->
        values[key] = value
        scope.launch { withIOContext { manager.writePluginSetting(pluginId, key, value) } }
    }

    SettingsScaffold(
        title = plugin?.name.orEmpty(),
        appBarType = AppBarType.SMALL,
    ) { contentPadding ->
        LazyColumn(contentPadding = contentPadding) {
            if (plugin != null) {
                item(key = "header") {
                    PluginHeader(
                        plugin = plugin,
                        onOpenWebsite = { context.openInBrowser(plugin.siteUrl) },
                        onUninstall = { confirmUninstall = true },
                    )
                }
            }
            item(key = "settings_header") {
                PreferenceGroupHeader(title = stringResource(MR.strings.settings))
            }
            val loaded = settings
            if (loaded != null && loaded.isEmpty()) {
                item(key = "no_settings") {
                    InfoWidget(text = stringResource(MR.strings.novel_plugin_no_settings))
                }
            } else if (loaded != null) {
                items(loaded, key = { it.key }) { setting ->
                    PluginSettingRow(
                        setting = setting,
                        value = values[setting.key] ?: setting.default,
                        onChange = { onSettingChange(setting.key, it) },
                    )
                }
            }
        }
    }

    if (confirmUninstall && plugin != null) {
        AlertDialog(
            onDismissRequest = { confirmUninstall = false },
            title = { Text(text = plugin.name) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmUninstall = false
                        scope.launch {
                            withIOContext { manager.uninstallPlugin(pluginId) }
                            onBackPress()
                        }
                    },
                ) {
                    Text(text = stringResource(MR.strings.remove))
                }
            },
            dismissButton = {
                TextButton(onClick = { confirmUninstall = false }) {
                    Text(text = androidStringResource(AR.string.cancel))
                }
            },
        )
    }
}

@Composable
private fun PluginHeader(
    plugin: NovelPlugin.Installed,
    onOpenWebsite: () -> Unit,
    onUninstall: () -> Unit,
) {
    val context = LocalContext.current
    Column(modifier = Modifier.fillMaxWidth().padding(16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            AsyncImage(
                model = plugin.iconUrl,
                contentDescription = null,
                modifier = Modifier
                    .size(56.dp)
                    .clip(RoundedCornerShape(8.dp)),
            )
            Column(modifier = Modifier.padding(start = 16.dp)) {
                Text(text = plugin.name, style = MaterialTheme.typography.bodyLarge)
                Text(
                    text = stringResource(MR.strings.version_, plugin.version),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Text(
                    text = stringResource(
                        MR.strings.language_,
                        LocaleHelper.getSourceDisplayName(plugin.lang, context),
                    ),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        if (plugin.siteUrl.isNotBlank()) {
            Text(
                text = plugin.siteUrl,
                modifier = Modifier.padding(top = 6.dp),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(top = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Button(
                onClick = onOpenWebsite,
                enabled = plugin.siteUrl.isNotBlank(),
                modifier = Modifier.weight(1f),
            ) {
                Text(text = stringResource(MR.strings.website))
            }
            OutlinedButton(onClick = onUninstall, modifier = Modifier.weight(1f)) {
                Text(text = stringResource(MR.strings.uninstall))
            }
        }
    }
}

/**
 * Plugin labels are often whole instructions ("paste the link from that email here..."), so rows
 * and dialogs show them in full instead of the two-line titles of the app's own settings.
 */
@Composable
private fun PluginSettingRow(
    setting: PluginSetting,
    value: JsonElement,
    onChange: (JsonElement) -> Unit,
) {
    var showDialog by remember { mutableStateOf(false) }
    when (setting.type) {
        PluginSetting.Type.Switch -> {
            val checked = (value as? JsonPrimitive)?.booleanOrNull ?: false
            PluginSettingItem(label = setting.label, onClick = { onChange(JsonPrimitive(!checked)) }) {
                Switch(checked = checked, onCheckedChange = null)
            }
        }
        PluginSetting.Type.Select -> {
            PluginSettingItem(
                label = setting.label,
                subtitle = setting.options.firstOrNull { it.first == value }?.second,
                onClick = { showDialog = true },
            )
            if (showDialog) {
                PluginSettingDialog(
                    label = setting.label,
                    onDismiss = { showDialog = false },
                    confirmButton = {
                        TextButton(onClick = { showDialog = false }) {
                            Text(text = androidStringResource(AR.string.cancel))
                        }
                    },
                ) {
                    setting.options.forEach { (optionValue, optionLabel) ->
                        val isSelected = optionValue == value
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .clip(MaterialTheme.shapes.small)
                                .selectable(
                                    selected = isSelected,
                                    onClick = {
                                        showDialog = false
                                        if (!isSelected) onChange(optionValue)
                                    },
                                )
                                .fillMaxWidth()
                                .minimumInteractiveComponentSize(),
                        ) {
                            RadioButton(selected = isSelected, onClick = null)
                            Text(
                                text = optionLabel,
                                style = MaterialTheme.typography.bodyLarge,
                                modifier = Modifier.padding(start = 24.dp),
                            )
                        }
                    }
                }
            }
        }
        PluginSetting.Type.CheckboxGroup -> {
            val selected = (value as? JsonArray).orEmpty()
            PluginSettingItem(
                label = setting.label,
                subtitle = setting.options
                    .filter { it.first in selected }
                    .joinToString { it.second },
                onClick = { showDialog = true },
            )
            if (showDialog) {
                var checked by remember { mutableStateOf(selected.toSet()) }
                PluginSettingDialog(
                    label = setting.label,
                    onDismiss = { showDialog = false },
                    confirmButton = {
                        TextButton(
                            onClick = {
                                showDialog = false
                                onChange(JsonArray(setting.options.map { it.first }.filter { it in checked }))
                            },
                        ) {
                            Text(text = androidStringResource(AR.string.ok))
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showDialog = false }) {
                            Text(text = androidStringResource(AR.string.cancel))
                        }
                    },
                ) {
                    setting.options.forEach { (optionValue, optionLabel) ->
                        LabeledCheckbox(
                            label = optionLabel,
                            checked = optionValue in checked,
                            onCheckedChange = { isChecked ->
                                checked = if (isChecked) checked + optionValue else checked - optionValue
                            },
                        )
                    }
                }
            }
        }
        PluginSetting.Type.Text -> {
            val current = (value as? JsonPrimitive)?.contentOrNull.orEmpty()
            PluginSettingItem(label = setting.label, subtitle = current, onClick = { showDialog = true })
            if (showDialog) {
                // Empty is a valid answer: plugins ask for fields to be cleared (e.g. a used sign-in link).
                var text by rememberSaveable { mutableStateOf(current) }
                PluginSettingDialog(
                    label = setting.label,
                    onDismiss = { showDialog = false },
                    confirmButton = {
                        TextButton(
                            enabled = text != current,
                            onClick = {
                                showDialog = false
                                onChange(JsonPrimitive(text))
                            },
                        ) {
                            Text(text = androidStringResource(AR.string.ok))
                        }
                    },
                    dismissButton = {
                        TextButton(onClick = { showDialog = false }) {
                            Text(text = androidStringResource(AR.string.cancel))
                        }
                    },
                ) {
                    OutlinedTextField(
                        value = text,
                        onValueChange = { text = it },
                        trailingIcon = {
                            if (text.isNotEmpty()) {
                                IconButton(onClick = { text = "" }) {
                                    Icon(imageVector = Icons.Filled.Cancel, contentDescription = null)
                                }
                            }
                        },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            }
        }
    }
}

@Composable
private fun PluginSettingItem(
    label: String,
    onClick: () -> Unit,
    subtitle: String? = null,
    widget: (@Composable () -> Unit)? = null,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            if (!subtitle.isNullOrEmpty()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (widget != null) {
            Box(modifier = Modifier.padding(start = 16.dp)) { widget() }
        }
    }
}

/** A dialog that carries the plugin's label as body text, since labels can run for several lines. */
@Composable
private fun PluginSettingDialog(
    label: String,
    onDismiss: () -> Unit,
    confirmButton: @Composable () -> Unit,
    dismissButton: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        text = {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.padding(bottom = 16.dp),
                )
                content()
            }
        },
        confirmButton = confirmButton,
        dismissButton = dismissButton,
    )
}
