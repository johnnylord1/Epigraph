package eu.kanade.tachiyomi.ui.base

import android.content.Context
import android.util.AttributeSet
import android.view.Gravity
import android.view.MenuItem
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.widget.SearchView
import androidx.core.graphics.ColorUtils
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import com.google.android.material.textview.MaterialTextView
import androidx.appcompat.R as appcompatR
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.util.system.contextCompatDrawable
import eu.kanade.tachiyomi.util.system.getResourceColor

class FloatingToolbar @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    BaseToolbar(context, attrs) {

    private val actionColorAlpha = ColorUtils.setAlphaComponent(context.getResourceColor(R.attr.actionBarTintColor), 200)
    private val actionColorAlphaSecondary = ColorUtils.setAlphaComponent(context.getResourceColor(R.attr.actionBarTintColor), 150)

    private lateinit var toolbarsubTitle: TextView
    private lateinit var cardIncogImage: ImageView
    private val defStyleRes = com.google.android.material.R.style.Widget_Material3_Toolbar
    private val subtitleTextAppearance: Int

    /**
     * Some single-surface datasets (such as the unified Books library) render their category in
     * the list header and must never duplicate it inside the search pill. Keeping the rule in the
     * pill prevents late controller/view-state restoration from bringing a stale subtitle back.
     */
    var allowSubtitle: Boolean = true
        set(value) {
            field = value
            if (!value && ::toolbarsubTitle.isInitialized) setCustomSubtitle(null)
        }

    val isSearchExpanded: Boolean
        get() {
            return searchItem?.isActionViewExpanded == true
        }

    var searchQueryHint: CharSequence?
        get() {
            val searchView = searchItem?.actionView as? SearchView ?: return null
            return searchView.queryHint
        }
        set(value) {
            setQueryHint(value)
        }

    fun setQueryHint(query: CharSequence?, collapseSearch: Boolean = true) {
        val searchView = searchItem?.actionView as? SearchView ?: return
        val oldV = searchView.queryHint
        searchView.queryHint = query
        if (oldV != query && collapseSearch) {
            searchView.setQuery("", false)
            searchItem?.collapseActionView()
        }
    }

    val searchView: SearchView?
        get() {
            return searchItem?.actionView as? SearchView
        }

    val searchItem: MenuItem?
        get() {
            return menu.findItem(R.id.action_search)
        }

    init {
        val a = context.obtainStyledAttributes(
            attrs,
            appcompatR.styleable.Toolbar,
            0,
            defStyleRes,
        )
        subtitleTextAppearance = a.getResourceId(appcompatR.styleable.Toolbar_subtitleTextAppearance, 0)
        a.recycle()
    }
    override fun onFinishInflate() {
        super.onFinishInflate()
        toolbarTitle = findViewById<MaterialTextView>(R.id.card_title)
        toolbarTitle.setTextAppearance(titleTextAppearance)
        toolbarTitle.setTextColor(actionColorAlpha)

        toolbarsubTitle = findViewById<MaterialTextView>(R.id.card_subtitle)
        toolbarsubTitle.setTextAppearance(subtitleTextAppearance)
        toolbarsubTitle.setTextColor(actionColorAlphaSecondary)
        toolbarsubTitle.isVisible = false

        cardIncogImage = findViewById(R.id.card_incog_image)
        // Derive the incog glyph visibility from the (default-false) incognito flag on inflate so
        // it never lingers visible from the XML default before setIncognitoMode is first applied.
        setIcons()

        setNavigationIconTint(actionColorAlpha)
        collapseIcon = context.contextCompatDrawable(R.drawable.ic_arrow_back_24dp)?.apply {
            setTint(actionColorAlpha)
        }
        inflateMenu(R.menu.search)
    }

    override fun setSubtitle(resId: Int) {
        setCustomSubtitle(context.getString(resId))
    }

    override fun setSubtitle(subtitle: CharSequence?) {
        setCustomSubtitle(subtitle)
    }

    override fun setIcons() {
        cardIncogImage.isVisible = incognito
    }

    private fun setCustomSubtitle(title: CharSequence?) {
        val effectiveTitle = title.takeIf { allowSubtitle }
        toolbarsubTitle.isVisible = !effectiveTitle.isNullOrBlank()
        toolbarsubTitle.text = effectiveTitle
        super.setSubtitle(null)
    }

    override fun setCustomTitle(title: CharSequence?) {
        super.setCustomTitle(title)
        toolbarTitle.updateLayoutParams<LinearLayout.LayoutParams> {
            gravity = Gravity.START
        }
    }
}
