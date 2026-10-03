package yokai.presentation.theme

import android.content.Context
import android.util.TypedValue
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.unit.LayoutDirection
import com.google.accompanist.themeadapter.material3.createMdc3Theme
import com.google.android.material.R as MaterialR
import java.util.concurrent.ConcurrentHashMap

// createMdc3Theme walks ~20 theme attrs per call; per-cell ComposeViews were paying it on every
// visible cell. Result only varies by (theme hash, uiMode), so cache process-wide.
private val colourSchemeCache = ConcurrentHashMap<Long, ColorScheme>()

private fun cachedColourScheme(context: Context, uiMode: Int): ColorScheme {
    val key = (context.theme.hashCode().toLong() shl 32) or
        (uiMode.toLong() and 0xFFFFFFFFL)
    return colourSchemeCache.getOrPut(key) {
        @Suppress("DEPRECATION")
        val theme = createMdc3Theme(
            context = context,
            layoutDirection = LayoutDirection.Rtl,
            setTextColors = true,
            readTypography = false,
        )
        theme.component1()!!.withSurfaceContainers(context)
    }
}

/**
 * createMdc3Theme predates the surface-container roles, so Compose menus, dialogs and sheets fell
 * back to Material's baseline tones. Copy them from the XML theme when it defines them.
 */
private fun ColorScheme.withSurfaceContainers(context: Context): ColorScheme {
    val attrs = intArrayOf(
        MaterialR.attr.colorSurfaceContainerLowest,
        MaterialR.attr.colorSurfaceContainerLow,
        MaterialR.attr.colorSurfaceContainer,
        MaterialR.attr.colorSurfaceContainerHigh,
        MaterialR.attr.colorSurfaceContainerHighest,
        MaterialR.attr.colorSurfaceBright,
        MaterialR.attr.colorSurfaceDim,
    )
    val values = TypedValue()
    fun read(attr: Int, fallback: Color): Color =
        if (context.theme.resolveAttribute(attr, values, true) &&
            values.type >= TypedValue.TYPE_FIRST_COLOR_INT && values.type <= TypedValue.TYPE_LAST_COLOR_INT
        ) {
            Color(values.data)
        } else {
            fallback
        }
    return copy(
        surfaceContainerLowest = read(attrs[0], surfaceContainerLowest),
        surfaceContainerLow = read(attrs[1], surfaceContainerLow),
        surfaceContainer = read(attrs[2], surfaceContainer),
        surfaceContainerHigh = read(attrs[3], surfaceContainerHigh),
        surfaceContainerHighest = read(attrs[4], surfaceContainerHighest),
        surfaceBright = read(attrs[5], surfaceBright),
        surfaceDim = read(attrs[6], surfaceDim),
    )
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
fun YokaiTheme(content: @Composable () -> Unit) {
    val context = LocalContext.current
    val uiMode = LocalConfiguration.current.uiMode
    val colourScheme = remember(context.theme, uiMode) {
        cachedColourScheme(context, uiMode)
    }

    // Observe via the central accessor so toggling reduced motion recomposes the tree.
    val reducedMotion by ReducedMotion.changes().collectAsState(initial = ReducedMotion.isEnabled())

    // DESIGN.md §9: expressive springs in M3 components; reduced motion falls back to the calmer
    // standard scheme (our own code snaps via LocalReducedMotion).
    MaterialExpressiveTheme(
        colorScheme = colourScheme,
        motionScheme = if (reducedMotion) MotionScheme.standard() else MotionScheme.expressive(),
        typography = AppTypography,
        shapes = AppShapes,
    ) {
        CompositionLocalProvider(LocalReducedMotion provides reducedMotion) {
            content()
        }
    }
}
