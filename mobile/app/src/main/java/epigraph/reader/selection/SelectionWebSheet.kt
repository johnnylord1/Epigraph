package epigraph.reader.selection

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.PopupMenu
import androidx.core.net.toUri
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import co.touchlab.kermit.Logger
import com.google.android.material.bottomsheet.BottomSheetBehavior
import eu.kanade.tachiyomi.databinding.SelectionWebSheetBinding
import eu.kanade.tachiyomi.util.system.openInBrowser
import eu.kanade.tachiyomi.util.system.setDefaultSettings
import eu.kanade.tachiyomi.widget.E2EBottomSheetDialog
import yokai.i18n.MR
import yokai.util.lang.getString

/**
 * Reader-neutral in-app selection lookup surface.
 *
 * This used to live under the novel package even though EPUB and PDF readers also use it. The
 * sheet intentionally remains a small shared surface: it owns only the lookup WebView and never
 * receives novel-specific state or credentials.
 */
class SelectionWebSheet(
    private val activity: Activity,
    private val url: String,
    private val query: String,
) : E2EBottomSheetDialog<SelectionWebSheetBinding>(activity) {

    private var webView: WebView? = null

    override fun createBinding(inflater: LayoutInflater) = SelectionWebSheetBinding.inflate(inflater)

    override fun onStart() {
        super.onStart()
        val screenHeight = activity.window.decorView.height.takeIf { it > 0 }
            ?: activity.resources.displayMetrics.heightPixels
        val sheetHeight = (screenHeight * 0.85f).toInt()
        (binding.root.parent as? ViewGroup)?.updateLayoutParams { height = sheetHeight }
        sheetBehavior.peekHeight = sheetHeight
        sheetBehavior.skipCollapsed = true
        sheetBehavior.state = BottomSheetBehavior.STATE_EXPANDED
        webView?.onResume()
    }

    init {
        binding.queryText.text = query
        val created = buildWebView()
        webView = created
        binding.webContainer.addView(
            created,
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT,
        )
        binding.closeButton.setOnClickListener { dismiss() }
        binding.overflowButton.setOnClickListener { view -> showOverflow(view) }
        setOnDismissListener { destroyWebView() }
        created.loadUrl(url)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView = WebView(activity).apply {
        setDefaultSettings()
        settings.setSupportMultipleWindows(false)
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView?,
                request: WebResourceRequest?,
            ): Boolean {
                val target = request?.url?.toString() ?: return false
                if (!target.startsWith("http://") && !target.startsWith("https://")) return true
                view?.loadUrl(target)
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.progress.progress = newProgress
                binding.progress.isVisible = newProgress < 100
            }
        }
    }

    private fun showOverflow(anchor: View) {
        PopupMenu(activity, anchor).apply {
            menu.add(0, MENU_OPEN_EXTERNAL, 0, activity.getString(MR.strings.novel_selection_open_external))
            setOnMenuItemClickListener { item ->
                if (item.itemId == MENU_OPEN_EXTERNAL) {
                    openExternally()
                    true
                } else {
                    false
                }
            }
            show()
        }
    }

    private fun openExternally() {
        val current = webView?.url ?: url
        try {
            activity.openInBrowser(current)
        } catch (_: Throwable) {
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, current.toUri())) }
        }
        dismiss()
    }

    private fun destroyWebView() {
        val current = webView ?: return
        webView = null
        try {
            current.stopLoading()
            current.loadUrl("about:blank")
            (current.parent as? ViewGroup)?.removeView(current)
            current.removeAllViews()
            current.destroy()
        } catch (error: Throwable) {
            Logger.w { "SelectionWebSheet: WebView teardown failed: ${error.message}" }
        }
    }

    override fun onStop() {
        super.onStop()
        webView?.onPause()
    }

    private companion object {
        const val MENU_OPEN_EXTERNAL = 1
    }
}

/** Encodes [query] and shows the in-app lookup sheet. */
fun showSelectionWebSheet(activity: Activity, url: String, query: String) {
    SelectionWebSheet(activity, url, query).show()
}
