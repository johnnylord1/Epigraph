package eu.kanade.tachiyomi.widget

import android.app.Activity
import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.core.view.WindowInsetsCompat.Type.systemBars
import androidx.core.widget.NestedScrollView
import androidx.viewpager.widget.ViewPager
import com.google.android.material.tabs.TabLayout
import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.databinding.TabbedBottomSheetBinding
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.rootWindowInsetsCompat
import eu.kanade.tachiyomi.util.view.expand
import yokai.util.lang.getString
import kotlin.math.max

abstract class TabbedBottomSheetDialog(private val activity: Activity) :
    E2EBottomSheetDialog<TabbedBottomSheetBinding>(activity) {

    override fun createBinding(inflater: LayoutInflater) = TabbedBottomSheetBinding.inflate(inflater)

    open var offset = -1
    protected open val initialTab: Int = 0

    private var tabsInitialized = false

    init {
        val height = activity.window.decorView.rootWindowInsetsCompat!!.getInsets(systemBars()).top
        binding.pager.maxHeight = activity.window.decorView.height - height - 125.dpToPx
    }

    /**
     * Tab views belong to subclasses, so they must not be queried from this superclass'
     * constructor. Kotlin initializes subclass fields only after the superclass returns.
     * Initializing the pager on start keeps the existing Epigraph API while making sheets whose
     * tab list is held in a field (such as the local-book reader) safe.
     */
    private fun initializeTabs() {
        if (tabsInitialized) return
        val adapter = TabbedSheetAdapter()
        binding.pager.offscreenPageLimit = 2
        binding.pager.adapter = adapter
        binding.tabs.setupWithViewPager(binding.pager)
        binding.pager.currentItem = initialTab.coerceIn(0, (adapter.count - 1).coerceAtLeast(0))
        tabsInitialized = true
    }

    override fun onStart() {
        initializeTabs()
        super.onStart()
        // Reader settings are an explicitly opened surface.  It starts expanded, and this is
        // the only reader settings surface that accepts a downward drag to dismiss.  The
        // collapsed reader HUDs use their own BottomSheetBehavior and keep dragging disabled.
        sheetBehavior.isDraggable = true
        sheetBehavior.skipCollapsed = true
        sheetBehavior.expand()
        getTabViews().forEachIndexed { index, nestedScrollView ->
            val view = nestedScrollView as? NestedScrollView
            view?.isNestedScrollingEnabled = binding.pager.currentItem == index
            view?.requestLayout()
        }
        binding.tabs.addOnTabSelectedListener(
            object : TabLayout.OnTabSelectedListener {
                override fun onTabSelected(tab: TabLayout.Tab?) {
                    val view = getTabViews()[tab?.position ?: 0] as? NestedScrollView
                    view?.isNestedScrollingEnabled = true
                    view?.requestLayout()
                }

                override fun onTabUnselected(tab: TabLayout.Tab?) {
                    val view = getTabViews()[tab?.position ?: 0] as? NestedScrollView
                    view?.isNestedScrollingEnabled = false
                    view?.requestLayout()
                }

                override fun onTabReselected(tab: TabLayout.Tab?) {
                    val view = getTabViews()[tab?.position ?: 0] as? NestedScrollView
                    view?.isNestedScrollingEnabled = true
                    view?.requestLayout()
                }
            },
        )
    }

    abstract fun getTabViews(): List<View>

    abstract fun getTabTitles(): List<StringResource>

    private inner class TabbedSheetAdapter : ViewPagerAdapter() {

        override fun createView(container: ViewGroup, position: Int): View {
            return getTabViews()[position]
        }

        override fun getCount(): Int {
            return getTabViews().size
        }

        override fun getPageTitle(position: Int): CharSequence {
            return activity.getString(getTabTitles()[position])
        }
    }
}

class MeasuredViewPager @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) : ViewPager(context, attrs) {

    var maxHeight = 0
        set(value) {
            field = value
            requestLayout()
        }

    /**
     * Embedded reader settings only need to measure the selected page.  Measuring every
     * attached tab makes a short General tab inherit the height of a long Filters tab, leaving a
     * large empty sheet on first open.  Dialog based sheets keep the historical behaviour when
     * this is null.
     */
    var currentPageView: View? = null
        set(value) {
            field = value
            requestLayout()
        }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        var heightSpec = heightMeasureSpec
        super.onMeasure(widthMeasureSpec, heightSpec)
        var height = 0
        val childWidthSpec = MeasureSpec.makeMeasureSpec(
            max(0, MeasureSpec.getSize(widthMeasureSpec) - paddingLeft - paddingRight),
            MeasureSpec.getMode(widthMeasureSpec),
        )
        val children = currentPageView?.let { page ->
            if (page.parent === this) listOf(page) else emptyList()
        } ?: (0 until childCount).map(::getChildAt)
        for (child in children) {
            child.measure(childWidthSpec, MeasureSpec.UNSPECIFIED)
            val h = child.measuredHeight
            if (h > height) height = h
        }
        if (height != 0) {
            heightSpec = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
        }
        if (maxHeight < height + (rootWindowInsetsCompat?.getInsets(systemBars())?.bottom ?: 0)) {
            heightSpec = MeasureSpec.makeMeasureSpec(maxHeight, MeasureSpec.AT_MOST)
        }
        super.onMeasure(widthMeasureSpec, heightSpec)
    }
}
