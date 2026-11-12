package epigraph.books.pdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Matrix
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.FrameLayout
import android.widget.ImageView
import kotlin.math.abs
import kotlin.math.min

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
    private var fitMode = PDF_FIT_BOTH

    /** Bitmap pixels to screen pixels at the page's physical size; bitmaps are capped below it. */
    private var actualScale = 1f
    private var fitScale = 1f

    /** How far the fitted page passes the view, which a drag reaches when it is not zoomed. */
    private var overflowX = 0f
    private var overflowY = 0f
    private var panX = 0f
    private var panY = 0f
    private var panXAtDown = 0f
    private var panYAtDown = 0f
    private val pageMatrix = Matrix()
    private val scaleDetector = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            scale = (scale * detector.scaleFactor).coerceIn(1f, 5f)
            image.scaleX = scale
            image.scaleY = scale
            // Zooming out brings the edges back in; the page must not stay off to one side.
            image.translationX = clampZoomPan(image.translationX, image.pivotX, width)
            image.translationY = clampZoomPan(image.translationY, image.pivotY, height)
            return true
        }

        override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
            // Zoom around what is under the fingers, without moving what is on screen right now.
            val pivotX = (detector.focusX - image.translationX - image.pivotX * (1f - scale)) / scale
            val pivotY = (detector.focusY - image.translationY - image.pivotY * (1f - scale)) / scale
            image.translationX += (image.pivotX - pivotX) * (1f - scale)
            image.translationY += (image.pivotY - pivotY) * (1f - scale)
            image.pivotX = pivotX
            image.pivotY = pivotY
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
            // A page wider than the view pans first; the page turns from its edge.
            val pan = if (horizontal) panXAtDown else panYAtDown
            val overflow = if (horizontal) overflowX else overflowY
            if (if (velocity < 0f) pan < overflow else pan > 0f) return false
            onPageSwipe?.invoke(if (velocity < 0f) 1 else -1)
            return true
        }
    })

    var onPageSwipe: ((delta: Int) -> Unit)? = null
    var onLongPress: (() -> Unit)? = null

    init {
        image.scaleType = ImageView.ScaleType.MATRIX
        addView(image, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        setBackgroundColor(android.graphics.Color.BLACK)
        isClickable = true
    }

    fun setBitmap(value: Bitmap?, actualScale: Float = 1f) {
        if (bitmap !== value) bitmap?.recycle()
        bitmap = value
        this.actualScale = actualScale
        image.setImageBitmap(value)
        resetScale()
        fitPage()
    }

    /** Applies reader-local presentation settings without opening another PDF document. */
    fun setReaderOptions(fitMode: String, nightMode: Boolean, horizontalPaging: Boolean) {
        this.fitMode = fitMode
        fitPage()
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

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        fitPage()
    }

    /** Sizes the page for the fit mode and starts at its top left corner. */
    private fun fitPage() {
        val page = bitmap ?: return
        if (width <= 0 || height <= 0) return
        val toWidth = width.toFloat() / page.width
        val toHeight = height.toFloat() / page.height
        fitScale = when (fitMode) {
            PDF_FIT_WIDTH -> toWidth
            PDF_FIT_HEIGHT -> toHeight
            PDF_FIT_ACTUAL -> actualScale
            else -> min(toWidth, toHeight)
        }
        overflowX = (page.width * fitScale - width).coerceAtLeast(0f)
        overflowY = (page.height * fitScale - height).coerceAtLeast(0f)
        panX = 0f
        panY = 0f
        placePage()
    }

    private fun placePage() {
        val page = bitmap ?: return
        pageMatrix.setScale(fitScale, fitScale)
        pageMatrix.postTranslate(
            if (overflowX > 0f) -panX else (width - page.width * fitScale) / 2f,
            if (overflowY > 0f) -panY else (height - page.height * fitScale) / 2f,
        )
        image.imageMatrix = pageMatrix
    }

    /** The shift that keeps the zoomed image covering the view, with [pivot] as its zoom centre. */
    private fun clampZoomPan(translation: Float, pivot: Float, size: Int): Float =
        translation.coerceIn(-(size - pivot) * (scale - 1f), pivot * (scale - 1f))

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        gestureDetector.onTouchEvent(event)
        if (scaleDetector.isInProgress) {
            // The finger left after a pinch would otherwise jump from where it last panned.
            lastX = event.x
            lastY = event.y
        } else {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    lastX = event.x
                    lastY = event.y
                    panXAtDown = panX
                    panYAtDown = panY
                }

                MotionEvent.ACTION_POINTER_UP -> {
                    // The finger that stays may not be the one followed so far.
                    val staying = if (event.actionIndex == 0) 1 else 0
                    lastX = event.getX(staying)
                    lastY = event.getY(staying)
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = event.x - lastX
                    val dy = event.y - lastY
                    // The zoom moves first; what it cannot take moves the page inside the view.
                    val zoomedX = clampZoomPan(image.translationX + dx, image.pivotX, width)
                    val zoomedY = clampZoomPan(image.translationY + dy, image.pivotY, height)
                    val leftX = dx - (zoomedX - image.translationX)
                    val leftY = dy - (zoomedY - image.translationY)
                    image.translationX = zoomedX
                    image.translationY = zoomedY
                    if (overflowX > 0f || overflowY > 0f) {
                        panX = (panX - leftX / scale).coerceIn(0f, overflowX)
                        panY = (panY - leftY / scale).coerceIn(0f, overflowY)
                        placePage()
                    }
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
        private const val PDF_FIT_WIDTH = "width"
        private const val PDF_FIT_HEIGHT = "height"
        private const val PDF_FIT_BOTH = "both"
        private const val PDF_FIT_ACTUAL = "actual"
        private const val MIN_FLING_VELOCITY = 650f
    }
}
