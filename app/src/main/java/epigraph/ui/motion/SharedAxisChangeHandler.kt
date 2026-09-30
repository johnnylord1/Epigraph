package epigraph.ui.motion

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.view.View
import android.view.ViewGroup
import android.view.animation.DecelerateInterpolator
import android.view.animation.Interpolator
import android.view.animation.LinearInterpolator
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.bluelinelabs.conductor.changehandler.AnimatorChangeHandler
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.ui.main.MainActivity
import yokai.presentation.theme.Motion

/**
 * Shared axis X for push/pop (DESIGN.md §9). The outgoing screen fades out during the first 35% of
 * `dur-medium` while sliding `motion_slide_distance` away; the incoming screen slides the same
 * distance into place and fades in during the rest. A pop that follows a predictive-back gesture
 * starts from wherever the gesture left both views and decelerates with the finger's velocity.
 *
 * One [ValueAnimator] drives both views so the pair can never drift apart; properties are
 * computed in the update listener without allocating.
 */
open class SharedAxisChangeHandler : AnimatorChangeHandler {
    constructor() : super()
    constructor(removesFromViewOnPush: Boolean) : super(removesFromViewOnPush)

    override fun getAnimator(
        container: ViewGroup,
        from: View?,
        to: View?,
        isPush: Boolean,
        toAddedToContainer: Boolean,
    ): Animator {
        val slide = container.resources.getDimension(R.dimen.motion_slide_distance)
        val direction = if (container.layoutDirection == View.LAYOUT_DIRECTION_RTL) -1f else 1f
        val afterGesture = !isPush && from != null && (from.scaleX != 1f || from.translationX != 0f)

        val move: Interpolator = if (afterGesture) {
            DecelerateInterpolator(MainActivity.backVelocity.takeIf { it > 0f } ?: 1f)
        } else {
            Motion.Interpolators.Standard
        }
        val exit = Motion.Interpolators.Exit
        val enter = Motion.Interpolators.Enter

        val fromStartAlpha = from?.alpha ?: 0f
        val fromStartX = from?.translationX ?: 0f
        val fromStartScale = from?.scaleX ?: 1f
        val fromEndX = when {
            isPush -> -direction * slide
            // Keep travelling the way the gesture was already going.
            afterGesture -> (if (fromStartX < 0f) -1f else 1f) * (kotlin.math.abs(fromStartX) + slide)
            else -> direction * slide
        }
        val fromEndScale = if (afterGesture) fromStartScale * 0.98f else 1f

        val toStartAlpha = when {
            to == null -> 1f
            toAddedToContainer -> 0f
            else -> to.alpha
        }
        val toStartX = when {
            to == null -> 0f
            toAddedToContainer || to.translationX == 0f && toStartAlpha == 0f ->
                if (isPush) direction * slide else -direction * slide
            else -> to.translationX
        }
        // After a gesture the previous screen is already showing: fade it the whole way instead of
        // waiting for the outgoing third.
        val toFadeStart = if (afterGesture) 0f else Motion.OutgoingFraction

        if (to != null) {
            to.alpha = toStartAlpha
            to.translationX = toStartX
        }

        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.interpolator = LinearInterpolator()
        animator.duration = if (afterGesture) Motion.DurStandard.toLong() else Motion.DurMedium.toLong()
        animator.addUpdateListener {
            val t = it.animatedFraction
            val m = move.getInterpolation(t)
            if (from != null) {
                val ft = (t / Motion.OutgoingFraction).coerceAtMost(1f)
                from.alpha = fromStartAlpha * (1f - exit.getInterpolation(ft))
                from.translationX = fromStartX + (fromEndX - fromStartX) * m
                if (afterGesture) {
                    val s = fromStartScale + (fromEndScale - fromStartScale) * m
                    from.scaleX = s
                    from.scaleY = s
                }
            }
            if (to != null) {
                val tt = ((t - toFadeStart) / (1f - toFadeStart)).coerceIn(0f, 1f)
                to.alpha = toStartAlpha + (1f - toStartAlpha) * enter.getInterpolation(tt)
                to.translationX = toStartX * (1f - m)
            }
        }
        animator.addListener(
            object : AnimatorListenerAdapter() {
                override fun onAnimationEnd(animation: Animator) = settle()
                override fun onAnimationCancel(animation: Animator) = settle()

                private fun settle() {
                    to?.let(::resetView)
                    // A pushed-over screen stays attached (predictive back needs it) but hidden.
                    if (from != null && !(isPush && !removesFromViewOnPush)) resetView(from)
                }
            },
        )
        return animator
    }

    override fun resetFromView(from: View) = resetView(from)

    override fun copy(): ControllerChangeHandler = SharedAxisChangeHandler(removesFromViewOnPush)

    companion object {
        /** Clears every property a transition or a predictive-back preview may have touched. */
        fun resetView(view: View) {
            view.alpha = 1f
            view.translationX = 0f
            view.scaleX = 1f
            view.scaleY = 1f
            PredictiveBackOutline.clear(view)
        }
    }
}
