package epigraph.ui.color

import android.graphics.Color
import androidx.annotation.ColorInt
import androidx.core.graphics.ColorUtils

/**
 * Cover-derived accent (DESIGN.md §2 "Paleta derivada da capa"). Only used when the user turned on
 * `themeMangaDetails` for the title; otherwise the theme accent stays.
 */
object CoverPalette {
    /** WCAG AA for text and icons drawn in the accent. */
    const val MIN_CONTRAST = 4.5

    /**
     * Moves [color]'s lightness away from [background] (keeping hue and saturation) until it reaches
     * [minContrast]. Returns the colour unchanged when it already passes.
     */
    @ColorInt
    fun accentFor(@ColorInt color: Int, @ColorInt background: Int, minContrast: Double = MIN_CONTRAST): Int {
        val opaque = ColorUtils.setAlphaComponent(color, 0xFF)
        val bg = ColorUtils.setAlphaComponent(background, 0xFF)
        if (ColorUtils.calculateContrast(opaque, bg) >= minContrast) return opaque
        val hsl = FloatArray(3)
        ColorUtils.colorToHSL(opaque, hsl)
        val lighten = ColorUtils.calculateLuminance(bg) < 0.5
        // Binary search on lightness: 12 steps is below one 8-bit step.
        var low = hsl[2]
        var high = if (lighten) 1f else 0f
        var best = ColorUtils.HSLToColor(floatArrayOf(hsl[0], hsl[1], high))
        repeat(12) {
            val mid = (low + high) / 2f
            val candidate = ColorUtils.HSLToColor(floatArrayOf(hsl[0], hsl[1], mid))
            if (ColorUtils.calculateContrast(candidate, bg) >= minContrast) {
                best = candidate
                high = mid
            } else {
                low = mid
            }
        }
        return best
    }

    /** Black or white, whichever reads better on [accent] (`on-cover-accent`). */
    @ColorInt
    fun onAccent(@ColorInt accent: Int): Int {
        val opaque = ColorUtils.setAlphaComponent(accent, 0xFF)
        val onBlack = ColorUtils.calculateContrast(Color.BLACK, opaque)
        val onWhite = ColorUtils.calculateContrast(Color.WHITE, opaque)
        return if (onBlack >= onWhite) Color.BLACK else Color.WHITE
    }
}
