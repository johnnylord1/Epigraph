package eu.kanade.tachiyomi.ui.base.controller

import android.animation.Animator
import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.ValueAnimator
import android.graphics.Outline
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.AnimationUtils
import android.widget.ImageView
import androidx.core.animation.doOnCancel
import androidx.core.animation.doOnEnd
import androidx.core.view.doOnDetach
import androidx.core.view.drawToBitmap
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.bluelinelabs.conductor.changehandler.AnimatorChangeHandler
import com.google.android.material.card.MaterialCardView
import eu.kanade.tachiyomi.R
import java.lang.ref.WeakReference
import kotlin.math.roundToInt

/**
 * The one signature motion in DESIGN.md (§9): the tapped library cover travels to the details
 * header cover while the details screen fades in. Without a source (restored from a bundle,
 * list layouts) it degrades to a plain fade.
 *
 * Only the screen fade is handed to Conductor, so touches are blocked for [R.integer.dur_standard]
 * at most; the cover flight runs on its own in the container overlay and is torn down if the
 * details screen goes away mid-flight.
 */
class CoverExpandChangeHandler : AnimatorChangeHandler {

    private var source: WeakReference<View>? = null
    private var target: (() -> Rect?)? = null
    private var hideTarget: ((Boolean) -> Unit)? = null

    // DEFAULT duration: Conductor would otherwise force one duration onto every child animator.
    constructor() : super(DEFAULT_ANIMATION_DURATION, false)

    /**
     * [target] returns the destination in window coordinates; a zero height keeps the source ratio.
     * [hideTarget] hides the real destination cover while the ghost travels, so only one is seen.
     */
    constructor(source: View, target: () -> Rect?, hideTarget: (Boolean) -> Unit) : super(DEFAULT_ANIMATION_DURATION, false) {
        this.source = WeakReference(source)
        this.target = target
        this.hideTarget = hideTarget
    }

    override fun getAnimator(
        container: ViewGroup,
        from: View?,
        to: View?,
        isPush: Boolean,
        toAddedToContainer: Boolean,
    ): Animator {
        val context = container.context
        val res = context.resources
        val set = AnimatorSet()
        if (to != null) {
            val start = if (toAddedToContainer) 0f else to.alpha
            set.play(
                ObjectAnimator.ofFloat(to, View.ALPHA, start, 1f).apply {
                    duration = res.getInteger(R.integer.dur_standard).toLong()
                    interpolator = AnimationUtils.loadInterpolator(context, R.interpolator.ease_enter)
                },
            )
        }
        if (from != null) {
            // Leave quickly so the two screens never read as a double exposure.
            set.play(
                ObjectAnimator.ofFloat(from, View.ALPHA, 0f).apply {
                    duration = res.getInteger(R.integer.dur_quick).toLong()
                    interpolator = AnimationUtils.loadInterpolator(context, R.interpolator.ease_exit)
                },
            )
        }
        if (isPush && to != null) startCoverFlight(container, to)
        return set
    }

    private fun startCoverFlight(container: ViewGroup, to: View) {
        val context = container.context
        val cover = source?.get() ?: return
        if (!cover.isAttachedToWindow || cover.width == 0 || cover.height == 0) return
        if (target?.invoke() == null) return
        // Coil hands out hardware bitmaps, which drawToBitmap's software canvas rejects; reuse
        // the cover drawable instead (same pixels, no copy) and only snapshot as a fallback.
        val image = cover as? ImageView ?: cover.findViewById<ImageView?>(R.id.cover_thumbnail)
        val drawable = image?.drawable?.constantState?.newDrawable(context.resources)?.mutate()
        val bitmap = if (drawable == null) runCatching { cover.drawToBitmap() }.getOrNull() ?: return else null

        val containerLoc = IntArray(2).also(container::getLocationInWindow)
        val coverLoc = IntArray(2).also(cover::getLocationInWindow)
        val startRect = Rect(coverLoc[0], coverLoc[1], coverLoc[0] + cover.width, coverLoc[1] + cover.height)
            .apply { offset(-containerLoc[0], -containerLoc[1]) }
        val ratio = cover.height.toFloat() / cover.width
        // Re-read every frame: the details header binds a few frames after the push starts, and
        // the flight should land where the real cover ends up, not on the loading placeholder.
        fun endRect(): Rect? = target?.invoke()?.apply {
            if (height() <= 0) bottom = top + (width() * ratio).roundToInt()
            offset(-containerLoc[0], -containerLoc[1])
        }

        val startRadius = (cover as? MaterialCardView)?.radius ?: 0f
        val endRadius = context.resources.getDimension(R.dimen.radius_m)
        var radius = startRadius
        val ghost = ImageView(context).apply {
            if (drawable != null) {
                setImageDrawable(drawable)
                scaleType = image?.scaleType ?: ImageView.ScaleType.CENTER_CROP
            } else {
                setImageBitmap(bitmap)
                scaleType = ImageView.ScaleType.FIT_XY
            }
            // The corners morph from the grid's r-s to the header's r-m on the way.
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) =
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
            }
            clipToOutline = true
        }
        var last = startRect
        fun place(f: Float) {
            val end = endRect() ?: last
            last = end
            fun lerp(a: Int, b: Int) = (a + (b - a) * f).roundToInt()
            radius = startRadius + (endRadius - startRadius) * f
            ghost.invalidateOutline()
            ghost.layout(
                lerp(startRect.left, end.left),
                lerp(startRect.top, end.top),
                lerp(startRect.right, end.right),
                lerp(startRect.bottom, end.bottom),
            )
        }

        val flight = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = context.resources.getInteger(R.integer.dur_emphasized).toLong()
            interpolator = AnimationUtils.loadInterpolator(context, R.interpolator.ease_emphasized)
            addUpdateListener {
                place(it.animatedValue as Float)
                // Re-applied every frame: the details header may bind mid-flight.
                hideTarget?.invoke(true)
            }
        }
        var done = false
        fun land() {
            if (done) return
            done = true
            container.overlay.remove(ghost)
            cover.alpha = 1f
            hideTarget?.invoke(false)
        }
        flight.doOnEnd { land() }
        flight.doOnCancel { land() }
        // Back pressed (or the screen replaced) mid-flight: drop the ghost instead of leaving it on top.
        to.doOnDetach { flight.cancel() }

        place(0f)
        container.overlay.add(ghost)
        // The grid card stays put underneath; hide it so only one cover is travelling.
        cover.alpha = 0f
        hideTarget?.invoke(true)
        flight.start()
    }

    override fun resetFromView(from: View) {
        from.alpha = 1f
    }

    override fun copy(): ControllerChangeHandler =
        CoverExpandChangeHandler().also {
            it.source = source
            it.target = target
            it.hideTarget = hideTarget
        }
}
