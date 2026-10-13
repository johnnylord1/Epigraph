package yokai.presentation.component

import android.content.Context
import android.view.Gravity
import android.view.MenuItem
import android.widget.FrameLayout
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import yokai.presentation.theme.YokaiTheme

/**
 * Compact two-option pill switch, the mobile counterpart of the desktop Comics / Books toggle.
 * Like the desktop, the selected option takes the theme accent (primary), not a neutral tone.
 * Screens that switch content type show it in the top app bar actions: in the Library left of the
 * filter button, elsewhere right before the overflow menu (Discover, Browse, Extensions, Repositories).
 */
@Composable
fun <T> SegmentedSwitch(
    options: List<Pair<T, String>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    // Every option is as wide as the widest label in its selected weight, so both halves match
    // (Quadrinhos / Livros) and nothing shifts when the selection moves.
    val style = MaterialTheme.typography.labelMedium
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val labelWidth = remember(options, style, density) {
        val bold = style.copy(fontWeight = FontWeight.SemiBold)
        with(density) { options.maxOf { (_, label) -> measurer.measure(label, bold, maxLines = 1).size.width }.plus(1).toDp() }
    }
    Row(
        modifier = modifier
            .clip(RoundedCornerShape(50))
            .background(MaterialTheme.colorScheme.surfaceContainerHighest)
            .padding(2.dp)
            .selectableGroup(),
    ) {
        options.forEach { (value, label) ->
            val isSelected = value == selected
            val container by animateColorAsState(
                if (isSelected) MaterialTheme.colorScheme.primary else Color.Transparent,
                label = "segmented-switch-container",
            )
            val content by animateColorAsState(
                if (isSelected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                label = "segmented-switch-content",
            )
            Text(
                text = label,
                style = style,
                fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                color = content,
                maxLines = 1,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .clip(RoundedCornerShape(50))
                    .background(container)
                    .selectable(selected = isSelected, role = Role.RadioButton) { onSelect(value) }
                    .padding(horizontal = 12.dp, vertical = 5.dp)
                    .width(labelWidth),
            )
        }
    }
}

/**
 * Hosts a [SegmentedSwitch] as this menu item's action view, so View toolbars show the pill where
 * Compose app bars do. The item needs `showAsAction="always"`. A collapsed app bar copies only the
 * item's icon and title, so its click handler must still switch to the other option.
 */
fun <T> MenuItem.setSegmentedSwitchActionView(
    context: Context,
    options: List<Pair<T, String>>,
    selected: State<T>,
    onSelect: (T) -> Unit,
) {
    // Toolbar menus are re-inflated often; an item that already hosts the pill keeps it.
    if (actionView is PillActionHost) return
    val pill = ComposeView(context).apply {
        setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnDetachedFromWindow)
        setContent {
            YokaiTheme {
                SegmentedSwitch(
                    options = options,
                    selected = selected.value,
                    onSelect = onSelect,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
            }
        }
    }
    actionView = PillActionHost(context, pill)
}

/**
 * The toolbar measures action views as soon as they are set, often before the toolbar is in a
 * window, and a ComposeView cannot compose there. Until attached this host takes no space; the
 * window's first layout pass measures the pill for real.
 */
private class PillActionHost(context: Context, pill: ComposeView) : FrameLayout(context) {
    init {
        addView(pill, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.CENTER))
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        if (!isAttachedToWindow) {
            setMeasuredDimension(0, 0)
            return
        }
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
