package yokai.presentation.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.runtime.Composable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import eu.kanade.tachiyomi.R

val Outfit = FontFamily(
    Font(R.font.outfit_light, FontWeight.Light),
    Font(R.font.outfit_regular, FontWeight.Normal),
    Font(R.font.outfit_medium, FontWeight.Medium),
    Font(R.font.outfit_semibold, FontWeight.SemiBold),
    Font(R.font.outfit_bold, FontWeight.Bold),
)

// DESIGN.md §3 type scale. Roles not named by the DS keep their M3 size, re-pointed to Outfit.
private fun TextStyle.ds(size: Int, line: Int, weight: FontWeight, spacing: Float = 0f) = copy(
    fontFamily = Outfit,
    fontSize = size.sp,
    lineHeight = line.sp,
    fontWeight = weight,
    letterSpacing = spacing.em,
)

val AppTypography: Typography = Typography().run {
    copy(
        displayLarge = displayLarge.copy(fontFamily = Outfit),
        displayMedium = displayMedium.copy(fontFamily = Outfit),
        displaySmall = displaySmall.copy(fontFamily = Outfit),
        headlineLarge = headlineLarge.ds(32, 40, FontWeight.SemiBold, -0.008f),
        headlineMedium = headlineMedium.copy(fontFamily = Outfit),
        headlineSmall = headlineSmall.copy(fontFamily = Outfit),
        titleLarge = titleLarge.ds(22, 28, FontWeight.SemiBold),
        titleMedium = titleMedium.ds(16, 24, FontWeight.Medium),
        titleSmall = titleSmall.ds(14, 20, FontWeight.Medium),
        bodyLarge = bodyLarge.ds(16, 24, FontWeight.Normal),
        bodyMedium = bodyMedium.ds(14, 20, FontWeight.Normal),
        bodySmall = bodySmall.ds(12, 16, FontWeight.Medium),
        labelLarge = labelLarge.ds(14, 20, FontWeight.Medium),
        labelMedium = labelMedium.ds(12, 16, FontWeight.Medium),
        labelSmall = labelSmall.ds(12, 16, FontWeight.Medium),
    )
}

val Typography.header: TextStyle
    @Composable
    get() = bodyMedium.copy(
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        fontWeight = FontWeight.SemiBold,
    )
