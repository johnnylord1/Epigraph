package eu.kanade.tachiyomi.ui.manga

import android.graphics.RenderEffect
import android.graphics.Shader
import android.os.Build
import android.widget.ImageView
import kotlin.math.roundToInt
import yokai.presentation.theme.ReducedMotion

/**
 * The cover veil behind every details header (DESIGN.md §6), shared by Comics, Novels and Books so
 * the three pages cannot drift apart: the cover at 20% alpha with a 24dp blur on API 31+, trailing
 * the content at 0.25× while its blur deepens to 32dp. Without RenderEffect only the alpha applies.
 */
class CoverVeil(private val backdrop: ImageView) {

    /** Blur steps from [BLUR_DP] to [BLUR_MAX_DP], built once so scrolling never allocates. */
    private val effects: Array<RenderEffect>? by lazy {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return@lazy null
        val density = backdrop.resources.displayMetrics.density
        Array(BLUR_STEPS + 1) { step ->
            val radius = (BLUR_DP + (BLUR_MAX_DP - BLUR_DP) * step / BLUR_STEPS) * density
            RenderEffect.createBlurEffect(radius, radius, Shader.TileMode.CLAMP)
        }
    }
    private var appliedStep = -1
    private var scrolled = 0

    /** Call once the backdrop has its image; an empty view has nothing to veil. */
    fun apply() {
        backdrop.alpha = ALPHA
        appliedStep = -1
        onScrolled(scrolled)
    }

    /** Back to the unveiled resting state, for a holder that is about to load another cover. */
    fun reset() {
        backdrop.alpha = RESTING_ALPHA
        backdrop.translationY = 0f
        appliedStep = -1
        scrolled = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) backdrop.setRenderEffect(null)
    }

    /** [scrolled] is how far the header has moved up, derived from layout so it never drifts. */
    fun onScrolled(scrolled: Int) {
        this.scrolled = scrolled
        val height = backdrop.height
        val progress = if (height > 0) (scrolled / height.toFloat()).coerceIn(0f, 1f) else 0f
        backdrop.translationY = if (ReducedMotion.isEnabled()) 0f else scrolled * (1f - PARALLAX)
        val effects = effects
        if (effects == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            backdrop.alpha = ALPHA * (1f - progress)
            return
        }
        val step = (progress * BLUR_STEPS).roundToInt()
        if (step != appliedStep) {
            appliedStep = step
            backdrop.setRenderEffect(effects[step])
        }
    }

    companion object {
        const val ALPHA = 0.2f

        /** manga_header_item's own alpha before a cover arrives. */
        const val RESTING_ALPHA = 0.1f
        const val BLUR_DP = 24f
        const val BLUR_MAX_DP = 32f

        /** Enough steps that the deepening reads as continuous without re-creating effects per pixel. */
        const val BLUR_STEPS = 4

        /** The veil moves at a quarter of the content's speed. */
        const val PARALLAX = 0.25f

        /** Share of the cover's bottom the backdrop drops, so the veil shows its upper artwork. */
        const val CROP_FRACTION = 0.165f
    }
}
