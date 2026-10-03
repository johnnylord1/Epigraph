package yokai.presentation.component

import android.content.res.Configuration
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.icerock.moko.resources.compose.stringResource
import eu.kanade.tachiyomi.util.system.getResourceColor
import eu.kanade.tachiyomi.widget.EmptyView
import yokai.i18n.MR
import yokai.presentation.theme.Size

// DESIGN.md §10 empty state: 48dp icon in text-3, message in body / text-2 (max 280dp).
private val defaultIconModifier =
    Modifier.size(Size.huge)

private val messageMaxWidth = 280.dp

@Composable
private fun emptyIconColor(): Color {
    val context = LocalContext.current
    return remember(context.theme) { Color(context.getResourceColor(android.R.attr.textColorHint)) }
}

/**
 * Composable replacement for [eu.kanade.tachiyomi.widget.EmptyView]
 */
@Composable
fun EmptyScreen(
    modifier: Modifier = Modifier,
    image: ImageVector,
    message: String,
    isTablet: Boolean,
    actions: List<EmptyView.Action> = emptyList(),
) = EmptyScreenImpl(
    modifier = modifier,
    image = {
        Image(
            modifier = defaultIconModifier,
            imageVector = image,
            contentDescription = null,
            colorFilter = ColorFilter.tint(emptyIconColor()),
        )
    },
    message = message,
    actions = { EmptyScreenActions(actions, isTablet) },
    isTablet = isTablet,
)

@Composable
fun EmptyScreen(
    modifier: Modifier = Modifier,
    image: ImageBitmap,
    message: String,
    isTablet: Boolean,
    actions: List<EmptyView.Action> = emptyList(),
) = EmptyScreenImpl(
    modifier = modifier,
    image = {
        Image(
            modifier = defaultIconModifier,
            bitmap = image,
            contentDescription = null,
        )
    },
    message = message,
    actions = { EmptyScreenActions(actions, isTablet) },
    isTablet = isTablet,
)

@Composable
private fun EmptyScreenActions(actions: List<EmptyView.Action>, isTablet: Boolean) {
    if (isTablet) {
        FlowRow {
            actions.forEach { action ->
                TextButton(onClick = { action.listener() }) {
                    Text(text = stringResource(action.resId))
                }
            }
        }
    } else {
        Column(
            verticalArrangement = Arrangement.spacedBy(2.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            actions.forEach { action ->
                TextButton(onClick = { action.listener() }) {
                    Text(text = stringResource(action.resId))
                }
            }
        }
    }
}

@Composable
private fun EmptyScreenImpl(
    modifier: Modifier = Modifier,
    image: @Composable () -> Unit,
    message: String,
    actions: @Composable () -> Unit,
    isTablet: Boolean,
) {
    if (isTablet) {
        Column(
            modifier = modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(Size.small),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            Row {
                image()
                Text(
                    modifier = Modifier
                        .widthIn(max = messageMaxWidth)
                        .padding(vertical = Size.tiny),
                    text = message,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                )
            }
            actions()
        }
    } else {
        Column(
            modifier = modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(Size.medium),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
        ) {
            image()
            Text(
                modifier = Modifier
                    .widthIn(max = messageMaxWidth)
                    .padding(vertical = Size.medium),
                text = message,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                style = MaterialTheme.typography.bodyLarge,
                textAlign = TextAlign.Center,
            )
            actions()
        }
    }
}

@Preview(name = "Dark", uiMode = Configuration.UI_MODE_NIGHT_YES, showBackground = true)
@Preview(name = "Light", uiMode = Configuration.UI_MODE_NIGHT_NO, showBackground = true)
@Composable
private fun EmptyScreenPreview() {
    EmptyScreen(
        image = Icons.Filled.Download,
        message = "Something went wrong",
        actions = listOf(
            EmptyView.Action(MR.strings.download) {},
            EmptyView.Action(MR.strings.download) {},
            EmptyView.Action(MR.strings.download) {},
            EmptyView.Action(MR.strings.download) {},
            EmptyView.Action(MR.strings.download) {},
        ),
        isTablet = false,
    )
}
