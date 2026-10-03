package epigraph.reader.settings

import android.app.Activity
import android.content.res.ColorStateList
import android.graphics.Color
import android.view.View
import android.widget.ImageButton
import androidx.annotation.ColorInt
import androidx.core.graphics.ColorUtils
import androidx.core.view.children
import eu.kanade.tachiyomi.databinding.ReaderActivityBinding
import eu.kanade.tachiyomi.util.system.getResourceColor
import com.google.android.material.R as MaterialR

/**
 * Colors owned by a reader theme.  Reader themes are deliberately independent from the app
 * theme: the page, toolbar, progress rail and chapter sheet must change together.
 */
data class ReaderThemeColors(
    @ColorInt val background: Int,
    @ColorInt val foreground: Int,
    @ColorInt val accent: Int,
) {
    val surface: Int
        @ColorInt get() = background
    val mutedForeground: Int
        @ColorInt get() = ColorUtils.setAlphaComponent(foreground, 180)

    companion object {
        @ColorInt
        private fun readableForeground(@ColorInt background: Int): Int {
            return if (ColorUtils.calculateLuminance(background) > 0.48) {
                Color.BLACK
            } else {
                Color.WHITE
            }
        }

        @ColorInt
        private fun accentFor(@ColorInt background: Int, @ColorInt foreground: Int): Int {
            // Keep the active rail visible on both very light and very dark reader surfaces.
            val target = if (ColorUtils.calculateLuminance(background) > 0.48) Color.BLACK else Color.WHITE
            return ColorUtils.blendARGB(foreground, target, 0.22f)
        }

        /**
         * The app accent (lilac in Nocturne), as the desktop HUD uses for its progress rail.
         * Falls back to the neutral rail when the accent would not read on this reader surface.
         */
        @ColorInt
        private fun themedAccent(activity: Activity, @ColorInt background: Int, @ColorInt foreground: Int): Int {
            val accent = ColorUtils.setAlphaComponent(activity.getResourceColor(MaterialR.attr.colorSecondary), 255)
            val opaqueBackground = ColorUtils.setAlphaComponent(background, 255)
            // On paper and sepia surfaces the pale accent is pulled toward the text colour, keeping its hue.
            val towards = ColorUtils.setAlphaComponent(foreground, 255)
            var step = 0
            while (step <= ACCENT_BLEND_STEPS) {
                val candidate = ColorUtils.blendARGB(accent, towards, step / ACCENT_BLEND_STEPS.toFloat() * MAX_ACCENT_BLEND)
                if (ColorUtils.calculateContrast(candidate, opaqueBackground) >= MIN_ACCENT_CONTRAST) return candidate
                step++
            }
            return accentFor(background, foreground)
        }

        private const val ACCENT_BLEND_STEPS = 12
        private const val MAX_ACCENT_BLEND = 0.6f

        private const val MIN_ACCENT_CONTRAST = 3.0

        fun comic(preference: Int): ReaderThemeColors {
            val background = when (preference) {
                0 -> Color.WHITE
                1 -> Color.BLACK
                4 -> Color.rgb(32, 33, 37)
                // Smart themes have no single page color. The app surface is the only stable
                // chrome fallback; callers that need it should use the Activity overload.
                else -> Color.rgb(32, 33, 37)
            }
            val foreground = readableForeground(background)
            return ReaderThemeColors(background, foreground, accentFor(background, foreground))
        }

        fun comic(activity: Activity, preference: Int): ReaderThemeColors {
            val appSurface = activity.getResourceColor(MaterialR.attr.colorSurface)
            val background = when (preference) {
                0 -> Color.WHITE
                1 -> Color.BLACK
                4 -> Color.rgb(32, 33, 37)
                else -> appSurface
            }
            val foreground = readableForeground(background)
            return ReaderThemeColors(background, foreground, themedAccent(activity, background, foreground))
        }

        fun novel(
            activity: Activity,
            theme: String,
            @ColorInt customBackground: Int = 0,
            @ColorInt customForeground: Int = 0,
        ): ReaderThemeColors {
            val appSurface = activity.getResourceColor(MaterialR.attr.colorSurface)
            val appOnSurface = activity.getResourceColor(MaterialR.attr.colorOnSurface)
            val background = when (theme) {
                "app" -> appSurface
                "light" -> Color.WHITE
                "dark" -> Color.rgb(18, 18, 18)
                "sepia" -> Color.rgb(244, 236, 216)
                "black", "oled" -> Color.BLACK
                "grey" -> Color.rgb(41, 40, 50)
                "custom" -> customBackground.takeIf { it != 0 } ?: Color.WHITE
                else -> appSurface
            }
            val foreground = when (theme) {
                "app" -> appOnSurface
                "sepia" -> Color.rgb(91, 70, 54)
                "light" -> Color.BLACK
                "black", "oled", "grey" -> Color.rgb(204, 204, 204)
                "custom" -> customForeground.takeIf { it != 0 } ?: Color.BLACK
                else -> Color.WHITE
            }
            return ReaderThemeColors(background, foreground, themedAccent(activity, background, foreground))
        }

        fun book(activity: Activity, theme: String): ReaderThemeColors {
            val appSurface = activity.getResourceColor(MaterialR.attr.colorSurface)
            val appOnSurface = activity.getResourceColor(MaterialR.attr.colorOnSurface)
            val background = when (theme) {
                "system" -> appSurface
                "light" -> Color.WHITE
                "dark" -> Color.rgb(18, 18, 18)
                "sepia" -> Color.rgb(244, 236, 216)
                "oled" -> Color.BLACK
                else -> appSurface
            }
            val foreground = when (theme) {
                "system" -> appOnSurface
                "sepia" -> Color.rgb(91, 70, 54)
                "light" -> Color.BLACK
                "dark" -> Color.rgb(224, 224, 224)
                else -> Color.WHITE
            }
            return ReaderThemeColors(background, foreground, themedAccent(activity, background, foreground))
        }
    }
}

/** Applies one reader palette to every chrome surface, without touching the content filters. */
fun ReaderActivityBinding.applyReaderTheme(colors: ReaderThemeColors) {
    appBar.setBackgroundColor(colors.surface)
    readerNav.root.backgroundTintList = ColorStateList.valueOf(colors.surface)
    chaptersSheet.root.themedSurface = colors.surface

    toolbar.setTitleTextColor(colors.foreground)
    toolbar.setSubtitleTextColor(colors.mutedForeground)
    toolbar.navigationIcon?.setTint(colors.foreground)

    listOf(
        readerNav.leftChapter,
        readerNav.rightChapter,
        chaptersSheet.chaptersButton,
        chaptersSheet.webviewButton,
        chaptersSheet.readingMode,
        chaptersSheet.rotationSheetButton,
        chaptersSheet.cropBordersSheetButton,
        chaptersSheet.doublePage,
        chaptersSheet.shiftPageButton,
        chaptersSheet.displayOptions,
    ).forEach { it.imageTintList = ColorStateList.valueOf(colors.foreground) }

    readerNav.leftPageText.setTextColor(colors.foreground)
    readerNav.rightPageText.setTextColor(colors.foreground)
    pageNumber.setTextColor(colors.foreground)
    // The indicator's pill follows the reader surface so it stays readable over any page.
    pageNumber.backgroundTintList = ColorStateList.valueOf(colors.surface)
    readerNav.pageSeekbar.apply {
        thumbTintList = ColorStateList.valueOf(colors.accent)
        trackActiveTintList = ColorStateList.valueOf(colors.accent)
        trackInactiveTintList = ColorStateList.valueOf(ColorUtils.setAlphaComponent(colors.foreground, 72))
        haloTintList = ColorStateList.valueOf(ColorUtils.setAlphaComponent(colors.accent, 64))
    }
    chaptersSheet.root.tintImageButtons(colors.foreground)
}

private fun View.tintImageButtons(@ColorInt foreground: Int) {
    if (this is ImageButton) {
        imageTintList = ColorStateList.valueOf(foreground)
    }
    fun visit(view: View) {
        if (view is ImageButton) view.imageTintList = ColorStateList.valueOf(foreground)
        if (view is android.view.ViewGroup) view.children.forEach(::visit)
    }
    if (this is android.view.ViewGroup) children.forEach(::visit)
}
