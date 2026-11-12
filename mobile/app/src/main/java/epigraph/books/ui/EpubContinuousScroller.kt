package epigraph.books.ui

import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.WebView
import android.widget.OverScroller
import androidx.viewpager.widget.ViewPager
import org.readium.r2.navigator.pager.R2RTLViewPager
import org.readium.r2.navigator.preferences.ReadingProgression
import org.readium.r2.shared.InternalReadiumApi
import java.lang.reflect.Method
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The EPUB scroll flow as one continuous column, as the novel reader's document is. Readium keeps
 * each spine resource in its own WebView on a horizontal pager, so one pixel of finger movement
 * here scrolls the current WebView and, past its edge, slides the neighbouring resource in below
 * it with the transition card between them. The resource becomes Readium's current one halfway
 * through that seam, without any pager animation.
 *
 * Nothing snaps: a release keeps the column exactly where it is, or flings it onward.
 */
internal class EpubContinuousScroller(
    private val pager: ViewPager,
    private val card: View?,
    /** Binds the card between chapter [lower] and the next one; returns its height, 0 for no card. */
    private val bindBoundary: (lower: Int) -> Int,
    private val onScrolled: () -> Unit,
    /** The column moved on past the end of [chapter], which a chapter too short to scroll needs. */
    private val onChapterPassed: (chapter: Int) -> Unit,
) {

    private val configuration = ViewConfiguration.get(pager.context)
    private val minFlingVelocity = configuration.scaledMinimumFlingVelocity.toFloat()
    private val maxFlingVelocity = configuration.scaledMaximumFlingVelocity.toFloat()
    private val scroller = OverScroller(pager.context)

    /** Column distance past the current resource's edge; positive reveals what follows it. */
    private var seam = 0f
    private var inSeam = false
    private var seamDirection = 0
    private var gap = 0
    private var lower = 0

    /** Sub-pixel finger movement the integer WebView scroll offset has not taken yet. */
    private var webRemainder = 0f
    private var committing = false

    private var lastScrollerY = 0
    private var motionRunning = false
    private val motionRunner = object : Runnable {
        override fun run() {
            if (!motionRunning) return
            if (!scroller.computeScrollOffset()) {
                motionRunning = false
                return
            }
            val y = scroller.currY
            val delta = y - lastScrollerY
            lastScrollerY = y
            if (delta != 0) consume(delta.toFloat())
            if (motionRunning) pager.postOnAnimation(this)
        }
    }

    private var velocityTracker: VelocityTracker? = null
    private var activePointerId = MotionEvent.INVALID_POINTER_ID
    private var lastTouchY = 0f

    private val pageListener = object : ViewPager.SimpleOnPageChangeListener() {
        // A commit below moves the pager on purpose; anything else (go, TTS, links) restarts here.
        override fun onPageSelected(position: Int) {
            if (!committing) reset()
        }
    }
    private val layoutListener = View.OnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
        if (right - left != oldRight - oldLeft || bottom - top != oldBottom - oldTop) {
            reset()
        } else if (inSeam) {
            applySeam()
        }
    }
    private val scrollListener = ViewTreeObserver.OnScrollChangedListener { onScrolled() }

    init {
        pager.addOnPageChangeListener(pageListener)
        pager.addOnLayoutChangeListener(layoutListener)
        pager.viewTreeObserver.addOnScrollChangedListener(scrollListener)
    }

    fun release() {
        abortMotion()
        velocityTracker?.recycle()
        velocityTracker = null
        pager.removeOnPageChangeListener(pageListener)
        pager.removeOnLayoutChangeListener(layoutListener)
        pager.viewTreeObserver.takeIf { it.isAlive }?.removeOnScrollChangedListener(scrollListener)
    }

    /** Stops a running fling; returns whether one was running, so that touch does not also tap. */
    fun stopMotion(): Boolean {
        val running = motionRunning
        abortMotion()
        return running
    }

    fun beginDrag(event: MotionEvent) {
        abortMotion()
        velocityTracker?.recycle()
        velocityTracker = VelocityTracker.obtain().also { it.addMovement(event) }
        activePointerId = event.getPointerId(event.actionIndex)
        lastTouchY = event.getY(event.actionIndex)
    }

    fun drag(event: MotionEvent) {
        velocityTracker?.addMovement(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_POINTER_DOWN -> {
                activePointerId = event.getPointerId(event.actionIndex)
                lastTouchY = event.getY(event.actionIndex)
            }
            MotionEvent.ACTION_POINTER_UP -> if (event.getPointerId(event.actionIndex) == activePointerId) {
                val other = if (event.actionIndex == 0) 1 else 0
                activePointerId = event.getPointerId(other)
                lastTouchY = event.getY(other)
            }
            MotionEvent.ACTION_MOVE -> {
                val index = event.findPointerIndex(activePointerId)
                if (index < 0) return
                val y = event.getY(index)
                val delta = lastTouchY - y
                lastTouchY = y
                consume(delta)
            }
        }
    }

    fun endDrag(event: MotionEvent, cancelled: Boolean) {
        val tracker = velocityTracker ?: return
        if (!cancelled) {
            tracker.addMovement(event)
            tracker.computeCurrentVelocity(1000, maxFlingVelocity)
            val velocity = tracker.getYVelocity(activePointerId)
            if (abs(velocity) >= minFlingVelocity) fling(-velocity)
        }
        tracker.recycle()
        velocityTracker = null
        activePointerId = MotionEvent.INVALID_POINTER_ID
    }

    /** Animates the column by [distance] pixels, the same way across chapter edges. */
    fun smoothBy(distance: Int) {
        abortMotion()
        lastScrollerY = 0
        scroller.startScroll(0, 0, 0, distance, SMOOTH_SCROLL_MS)
        startMotion()
    }

    /** The spine resource the column is in, which Readium reports only after settling on it. */
    val currentChapter: Int
        get() = pager.currentItem

    /** Position within the current chapter, or null while its document is still loading. */
    fun chapterProgress(): Float? {
        val web = webViewAt(0)?.takeIf(::isReady) ?: return null
        val max = maxScroll(web)
        return if (max <= 0) 1f else (web.scrollY.toFloat() / max).coerceIn(0f, 1f)
    }

    /** Moves within the current chapter, the only range the progress bar covers. */
    fun seek(fraction: Float) {
        reset()
        val web = webViewAt(0)?.takeIf(::isReady) ?: return
        web.scrollTo(0, (fraction.coerceIn(0f, 1f) * maxScroll(web)).roundToInt())
    }

    fun reset() {
        abortMotion()
        webRemainder = 0f
        clearSeam()
    }

    private fun fling(velocity: Float) {
        abortMotion()
        lastScrollerY = 0
        scroller.fling(0, 0, 0, velocity.roundToInt(), 0, 0, -FLING_RANGE, FLING_RANGE)
        startMotion()
    }

    private fun startMotion() {
        motionRunning = true
        pager.postOnAnimation(motionRunner)
    }

    private fun abortMotion() {
        motionRunning = false
        pager.removeCallbacks(motionRunner)
        scroller.abortAnimation()
    }

    private fun consume(delta: Float) {
        var remaining = delta
        var passes = 0
        while (remaining != 0f && passes++ < MAX_CONSUME_PASSES) {
            if (!inSeam) {
                val web = webViewAt(0)?.takeIf(::isReady)
                if (web == null) {
                    abortMotion()
                    return
                }
                val max = maxScroll(web)
                val exact = web.scrollY + webRemainder + remaining
                if (exact in 0f..max.toFloat()) {
                    val target = exact.toInt()
                    webRemainder = exact - target
                    if (target != web.scrollY) web.scrollTo(0, target)
                    return
                }
                val direction = if (exact < 0f) -1 else 1
                val edge = if (direction > 0) max else 0
                if (web.scrollY != edge) web.scrollTo(0, edge)
                webRemainder = 0f
                remaining = exact - edge
                if (!enterSeam(direction)) {
                    abortMotion()
                    return
                }
            } else {
                val next = seam + remaining
                if (next * seamDirection <= 0f) {
                    // Back over the seam: what is left scrolls the current chapter again.
                    remaining = next
                    clearSeam()
                    continue
                }
                seam = next
                remaining = 0f
                if (neighbourExists(seamDirection)) {
                    commitIfPastMiddle()
                } else if (abs(seam) >= gap) {
                    // The book's edge: the card stays fully shown, nothing follows it.
                    seam = (gap * seamDirection).toFloat()
                    abortMotion()
                }
                applySeam()
            }
        }
    }

    private fun neighbourExists(direction: Int): Boolean =
        pager.currentItem + direction in 0 until (pager.adapter?.count ?: 0)

    private fun enterSeam(direction: Int): Boolean {
        val exists = neighbourExists(direction)
        if (exists) {
            // A resource still loading holds the column at this edge until it can be shown.
            val neighbour = webViewAt(direction)?.takeIf(::isReady) ?: return false
            neighbour.scrollTo(0, if (direction > 0) 0 else maxScroll(neighbour))
        }
        val boundary = if (direction > 0) pager.currentItem else pager.currentItem - 1
        val height = bindBoundary(boundary)
        if (!exists && height == 0) return false
        lower = boundary
        gap = height
        seam = 0f
        seamDirection = direction
        inSeam = true
        card?.visibility = if (gap > 0) View.VISIBLE else View.GONE
        applySeam()
        return true
    }

    /** Readium's current resource follows the one filling most of the screen. */
    private fun commitIfPastMiddle() {
        val span = pager.height + gap
        if (abs(seam) <= span / 2f) return
        val direction = seamDirection
        if (direction > 0) onChapterPassed(pager.currentItem)
        committing = true
        pager.setCurrentItem(pager.currentItem + direction, false)
        committing = false
        seam -= direction * span
        seamDirection = -direction
    }

    private fun applySeam() {
        val span = pager.height + gap
        for (index in 0 until pager.childCount) {
            val child = pager.getChildAt(index)
            // A resource the pager has only just attached is placed by the next layout pass.
            if (child.width == 0) continue
            child.translationX = (pager.scrollX - child.left).toFloat()
            child.translationY = pageOffset(child) * span - seam
        }
        card?.translationY = (lower - pager.currentItem) * span + pager.height - seam
    }

    private fun clearSeam() {
        inSeam = false
        seam = 0f
        seamDirection = 0
        gap = 0
        for (index in 0 until pager.childCount) {
            pager.getChildAt(index).apply {
                translationX = 0f
                translationY = 0f
            }
        }
        card?.visibility = View.GONE
    }

    /** Reading-order distance from the current resource; the pager's own layout is mirrored in RTL. */
    @OptIn(InternalReadiumApi::class)
    private fun pageOffset(child: View): Int {
        val width = pager.width.takeIf { it > 0 } ?: return 0
        val physical = ((child.left - pager.scrollX).toFloat() / width).roundToInt()
        val rtl = (pager as? R2RTLViewPager)?.direction == ReadingProgression.RTL
        return if (rtl) -physical else physical
    }

    private fun webViewAt(offset: Int): WebView? {
        for (index in 0 until pager.childCount) {
            val child = pager.getChildAt(index)
            if (child.width > 0 && pageOffset(child) == offset) findWebView(child)?.let { return it }
        }
        return null
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) findWebView(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun isReady(web: WebView): Boolean = web.progress == 100 && web.contentHeight > 0

    /**
     * The scroll range is protected on View, and nothing public gives it: contentHeight is not in
     * scrollY's units, and a scrollY past the real end moves no text until it comes back in range.
     */
    private fun maxScroll(web: WebView): Int =
        ((verticalScrollRange.invoke(web) as Int) - web.height).coerceAtLeast(0)

    private companion object {
        val verticalScrollRange: Method =
            View::class.java.getDeclaredMethod("computeVerticalScrollRange").apply { isAccessible = true }

        const val SMOOTH_SCROLL_MS = 250
        const val FLING_RANGE = 1_000_000
        const val MAX_CONSUME_PASSES = 8
    }
}
