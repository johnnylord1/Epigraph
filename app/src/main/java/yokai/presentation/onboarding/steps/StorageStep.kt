package yokai.presentation.onboarding.steps

import android.content.ActivityNotFoundException
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import eu.kanade.tachiyomi.R
import yokai.i18n.MR
import yokai.util.lang.getString
import dev.icerock.moko.resources.compose.stringResource
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.flow.collectLatest
import org.koin.core.component.KoinComponent
import org.koin.core.component.inject
import yokai.domain.storage.StoragePreferences
import yokai.presentation.component.preference.storageLocationText
import yokai.presentation.settings.screen.data.storageLocationPicker
import yokai.presentation.theme.Size

internal class StorageStep : OnboardingStep, KoinComponent {

    private val storagePref: StoragePreferences by inject()

    private var _isComplete by mutableStateOf(false)

    override val isComplete: Boolean
        get() = _isComplete

    @Composable
    override fun Content() {
        val context = LocalContext.current
        val handler = LocalUriHandler.current

        val pickStorageLocation = storageLocationPicker(storagePref.baseStorageDirectory())

        Column(
            modifier = Modifier.padding(Size.medium).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(Size.small),
        ) {
            Text(
                stringResource(
                    MR.strings.onboarding_storage_info,
                    stringResource(MR.strings.app_name),
                    storageLocationText(storagePref.baseStorageDirectory()),
                ),
            )

            // One filled button per screen: picking a folder is the primary action only until one is
            // set; after that "Next" in the footer is, and this drops to secondary.
            val selectFolder: () -> Unit = {
                try {
                    pickStorageLocation.launch(null)
                } catch (e: ActivityNotFoundException) {
                    context.toast(MR.strings.file_picker_error)
                }
            }
            if (_isComplete) {
                OutlinedButton(
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth(),
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = MaterialTheme.colorScheme.onSurface),
                    onClick = selectFolder,
                ) {
                    Text(stringResource(MR.strings.onboarding_storage_action_select))
                }
            } else {
                Button(
                    shape = MaterialTheme.shapes.small,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = selectFolder,
                ) {
                    Text(stringResource(MR.strings.onboarding_storage_action_select))
                }
            }

            HorizontalDivider(
                modifier = Modifier.padding(vertical = Size.small),
                color = MaterialTheme.colorScheme.outlineVariant,
            )

            Text(
                text = stringResource(MR.strings.onboarding_storage_help_info),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            // An external guide: a text link, never competing with the step's own action. Pulled
            // back by the button's inner padding so its label lines up with the text above.
            TextButton(
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.offset(x = -Size.smedium),
                onClick = {
                    handler.openUri(
                        "https://mihon.app/docs/faq/storage#migrating-from-tachiyomi-v0-14-x-or-earlier"
                    )
                },
            ) {
                Text(stringResource(MR.strings.onboarding_storage_help_action))
            }
        }

        LaunchedEffect(Unit) {
            storagePref.baseStorageDirectory().changes().collectLatest {
                _isComplete = storagePref.baseStorageDirectory().isSet()
            }
        }
    }
}
