package epigraph.books.pdf

import android.content.Context
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import android.widget.FrameLayout
import kotlin.math.hypot

/**
 * Pinch zoom and pan over a single child, for the two-page spread: two pages side by side are too
 * small to read on a phone without it. Touches on an unzoomed child pass through untouched, so
 * its long press keeps opening the page's text selection.
 */
class PdfZoomFrame(context: Context) : FrameLayout(context) {
    private var scale = 1f
    private var lastX = 0f
    private var lastY = 0f
    private var pinched = false
    private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
    private val content: View? get() = getChildAt(0)

    /** This gesture belongs to the zoom, so it must not turn the page when it ends. */
    val holdsGesture: Boolean get() = scale > 1f || pinched

    private val scaleDetector = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                val view = content ?: return false
                // Zoom around what is under the fingers, without moving what is on screen now.
                val pivotX = (detector.focusX - view.translationX - view.pivotX * (1f - scale)) / scale
                val pivotY = (detector.focusY - view.translationY - view.pivotY * (1f - scale)) / scale
                view.translationX += (view.pivotX - pivotX) * (1f - scale)
                view.translationY += (view.pivotY - pivotY) * (1f - scale)
                view.pivotX = pivotX
                view.pivotY = pivotY
                return true
            }

            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val view = content ?: return false
                scale = (scale * detector.scaleFactor).coerceIn(1f, MAX_ZOOM)
                view.scaleX = scale
                view.scaleY = scale
                moveContent(view, 0f, 0f)
                return true
            }
        },
    )

    fun resetZoom() {
        scale = 1f
        content?.apply {
            scaleX = 1f
            scaleY = 1f
            translationX = 0f
            translationY = 0f
        }
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_DOWN) pinched = false
        return super.dispatchTouchEvent(event)
    }

    override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                lastX = event.x
                lastY = event.y
            }

            MotionEvent.ACTION_POINTER_DOWN -> {
                pinched = true
                return true
            }

            MotionEvent.ACTION_MOVE ->
                return scale > 1f && hypot(event.x - lastX, event.y - lastY) > touchSlop
        }
        return false
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        if (event.pointerCount > 1) pinched = true
        if (scaleDetector.isInProgress) {
            // The finger left after a pinch would otherwise jump from where it last panned.
            lastX = event.x
            lastY = event.y
            return true
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_UP -> {
                // The finger that stays may not be the one followed so far.
                val staying = if (event.actionIndex == 0) 1 else 0
                lastX = event.getX(staying)
                lastY = event.getY(staying)
            }

            MotionEvent.ACTION_MOVE -> {
                content?.let { moveContent(it, event.x - lastX, event.y - lastY) }
                lastX = event.x
                lastY = event.y
            }
        }
        return true
    }

    /** Moves the zoomed child, which always keeps covering this frame. */
    private fun moveContent(view: View, dx: Float, dy: Float) {
        view.translationX = (view.translationX + dx)
            .coerceIn(-(width - view.pivotX) * (scale - 1f), view.pivotX * (scale - 1f))
        view.translationY = (view.translationY + dy)
            .coerceIn(-(height - view.pivotY) * (scale - 1f), view.pivotY * (scale - 1f))
    }

    private companion object {
        const val MAX_ZOOM = 5f
    }
}
