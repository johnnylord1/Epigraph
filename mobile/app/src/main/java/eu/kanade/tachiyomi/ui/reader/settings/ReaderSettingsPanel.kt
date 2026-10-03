package eu.kanade.tachiyomi.ui.reader.settings

import android.app.Activity
import android.content.Context
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.core.widget.NestedScrollView
import androidx.viewpager.widget.PagerAdapter
import com.google.android.material.tabs.TabLayout
import dev.icerock.moko.resources.StringResource
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.databinding.TabbedBottomSheetBinding
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.rootWindowInsetsCompat
import yokai.i18n.MR
import yokai.util.lang.getString
import kotlin.math.roundToInt

/**
 * In-reader settings content mounted inside the reader's existing chapter sheet.
 *
 * The tab pages are still created by the canonical Epigraph settings sheets. This class only owns
 * the presentation host: it deliberately does not create a dialog window, so opening Settings
 * expands the fixed reader HUD instead of stacking a second surface over the reader.
 */
class ReaderSettingsPanel(
    context: Context,
    private val activity: Activity,
    private val views: List<View>,
    private val titles: List<StringResource>,
    private val onOpenGlobalSettings: () -> Unit,
    private val onResetDefaults: () -> Unit,
) : FrameLayout(context) {

    private val binding = TabbedBottomSheetBinding.inflate(LayoutInflater.from(context), this, true)

    init {
        // The existing reader HUD is the bottom-sheet host.  The panel itself must be measured
        // from the selected page; MATCH_PARENT here makes even a three-row General tab occupy the
        // whole reader and hides the content behind a blank surface.
        layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)
        val windowHeight = activity.window.decorView.height.takeIf { it > 0 }
            ?: resources.displayMetrics.heightPixels
        val topInset = activity.window.decorView.rootWindowInsetsCompat
            ?.getInsets(WindowInsetsCompat.Type.systemBars())?.top ?: 0
        binding.pager.maxHeight = ((windowHeight - topInset - 125.dpToPx) * 0.82f)
            .roundToInt()
            .coerceAtLeast(360.dpToPx)
        binding.pager.currentPageView = views.firstOrNull()
        binding.pager.offscreenPageLimit = 2
        binding.pager.adapter = object : PagerAdapter() {
            override fun getCount(): Int = views.size

            override fun isViewFromObject(view: View, item: Any): Boolean = view === item

            override fun instantiateItem(container: ViewGroup, position: Int): Any {
                val view = views[position]
                if (view.parent !== container) {
                    (view.parent as? ViewGroup)?.removeView(view)
                    container.addView(view)
                }
                return view
            }

            override fun destroyItem(container: ViewGroup, position: Int, item: Any) {
                (item as? View)?.let(container::removeView)
            }

            override fun getPageTitle(position: Int): CharSequence =
                activity.getString(titles[position])
        }
        binding.tabs.setupWithViewPager(binding.pager)
        binding.tabs.tabMode = TabLayout.MODE_SCROLLABLE
        binding.tabs.tabGravity = TabLayout.GRAVITY_START
        binding.menu.isVisible = true
        binding.menu.setImageResource(R.drawable.ic_outline_settings_24dp)
        binding.menu.contentDescription = context.getString(MR.strings.reader_settings)
        binding.menu.setOnClickListener { onOpenGlobalSettings() }
        binding.resetDefaults.isVisible = true
        binding.resetDefaults.contentDescription = context.getString(R.string.epigraph_reader_reset_defaults)
        binding.resetDefaults.setOnClickListener { onResetDefaults() }
        setNestedScrollState(0)
        views.filterIsInstance<ReaderFilterView>().forEach { it.setWindowBrightness() }
        binding.tabs.addOnTabSelectedListener(
            object : TabLayout.OnTabSelectedListener {
                override fun onTabSelected(tab: TabLayout.Tab?) {
                    val position = tab?.position ?: 0
                    binding.pager.currentPageView = views.getOrNull(position)
                    setNestedScrollState(position)
                    views.getOrNull(position)?.let { it as? ReaderFilterView }?.setWindowBrightness()
                }

                override fun onTabUnselected(tab: TabLayout.Tab?) = Unit

                override fun onTabReselected(tab: TabLayout.Tab?) {
                    val position = tab?.position ?: 0
                    binding.pager.currentPageView = views.getOrNull(position)
                    setNestedScrollState(position)
                    views.getOrNull(position)?.let { it as? ReaderFilterView }?.setWindowBrightness()
                }
            },
        )
    }

    private fun setNestedScrollState(position: Int) {
        views.forEachIndexed { index, view ->
            (view as? NestedScrollView)?.apply {
                isNestedScrollingEnabled = index == position
                requestLayout()
            }
        }
    }

    /** Refreshes tab labels after the comic viewer changes between paged and webtoon modes. */
    fun refreshTabTitles() {
        for (index in titles.indices) {
            binding.tabs.getTabAt(index)?.text = activity.getString(titles[index])
        }
    }
}
