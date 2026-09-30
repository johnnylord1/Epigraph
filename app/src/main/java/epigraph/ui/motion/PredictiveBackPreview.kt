package epigraph.ui.motion

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.graphics.Outline
import android.view.View
import android.view.ViewOutlineProvider
import androidx.core.view.isVisible
import eu.kanade.tachiyomi.R
import yokai.presentation.theme.Motion

/**
 * Predictive back preview for Conductor screens (DESIGN.md §9). While the finger drags, the
 * current screen shrinks to [Motion.BackPreviewScale], moves `motion_slide_distance` toward the
 * finger and rounds its corners to `r-l`; the previous screen fades in from its shared-axis
 * resting place. The activity app bar is drawn over the controller container, so it gets the same
 * transform around the same pivot and reads as part of the screen.
 *
 * Releasing hands over to [SharedAxisChangeHandler], which continues from these values.
 * Cancelling replays the preview in reverse. Nothing here allocates per frame.
 */
object PredictiveBackPreview {
    /** Gesture progress is linear in finger travel; ease it so the first centimetre reads. */
    private val progressCurve = Motion.Interpolators.Enter

    private var lastProgress = 0f
    private var lastEdge = 1f
    private var settleAnimator: ValueAnimator? = null

    // Where the previous screen rested before the gesture (the shared-axis push leaves it hidden
    // 30dp to the side; a cover flight or dialog may leave it fully visible under the current one).
    private var previousRestAlpha = 0f
    private var previousRestX = 0f

    fun start(previous: View?) {
        settleAnimator?.cancel()
        settleAnimator = null
        previousRestAlpha = previous?.alpha ?: 0f
        previousRestX = previous?.translationX ?: 0f
    }

    /**
     * @param edge 1 when the gesture starts at the left edge, -1 at the right edge.
     * @param rawProgress [androidx.activity.BackEventCompat.progress].
     */
    fun progress(current: View, previous: View?, chrome: View?, edge: Float, rawProgress: Float) {
        lastEdge = edge
        lastProgress = progressCurve.getInterpolation(rawProgress.coerceIn(0f, 1f))
        apply(current, previous, chrome, edge, lastProgress)
    }

    /** Animates everything back to rest when the gesture is abandoned. */
    fun cancel(current: View?, previous: View?, chrome: View?) {
        settleAnimator?.cancel()
        if (current == null) return
        val from = lastProgress
        val edge = lastEdge
        val animator = ValueAnimator.ofFloat(from, 0f)
        animator.duration = Motion.DurQuick.toLong()
        animator.interpolator = Motion.Interpolators.Standard
        animator.addUpdateListener { apply(current, previous, chrome, edge, it.animatedValue as Float) }
        animator.addListener(
            object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) {
                    SharedAxisChangeHandler.resetView(current)
                    chrome?.let(::releaseChromeNow)
                    previous?.alpha = previousRestAlpha
                    previous?.translationX = previousRestX
                    lastProgress = 0f
                    if (settleAnimator === animation) settleAnimator = null
                }
            },
        )
        settleAnimator = animator
        animator.start()
    }

    /** Called once the pop is committed: the app bar now belongs to the previous screen. */
    fun releaseChrome(chrome: View) {
        lastProgress = 0f
        if (chrome.scaleX == 1f && chrome.translationX == 0f) {
            releaseChromeNow(chrome)
            return
        }
        chrome.animate()
            .scaleX(1f)
            .scaleY(1f)
            .translationX(0f)
            .setDuration(Motion.DurQuick.toLong())
            .setInterpolator(Motion.Interpolators.Standard)
            .withEndAction { releaseChromeNow(chrome) }
            .start()
    }

    fun reset(current: View?, previous: View?, chrome: View?) {
        settleAnimator?.cancel()
        settleAnimator = null
        lastProgress = 0f
        current?.let(SharedAxisChangeHandler::resetView)
        previous?.alpha = previousRestAlpha
        previous?.translationX = previousRestX
        chrome?.let(::releaseChromeNow)
    }

    private fun releaseChromeNow(chrome: View) {
        chrome.scaleX = 1f
        chrome.scaleY = 1f
        chrome.translationX = 0f
        PredictiveBackOutline.clear(chrome)
    }

    private fun apply(current: View, previous: View?, chrome: View?, edge: Float, t: Float) {
        val res = current.resources
        val slide = res.getDimension(R.dimen.motion_slide_distance)
        val radius = res.getDimension(R.dimen.radius_l)
        val scale = 1f - (1f - Motion.BackPreviewScale) * t

        current.scaleX = scale
        current.scaleY = scale
        current.translationX = edge * slide * t
        // The outline is in unscaled coordinates; divide so the visible corner is exactly r-l.
        PredictiveBackOutline.set(current, radius * t / scale, topOnly = false)

        if (chrome != null && chrome.isVisible && chrome.alpha > 0f) {
            val parent = current.parent as? View
            val centerY = (parent?.top ?: 0) + current.top + current.height / 2f
            chrome.pivotX = current.left + current.width / 2f - chrome.left
            chrome.pivotY = centerY - chrome.top - chrome.translationY
            chrome.scaleX = scale
            chrome.scaleY = scale
            chrome.translationX = current.translationX
            PredictiveBackOutline.set(chrome, radius * t / scale, topOnly = true)
        }

        if (previous != null) {
            previous.alpha = maxOf(previousRestAlpha, (t * 3f).coerceAtMost(1f))
            previous.translationX = previousRestX * (1f - t)
        }
    }
}

/** Rounds a view's corners through its outline, restoring whatever it had before. */
internal object PredictiveBackOutline {
    fun set(view: View, radius: Float, topOnly: Boolean) {
        val outline = view.getTag(R.id.predictive_back_outline) as? RoundedOutline
            ?: RoundedOutline(view.outlineProvider, view.clipToOutline).also {
                view.setTag(R.id.predictive_back_outline, it)
                view.outlineProvider = it
                view.clipToOutline = true
            }
        if (outline.radius == radius && outline.topOnly == topOnly) return
        outline.radius = radius
        outline.topOnly = topOnly
        view.invalidateOutline()
    }

    fun clear(view: View) {
        val outline = view.getTag(R.id.predictive_back_outline) as? RoundedOutline ?: return
        view.setTag(R.id.predictive_back_outline, null)
        view.outlineProvider = outline.original
        view.clipToOutline = outline.originalClip
        view.invalidateOutline()
    }

    private class RoundedOutline(
        val original: ViewOutlineProvider?,
        val originalClip: Boolean,
    ) : ViewOutlineProvider() {
        var radius = 0f
        var topOnly = false

        override fun getOutline(view: View, outline: Outline) {
            // Top-only: push the bottom corners below the view so only the top two show.
            val extra = if (topOnly) radius.toInt() + 1 else 0
            outline.setRoundRect(0, 0, view.width, view.height + extra, radius)
        }
    }
}
