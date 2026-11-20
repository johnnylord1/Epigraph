package epigraph.reader

import android.app.Activity
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Moon+ Reader style brightness control: a vertical drag that starts on the left edge of the
 * screen raises (up) or lowers (down) the reader brightness.
 *
 * Values use the readers' shared brightness scale, -75..100 (negative values dim below the
 * panel minimum with a black overlay; 0 means "system brightness" and is skipped while
 * dragging). The owning activity feeds every touch event to [handle] from
 * `dispatchTouchEvent` before its own logic:
 *
 * - a touch that starts in the edge zone holds its first few movements back from the content
 *   until its direction is known, so the content never scrolls under the gesture;
 * - a vertical drag claims the gesture: the content gets an `ACTION_CANCEL` and [preview]
 *   applies each new value; the value is handed to [commit] on release;
 * - taps, long presses (text selection) and horizontal swipes reach the content as before.
 */
class EdgeBrightnessGesture(
    private val activity: Activity,
    private val isEnabled: () -> Boolean,
    /** The reader's current custom value, or null when it follows the system brightness. */
    private val currentValue: () -> Int?,
    private val preview: (Int) -> Unit,
    private val commit: (Int) -> Unit,
) {
    private val touchSlop = ViewConfiguration.get(activity).scaledTouchSlop
    private val longPressTimeout = ViewConfiguration.getLongPressTimeout().toLong()

    private var tracking = false
    private var dragging = false
    private var downX = 0f
    private var downY = 0f
    private var downTime = 0L
    private var anchorY = 0f
    private var anchorValue = 0
    private var lastValue = 0
    private var indicator: BrightnessLevelView? = null
    private val hideIndicator = Runnable { indicator?.visibility = View.GONE }

    /**
     * Returns true when [event] belongs to the brightness gesture (or is held back while its
     * direction is undecided) and must not be dispatched to the content. [cancelContent]
     * receives an `ACTION_CANCEL` copy when the gesture is claimed mid-stream.
     */
    fun handle(event: MotionEvent, cancelContent: (MotionEvent) -> Unit): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                dragging = false
                tracking = startsInEdgeZone(event) && isEnabled()
                if (tracking) {
                    downX = event.x
                    downY = event.y
                    downTime = event.eventTime
                }
                return false
            }
            MotionEvent.ACTION_MOVE -> {
                if (!tracking) return false
                if (dragging) {
                    update(event.y)
                    return true
                }
                val dx = abs(event.x - downX)
                val dy = abs(event.y - downY)
                if (event.eventTime - downTime >= longPressTimeout && dy < touchSlop) {
                    // A long press (text selection, long-tap action) owns this touch.
                    tracking = false
                    return false
                }
                if (dy > touchSlop && dy > dx * DIRECTION_RATIO) {
                    dragging = true
                    anchorY = event.y
                    anchorValue = (currentValue() ?: systemValue()).coerceIn(MIN_VALUE, MAX_VALUE)
                    lastValue = anchorValue
                    val cancel = MotionEvent.obtain(event).apply { action = MotionEvent.ACTION_CANCEL }
                    cancelContent(cancel)
                    cancel.recycle()
                    showIndicator(anchorValue)
                    return true
                }
                if (dx > touchSlop) {
                    tracking = false
                    return false
                }
                return true
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (!dragging) tracking = false
                return dragging
            }
            MotionEvent.ACTION_UP,
            MotionEvent.ACTION_CANCEL,
            -> {
                val claimed = dragging
                if (claimed) {
                    commit(lastValue)
                    indicator?.removeCallbacks(hideIndicator)
                    indicator?.postDelayed(hideIndicator, INDICATOR_LINGER_MS)
                }
                tracking = false
                dragging = false
                return claimed
            }
        }
        return dragging
    }

    private fun startsInEdgeZone(event: MotionEvent): Boolean {
        val root = activity.window.decorView
        val width = root.width
        val height = root.height
        if (width <= 0 || height <= 0) return false
        val edgeWidth = minOf(EDGE_WIDTH_DP * root.resources.displayMetrics.density, width * MAX_EDGE_FRACTION)
        // Leave the status bar / notification shade and the gesture bar alone.
        return event.x <= edgeWidth &&
            event.y >= height * VERTICAL_EXCLUSION_FRACTION &&
            event.y <= height * (1f - VERTICAL_EXCLUSION_FRACTION)
    }

    private fun update(y: Float) {
        val height = activity.window.decorView.height.takeIf { it > 0 } ?: return
        val delta = (anchorY - y) / (height * FULL_RANGE_HEIGHT_FRACTION) * (MAX_VALUE - MIN_VALUE)
        var value = (anchorValue + delta).roundToInt().coerceIn(MIN_VALUE, MAX_VALUE)
        // 0 would hand control back to the system brightness mid-drag and make the screen jump.
        if (value == 0) value = if (delta >= 0f) 1 else -1
        if (value == lastValue) return
        lastValue = value
        preview(value)
        showIndicator(value)
    }

    private fun systemValue(): Int {
        val raw = runCatching {
            Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_BRIGHTNESS)
        }.getOrDefault(128)
        return (raw * 100 / 255).coerceIn(1, MAX_VALUE)
    }

    private fun showIndicator(value: Int) {
        val view = indicator ?: createIndicator() ?: return
        view.removeCallbacks(hideIndicator)
        view.value = value
        if (view.visibility != View.VISIBLE) placeAtBottom(view)
        view.visibility = View.VISIBLE
        view.bringToFront()
    }

    /** Keeps the pill clear of the navigation bar and the reader's page number. */
    private fun placeAtBottom(view: View) {
        val params = view.layoutParams as? FrameLayout.LayoutParams ?: return
        val navBar = ViewCompat.getRootWindowInsets(view)
            ?.getInsets(WindowInsetsCompat.Type.navigationBars())?.bottom ?: 0
        val margin = navBar + (INDICATOR_BOTTOM_MARGIN_DP * view.resources.displayMetrics.density).roundToInt()
        if (params.bottomMargin != margin) {
            params.bottomMargin = margin
            view.layoutParams = params
        }
    }

    private fun createIndicator(): BrightnessLevelView? {
        val parent = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
        val view = BrightnessLevelView(activity).apply { visibility = View.GONE }
        parent.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL,
            ),
        )
        indicator = view
        return view
    }

    companion object {
        const val MIN_VALUE = -75
        const val MAX_VALUE = 100

        /** Width of the touch strip along the left edge; capped on narrow windows. */
        private const val EDGE_WIDTH_DP = 28f
        private const val MAX_EDGE_FRACTION = 0.08f
        private const val VERTICAL_EXCLUSION_FRACTION = 0.06f
        private const val DIRECTION_RATIO = 1.5f

        /** Dragging this share of the screen height sweeps the whole -75..100 range. */
        private const val FULL_RANGE_HEIGHT_FRACTION = 0.8f
        private const val INDICATOR_LINGER_MS = 700L
        private const val INDICATOR_BOTTOM_MARGIN_DP = 30f
    }
}
