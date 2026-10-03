package epigraph.books.pdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.FrameLayout
import android.widget.ImageView
import kotlin.math.abs

/**
 * Small, engine-neutral page surface for the canonical Pdfium adapter.
 *
 * A separate PDF widget opening the file independently of [PdfReaderAdapter] made password,
 * progress and native page access diverge. This surface only displays the bitmap produced by the
 * already-open Pdfium session. It keeps zoom/pan and page-swipe gestures without owning a second
 * PDF document handle.
 */
class PdfPageView(context: Context) : FrameLayout(context) {
    private val image = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        // Not clickable: a clickable child fills this view and would consume every touch, so
        // onTouchEvent below (page swipe, pinch zoom, pan, long press) would never run.
        isClickable = false
        isFocusable = false
    }
    private var bitmap: Bitmap? = null
    private var scale = 1f
    private var lastX = 0f
    private var lastY = 0f
    private var horizontalPaging = false
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            scale = (scale * detector.scaleFactor).coerceIn(1f, 5f)
            image.scaleX = scale
            image.scaleY = scale
            return true
        }

        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            image.pivotX = detector.focusX
            image.pivotY = detector.focusY
            return true
        }
    })
    private val gestureDetector = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent): Boolean = true

        override fun onLongPress(event: MotionEvent) {
            onLongPress?.invoke()
        }

        override fun onFling(
            first: MotionEvent?,
            second: MotionEvent,
            velocityX: Float,
            velocityY: Float,
        ): Boolean {
            // A fling on a zoomed page pans it; it must not turn the page.
            if (scale > 1f) return false
            val horizontal = abs(velocityX) >= abs(velocityY)
            // Horizontal page turns work in every mode; vertical flings page only in vertical mode.
            if (!horizontal && horizontalPaging) return false
            val velocity = if (horizontal) velocityX else velocityY
            if (abs(velocity) < MIN_FLING_VELOCITY) return false
            onPageSwipe?.invoke(if (velocity < 0f) 1 else -1)
            return true
        }
    })

    var onPageSwipe: ((delta: Int) -> Unit)? = null
    var onLongPress: (() -> Unit)? = null

    init {
        addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        setBackgroundColor(android.graphics.Color.BLACK)
        isClickable = true
    }

    fun setBitmap(value: Bitmap?) {
        if (bitmap !== value) bitmap?.recycle()
        bitmap = value
        image.setImageBitmap(value)
        resetScale()
    }

    /** Applies reader-local presentation settings without opening another PDF document. */
    fun setReaderOptions(fitMode: String, nightMode: Boolean, horizontalPaging: Boolean) {
        image.scaleType = if (fitMode == PDF_FIT_ACTUAL) {
            ImageView.ScaleType.CENTER
        } else {
            // Preserve the page aspect ratio while fitting it to the viewport.
            ImageView.ScaleType.FIT_CENTER
        }
        this.horizontalPaging = horizontalPaging
        image.colorFilter = if (nightMode) {
            ColorMatrixColorFilter(ColorMatrix(floatArrayOf(
                -1f, 0f, 0f, 0f, 255f,
                0f, -1f, 0f, 0f, 255f,
                0f, 0f, -1f, 0f, 255f,
                0f, 0f, 0f, 1f, 0f,
            )))
        } else {
            null
        }
        // Letterbox with the page colour, as the two-page spread does, instead of black bands.
        setBackgroundColor(if (nightMode) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
        invalidate()
    }

    fun resetScale() {
        scale = 1f
        image.scaleX = 1f
        image.scaleY = 1f
        image.translationX = 0f
        image.translationY = 0f
    }

    fun recycle() {
        setBitmap(null)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        if (!scaleDetector.isInProgress && scale > 1f) {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = event.x
                    lastY = event.y
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.x - lastX
                    val dy = event.y - lastY
                    image.translationX += dx
                    image.translationY += dy
                    lastX = event.x
                    lastY = event.y
                }
            }
        }
        if (event.actionMasked == MotionEvent.ACTION_UP) performClick()
        return true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    companion object {
        private const val PDF_FIT_ACTUAL = "actual"
        private const val MIN_FLING_VELOCITY = 650f
    }
}
