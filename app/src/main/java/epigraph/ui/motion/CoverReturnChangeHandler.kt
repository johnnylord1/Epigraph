package epigraph.ui.motion

import android.animation.Animator
import android.animation.ValueAnimator
import android.graphics.Outline
import android.graphics.Rect
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.widget.ImageView
import androidx.core.animation.doOnCancel
import androidx.core.animation.doOnEnd
import androidx.core.view.doOnDetach
import com.bluelinelabs.conductor.ControllerChangeHandler
import com.google.android.material.card.MaterialCardView
import eu.kanade.tachiyomi.R
import kotlin.math.roundToInt
import yokai.presentation.theme.Motion
import yokai.presentation.theme.ReducedMotion

/**
 * The way back from Detalhes to the library grid (DESIGN.md §9 "Capa → Detalhes"). The screens use
 * the shared axis, so a predictive-back gesture continues exactly as on every other screen, while
 * the header cover flies back into its grid cell when both ends are on screen. Without either end
 * (header scrolled away, cell off screen or re-bound, restored from a bundle) it is a plain pop.
 */
class CoverReturnChangeHandler : SharedAxisChangeHandler {

    private var headerCover: (() -> View?)? = null
    private var gridCard: (() -> View?)? = null

    /** Conductor re-creates handlers reflectively; without the lambdas this is the shared axis. */
    constructor() : super()

    /** [headerCover] is the details header cover card; [gridCard] the library card showing the same work. */
    constructor(headerCover: () -> View?, gridCard: () -> View?) : super() {
        this.headerCover = headerCover
        this.gridCard = gridCard
    }

    override fun getAnimator(
        container: ViewGroup,
        from: View?,
        to: View?,
        isPush: Boolean,
        toAddedToContainer: Boolean,
    ): Animator {
        // Read the header before the shared axis touches `from`: the gesture may have scaled it.
        if (!isPush && !ReducedMotion.isEnabled()) startReturnFlight(container, from)
        return super.getAnimator(container, from, to, isPush, toAddedToContainer)
    }

    private fun startReturnFlight(container: ViewGroup, from: View?) {
        val header = headerCover?.invoke() ?: return
        val card = gridCard?.invoke() ?: return
        if (!header.isAttachedToWindow || !card.isAttachedToWindow) return
        if (header.width == 0 || card.width == 0 || header.alpha == 0f) return
        val image = header as? ImageView ?: header.findViewById<ImageView?>(R.id.manga_cover) ?: return
        val drawable = image.drawable?.constantState?.newDrawable(container.resources)?.mutate() ?: return

        val containerLoc = IntArray(2).also(container::getLocationInWindow)
        // A predictive-back gesture leaves the details screen scaled; the header shrinks with it.
        val headerScale = from?.scaleX ?: 1f
        val startRect = rectOf(header, containerLoc, headerScale)
        if (!Rect.intersects(startRect, Rect(0, 0, container.width, container.height))) return

        val startRadius = ((header as? MaterialCardView)?.radius ?: 0f) * headerScale
        val endRadius = (card as? MaterialCardView)?.radius ?: 0f
        var radius = startRadius
        val ghost = ImageView(container.context).apply {
            setImageDrawable(drawable)
            scaleType = ImageView.ScaleType.CENTER_CROP
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) =
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
            }
            clipToOutline = true
        }
        val decorations = CoverDecorations.of(card)
        val cardLoc = IntArray(2)
        fun place(f: Float) {
            // The grid slides in with the shared axis, so its cell is re-read every frame.
            card.getLocationInWindow(cardLoc)
            val left = cardLoc[0] - containerLoc[0]
            val top = cardLoc[1] - containerLoc[1]
            fun lerp(a: Int, b: Int) = (a + (b - a) * f).roundToInt()
            radius = startRadius + (endRadius - startRadius) * f
            ghost.invalidateOutline()
            val rect = Rect(
                lerp(startRect.left, left),
                lerp(startRect.top, top),
                lerp(startRect.right, left + card.width),
                lerp(startRect.bottom, top + card.height),
            )
            ghost.layout(rect.left, rect.top, rect.right, rect.bottom)
            // The cell's badge and read button come back on top of the cover as it lands.
            decorations.place(rect, (f - (1f - DECORATION_FADE)) / DECORATION_FADE)
        }

        val flight = ValueAnimator.ofFloat(0f, 1f).apply {
            duration = Motion.DurEmphasized.toLong()
            interpolator = Motion.Interpolators.Emphasized
            addUpdateListener { place(it.animatedValue as Float) }
        }
        var done = false
        fun land() {
            if (done) return
            done = true
            container.overlay.remove(ghost)
            decorations.detach(container.overlay)
            card.alpha = 1f
        }
        flight.doOnEnd { land() }
        flight.doOnCancel { land() }
        // The library going away mid-flight (another pop, activity finishing) drops the ghost.
        card.doOnDetach { flight.cancel() }

        place(0f)
        container.overlay.add(ghost)
        decorations.attach(container.overlay)
        // Only one cover travels: the header one leaves with its screen, the cell waits for the ghost.
        header.alpha = 0f
        card.alpha = 0f
        flight.start()
    }

    private fun rectOf(view: View, containerLoc: IntArray, scale: Float): Rect {
        val loc = IntArray(2).also(view::getLocationInWindow)
        val left = loc[0] - containerLoc[0]
        val top = loc[1] - containerLoc[1]
        return Rect(left, top, left + (view.width * scale).roundToInt(), top + (view.height * scale).roundToInt())
    }

    override fun copy(): ControllerChangeHandler =
        CoverReturnChangeHandler().also {
            it.headerCover = headerCover
            it.gridCard = gridCard
        }

    private companion object {
        /** Share of the flight, at its end, over which the cell's badge and read button fade in. */
        const val DECORATION_FADE = 0.3f
    }
}
