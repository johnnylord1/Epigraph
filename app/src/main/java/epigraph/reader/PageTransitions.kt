package epigraph.reader

import android.content.Context
import android.view.View
import android.view.animation.Interpolator
import android.widget.Scroller
import androidx.viewpager.widget.DirectionalViewPager
import androidx.viewpager.widget.ViewPager
import co.touchlab.kermit.Logger
import kotlin.math.abs
import kotlin.math.roundToInt
import yokai.presentation.theme.Motion

/**
 * Paged-reader page turns (DESIGN.md §9 "Leitor"): a style drawn by a [ViewPager.PageTransformer]
 * and a speed that scales the pager's own settle durations, so a drag, a fling and a tap turn all
 * share one feel. The styles only move pages that are between rest positions; a page at rest is
 * always untransformed.
 */
object PageTransitions {
    const val STYLE_SLIDE = 0
    const val STYLE_DEPTH = 1
    const val STYLE_FADE = 2

    const val SPEED_SLOW = 0
    const val SPEED_NORMAL = 1
    const val SPEED_FAST = 2

    /** Settle-duration multiplier; the pager's own tap turn is 200ms at 1×. */
    fun speedFactor(speed: Int): Float = when (speed) {
        SPEED_SLOW -> 1.6f
        SPEED_FAST -> 0.6f
        else -> 1f
    }

    /**
     * Applies [style] and [speed] to [pager]. Reduced motion keeps only a quick fade, as everywhere
     * else in the app.
     */
    fun apply(pager: DirectionalViewPager, style: Int, speed: Int, horizontal: Boolean, reducedMotion: Boolean) {
        val effective = if (reducedMotion) STYLE_FADE else style
        val transformer = when (effective) {
            STYLE_DEPTH -> DepthTransformer(horizontal)
            STYLE_FADE -> FadeTransformer(horizontal)
            else -> null
        }
        pager.setPageTransformer(transformer != null, transformer)
        (scrollerOf(pager) as? PacedScroller)?.factor = speedFactor(if (reducedMotion) SPEED_FAST else speed)
        // Re-run the new style on the pages already attached so none keeps the old one's transforms.
        val size = if (horizontal) pager.width - pager.paddingLeft - pager.paddingRight else pager.height - pager.paddingTop - pager.paddingBottom
        for (i in 0 until pager.childCount) {
            val page = pager.getChildAt(i)
            reset(page)
            if (transformer != null && size > 0) {
                val offset = if (horizontal) page.left - pager.scrollX else page.top - pager.scrollY
                transformer.transformPage(page, offset / size.toFloat())
            }
        }
    }

    /**
     * Swaps the pager's scroller for one whose durations follow the chosen speed. Must run while the
     * pager has never scrolled (right after construction): the pager reads its position back from
     * the scroller when a scroll completes.
     */
    fun installPacedScroller(pager: DirectionalViewPager) {
        val field = scrollerField ?: return
        runCatching { field.set(pager, PacedScroller(pager.context)) }
            .onFailure { Logger.w(it) { "Page turn speed unavailable; keeping the pager's scroller" } }
    }

    private val scrollerField by lazy {
        runCatching { DirectionalViewPager::class.java.getDeclaredField("mScroller").apply { isAccessible = true } }
            .onFailure { Logger.w(it) { "DirectionalViewPager.mScroller not found" } }
            .getOrNull()
    }

    private fun scrollerOf(pager: DirectionalViewPager): Scroller? =
        scrollerField?.let { runCatching { it.get(pager) as? Scroller }.getOrNull() }

    private fun reset(page: View) {
        page.alpha = 1f
        page.translationX = 0f
        page.translationY = 0f
        page.scaleX = 1f
        page.scaleY = 1f
    }

    /** Places a page back where it would rest while the pager moves the others past it. */
    private fun View.hold(position: Float, horizontal: Boolean) {
        if (horizontal) {
            translationX = -position * width
            translationY = 0f
        } else {
            translationY = -position * height
            translationX = 0f
        }
    }

    /**
     * The leading page slides away as usual; the page behind it rises from depth (scale and alpha),
     * like lifting the top sheet off a stack. Drawn with reversed order so the rising page stays under.
     */
    private class DepthTransformer(private val horizontal: Boolean) : ViewPager.PageTransformer {
        override fun transformPage(page: View, position: Float) {
            if (position <= 0f || position >= 1f) {
                // At rest, sliding normally, or off screen.
                reset(page)
                return
            }
            val scale = DEPTH_SCALE + (1f - DEPTH_SCALE) * (1f - position)
            page.alpha = 1f - position
            page.hold(position, horizontal)
            page.scaleX = scale
            page.scaleY = scale
        }
    }

    /** Pages stay put and cross-fade, with the same slight settle as the app's fade-through. */
    private class FadeTransformer(private val horizontal: Boolean) : ViewPager.PageTransformer {
        override fun transformPage(page: View, position: Float) {
            val distance = abs(position)
            if (distance >= 1f) {
                reset(page)
                return
            }
            val scale = 1f - (1f - Motion.FadeThroughScale) * distance
            page.alpha = 1f - distance
            page.hold(position, horizontal)
            page.scaleX = scale
            page.scaleY = scale
        }
    }

    /** The pager's quintic ease-out, with every settle duration scaled by [factor]. */
    private class PacedScroller(context: Context) : Scroller(context, QuinticOut) {
        var factor = 1f

        override fun startScroll(startX: Int, startY: Int, dx: Int, dy: Int, duration: Int) {
            super.startScroll(startX, startY, dx, dy, (duration * factor).roundToInt())
        }
    }

    private val QuinticOut = Interpolator { input ->
        val t = input - 1f
        t * t * t * t * t + 1f
    }

    private const val DEPTH_SCALE = 0.85f
}
