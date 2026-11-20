package epigraph.reader

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import eu.kanade.tachiyomi.R
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
    private var indicator: TextView? = null
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
        // Leave the status bar / notification shade and the gesture bar alone.
        return event.x <= width * EDGE_FRACTION &&
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
        view.text = if (value > 0) "$value%" else "−${abs(value)}%"
        view.visibility = View.VISIBLE
        view.bringToFront()
    }

    private fun createIndicator(): TextView? {
        val parent = activity.findViewById<ViewGroup>(android.R.id.content) ?: return null
        val density = activity.resources.displayMetrics.density
        val view = TextView(activity).apply {
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
            gravity = Gravity.CENTER
            compoundDrawablePadding = (8 * density).roundToInt()
            val padH = (16 * density).roundToInt()
            val padV = (10 * density).roundToInt()
            setPadding(padH, padV, padH, padV)
            background = GradientDrawable().apply {
                cornerRadius = 24 * density
                setColor(Color.argb(0xCC, 0x20, 0x20, 0x20))
            }
            ContextCompat.getDrawable(activity, R.drawable.ic_brightness_day_24dp)?.mutate()?.let { icon ->
                icon.setTint(Color.WHITE)
                setCompoundDrawablesRelativeWithIntrinsicBounds(icon, null, null, null)
            }
            isClickable = false
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            elevation = 8 * density
            visibility = View.GONE
        }
        parent.addView(
            view,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER,
            ),
        )
        indicator = view
        return view
    }

    companion object {
        const val MIN_VALUE = -75
        const val MAX_VALUE = 100

        private const val EDGE_FRACTION = 0.15f
        private const val VERTICAL_EXCLUSION_FRACTION = 0.06f
        private const val DIRECTION_RATIO = 1.5f

        /** Dragging this share of the screen height sweeps the whole -75..100 range. */
        private const val FULL_RANGE_HEIGHT_FRACTION = 0.8f
        private const val INDICATOR_LINGER_MS = 600L
    }
}
