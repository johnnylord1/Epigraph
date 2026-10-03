package epigraph.ui.motion

import android.view.View
import androidx.core.view.doOnPreDraw
import androidx.core.view.isVisible
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.SpringAnimation
import yokai.presentation.theme.Motion

/**
 * A reader HUD bar (DESIGN.md §9 "HUD do leitor"): slides in from its edge on `spring-default`
 * while its alpha follows `spring-effects`. Every call retargets from wherever the bar is, so a tap
 * mid-flight reverses it instead of restarting. Hidden at rest means GONE with the transforms reset.
 *
 * [startsHidden] is the logical state at creation: a host that makes the bar visible just before its
 * first [show] (so it can be measured) still gets the slide in from the edge.
 */
class HudSpring(private val bar: View, private val fromTop: Boolean = true, startsHidden: Boolean = true) {

    private val slide = SpringAnimation(bar, DynamicAnimation.TRANSLATION_Y).apply {
        spring = Motion.Spring.Default.force(0f)
    }
    private val fade = SpringAnimation(bar, DynamicAnimation.ALPHA).apply {
        spring = Motion.Spring.Effects.force(1f)
        setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_ALPHA)
    }

    private var hiddenAtRest = startsHidden
    private var target = !hiddenAtRest
    private var onSettled: (() -> Unit)? = null

    private val endListener = DynamicAnimation.OnAnimationEndListener { _, canceled, _, _ ->
        // Both springs report; act once, when the last of them stops.
        if (canceled || slide.isRunning || fade.isRunning) return@OnAnimationEndListener
        if (!target) rest(hidden = true)
        val callback = onSettled
        onSettled = null
        callback?.invoke()
    }

    init {
        slide.addEndListener(endListener)
        fade.addEndListener(endListener)
    }

    /** Slides in; when the last settled state was hidden it starts from the edge, else from where it is. */
    fun show(onShown: () -> Unit = {}) {
        target = true
        onSettled = onShown
        if (hiddenAtRest) {
            hiddenAtRest = false
            bar.isVisible = true
            bar.alpha = 0f
            if (offscreen() == 0f) {
                // Never laid out yet: start from the edge once it has a height, still before its first frame.
                bar.doOnPreDraw { if (target) enter(fromEdge = true) }
                return
            }
            bar.translationY = offscreen()
        }
        enter(fromEdge = false)
    }

    private fun enter(fromEdge: Boolean) {
        if (fromEdge) bar.translationY = offscreen()
        slide.animateToFinalPosition(0f)
        fade.animateToFinalPosition(1f)
    }

    fun hide(onHidden: () -> Unit = {}) {
        target = false
        if (!bar.isVisible) {
            snap(visible = false)
            onHidden()
            return
        }
        hiddenAtRest = false
        onSettled = onHidden
        slide.animateToFinalPosition(offscreen())
        fade.animateToFinalPosition(0f)
    }

    /** Jumps to the end state with no motion (reduced motion, or a non-animated change). */
    fun snap(visible: Boolean) {
        target = visible
        onSettled = null
        slide.cancel()
        fade.cancel()
        rest(hidden = !visible)
        if (visible) bar.isVisible = true
    }

    private fun rest(hidden: Boolean) {
        hiddenAtRest = hidden
        bar.translationY = 0f
        bar.alpha = 1f
        if (hidden) bar.isVisible = false
    }

    private fun offscreen(): Float {
        val height = (if (bar.height > 0) bar.height else bar.measuredHeight).toFloat()
        return if (fromTop) -height else height
    }
}
