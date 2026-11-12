package epigraph.books.pdf

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorMatrix
import android.graphics.ColorMatrixColorFilter
import android.graphics.Rect
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import eu.kanade.tachiyomi.ui.reader.viewer.webtoon.WebtoonFrame
import eu.kanade.tachiyomi.ui.reader.viewer.webtoon.WebtoonRecyclerView
import eu.kanade.tachiyomi.util.system.dpToPx
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A PDF as one vertical column of pages, scrolled and flung freely like the novel reader's
 * document. Built on the webtoon reader's recycler and frame, which bring the pinch zoom, and
 * sized up front from the page dimensions so that positions do not move as pages render.
 */
class PdfContinuousView(
    context: Context,
    private val scope: CoroutineScope,
    private val renderer: PdfPageBitmapRenderer,
    private val aspects: FloatArray,
    private val fitMode: String,
    /** Width of the page the reader opens on at its physical size, for "Tamanho real". */
    private val actualPageWidth: Int,
    private val nightMode: Boolean,
    private val cropBorders: Boolean,
    private val onPageChanged: (page: Int) -> Unit,
    private val onSettled: (page: Int, offset: Double) -> Unit,
    private val onLongPress: () -> Unit,
    private val firstPage: Int,
) {

    private val cache = object : LruCache<Int, Bitmap>(
        min(Runtime.getRuntime().maxMemory() / 6, MAX_CACHE_BYTES).toInt(),
    ) {
        override fun sizeOf(key: Int, value: Bitmap): Int = value.allocationByteCount
    }

    private val layoutManager = object : LinearLayoutManager(context) {
        // Keeps the neighbouring pages rendered, so a fling does not run into blank ones.
        override fun calculateExtraLayoutSpace(state: RecyclerView.State, extraLayoutSpace: IntArray) {
            extraLayoutSpace[0] = height
            extraLayoutSpace[1] = height
        }
    }

    private val recycler = WebtoonRecyclerView(context).apply {
        layoutManager = this@PdfContinuousView.layoutManager
        adapter = PageAdapter()
        itemAnimator = null
        setHasFixedSize(true)
        setBackgroundColor(if (nightMode) Color.BLACK else PAGE_GAP_COLOR)
        addItemDecoration(
            object : RecyclerView.ItemDecoration() {
                override fun getItemOffsets(outRect: Rect, view: View, parent: RecyclerView, state: RecyclerView.State) {
                    if (parent.getChildAdapterPosition(view) > 0) outRect.top = PAGE_GAP_DP.dpToPx
                }
            },
        )
        longTapListener = {
            onLongPress()
            true
        }
        addOnScrollListener(
            object : RecyclerView.OnScrollListener() {
                override fun onScrolled(recyclerView: RecyclerView, dx: Int, dy: Int) = reportPage()

                override fun onScrollStateChanged(recyclerView: RecyclerView, newState: Int) {
                    if (newState == RecyclerView.SCROLL_STATE_IDLE) reportSettled()
                }
            },
        )
        addOnLayoutChangeListener { _, left, _, right, _, oldLeft, _, oldRight, _ ->
            // Slot heights follow the width, so a rotation sizes every page again.
            if (right - left != oldRight - oldLeft && oldRight != oldLeft) {
                val page = currentPage
                post {
                    adapter?.notifyDataSetChanged()
                    applyFitZoom()
                    scrollToPage(page)
                }
            } else if (oldRight == oldLeft) {
                post { applyFitZoom() }
            }
        }
    }

    /** The reader mounts this; the recycler has to stay the frame's first child. */
    val root: View = WebtoonFrame(context).apply {
        addView(
            recycler,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        doubleTapZoom = false
    }

    private var currentPage = -1

    val isSettling: Boolean get() = recycler.scrollState == RecyclerView.SCROLL_STATE_SETTLING
    val isZoomed: Boolean get() = recycler.scaleX > 1.01f

    /** What is on screen, in the column's own units: zoom shows less of it. */
    val height: Int get() = (recycler.height / recycler.scaleY).toInt()

    fun scrollToPage(page: Int, offset: Double = 0.0) {
        recycler.stopScroll()
        currentPage = page
        val position = page.coerceIn(0, (aspects.size - 1).coerceAtLeast(0))
        // Before the first layout there is no width yet; the offset is applied once there is.
        recycler.post {
            alignZoomedColumnTop()
            layoutManager.scrollToPositionWithOffset(position, -(offset * slotHeight(position)).roundToInt())
        }
    }

    fun smoothScrollBy(distance: Int) = recycler.smoothScrollBy(0, distance)

    fun release() {
        recycler.stopScroll()
        recycler.adapter = null
        cache.evictAll()
    }

    /** The child at the middle of the screen, which zoom and pan move away from the column's. */
    private fun centerChild(): View? = recycler.findChildViewUnder(
        recycler.width / 2f,
        recycler.height / 2f - recycler.translationY / recycler.scaleY,
    )

    private fun centerPage(): Int {
        val child = centerChild() ?: return currentPage
        return recycler.getChildAdapterPosition(child).takeIf { it != RecyclerView.NO_POSITION } ?: currentPage
    }

    private fun reportPage() {
        val page = centerPage()
        if (page < 0 || page == currentPage) return
        currentPage = page
        onPageChanged(page)
    }

    private fun reportSettled() {
        val child = centerChild() ?: return
        val page = recycler.getChildAdapterPosition(child).takeIf { it != RecyclerView.NO_POSITION } ?: return
        val offset = if (child.height > 0) (-child.top.toDouble() / child.height).coerceIn(0.0, 1.0) else 0.0
        onSettled(page, offset)
    }

    /**
     * The column is as wide as the screen, so a page larger than that is the column zoomed in,
     * panned with the same gestures as a pinch. Fitting the height never goes below 1: a page
     * that fits in width first is letterboxed in its slot instead.
     */
    private fun fitZoom(): Float {
        val width = recycler.width
        val viewport = recycler.height
        if (width <= 0 || viewport <= 0) return 1f
        val zoom = when (fitMode) {
            PDF_FIT_HEIGHT -> viewport / (width * aspects.getOrElse(firstPage) { 1f })
            PDF_FIT_ACTUAL -> actualPageWidth.toFloat() / width
            else -> 1f
        }
        return zoom.coerceIn(1f, MAX_FIT_ZOOM)
    }

    private fun applyFitZoom() {
        if (fitMode != PDF_FIT_HEIGHT && fitMode != PDF_FIT_ACTUAL) return
        recycler.onScale(fitZoom() / recycler.scaleX)
        recycler.x = recycler.width / 2f * (recycler.scaleX - 1f)
        alignZoomedColumnTop()
    }

    /** A column zoomed around its center hides its top; a page opened there has to show. */
    private fun alignZoomedColumnTop() {
        recycler.y = recycler.height / 2f * (recycler.scaleY - 1f)
    }

    private fun slotHeight(page: Int): Int {
        val width = recycler.width.coerceAtLeast(1)
        val viewport = recycler.height.takeIf { it > 0 } ?: width
        val natural = (width * aspects.getOrElse(page) { 1f }).roundToInt().coerceAtLeast(1)
        return when (fitMode) {
            PDF_FIT_HEIGHT -> (viewport / fitZoom()).roundToInt()
            PDF_FIT_BOTH -> min(natural, viewport)
            else -> natural
        }
    }

    private inner class PageHolder(val image: ImageView) : RecyclerView.ViewHolder(image) {
        var job: Job? = null
    }

    private inner class PageAdapter : RecyclerView.Adapter<PageHolder>() {
        override fun getItemCount(): Int = aspects.size

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): PageHolder {
            val image = ImageView(parent.context).apply {
                scaleType = ImageView.ScaleType.FIT_CENTER
                setBackgroundColor(if (nightMode) Color.BLACK else Color.WHITE)
                colorFilter = if (nightMode) ColorMatrixColorFilter(ColorMatrix(NIGHT_MATRIX)) else null
                layoutParams = RecyclerView.LayoutParams(RecyclerView.LayoutParams.MATCH_PARENT, 1)
            }
            return PageHolder(image)
        }

        override fun onBindViewHolder(holder: PageHolder, position: Int) {
            holder.job?.cancel()
            val slot = slotHeight(position)
            holder.image.layoutParams = holder.image.layoutParams.apply { height = slot }
            val cached = cache.get(position)
            holder.image.setImageBitmap(cached)
            if (cached != null) return
            val maxDimension = (max(recycler.width, slot) * RENDER_SCALE * fitZoom()).toInt()
                .coerceAtMost(MAX_RENDER_DIMENSION)
            holder.job = scope.launch {
                val bitmap = withContext(Dispatchers.IO) {
                    renderer.renderPageBitmap(position, maxDimension)
                        ?.let { if (cropBorders) PdfBorderCrop.crop(it) else it }
                } ?: return@launch
                cache.put(position, bitmap)
                if (cropBorders && bitmap.width > 0) {
                    aspects[position] = bitmap.height.toFloat() / bitmap.width
                    holder.image.layoutParams = holder.image.layoutParams.apply { height = slotHeight(position) }
                }
                holder.image.setImageBitmap(bitmap)
            }
        }

        override fun onViewRecycled(holder: PageHolder) {
            holder.job?.cancel()
            holder.job = null
            holder.image.setImageDrawable(null)
        }
    }

    private companion object {
        const val PDF_FIT_HEIGHT = "height"
        const val PDF_FIT_BOTH = "both"
        const val PDF_FIT_ACTUAL = "actual"

        /** The zoom the recycler stops at. */
        const val MAX_FIT_ZOOM = 3f
        const val PAGE_GAP_DP = 6
        const val PAGE_GAP_COLOR = 0xFFDDDDDD.toInt()
        const val RENDER_SCALE = 1.5f
        const val MAX_RENDER_DIMENSION = 2_800
        const val MAX_CACHE_BYTES = 96L * 1024 * 1024
        val NIGHT_MATRIX = floatArrayOf(
            -1f, 0f, 0f, 0f, 255f,
            0f, -1f, 0f, 0f, 255f,
            0f, 0f, -1f, 0f, 255f,
            0f, 0f, 0f, 1f, 0f,
        )
    }
}
