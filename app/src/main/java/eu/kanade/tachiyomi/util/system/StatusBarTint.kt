package eu.kanade.tachiyomi.util.system

import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.view.View
import android.view.Window
import eu.kanade.tachiyomi.R

/**
 * The colour behind the status bar.
 *
 * Android 15+ ignores [Window.setStatusBarColor] for apps targeting API 35+ (edge-to-edge is
 * enforced), so scrolled content showed through the clock and icons. There the colour is drawn by
 * the scrim view registered with [registerStatusBarScrim]; older versions keep the window colour.
 */
@Suppress("DEPRECATION")
var Window.statusBarTint: Int
    get() = statusBarScrim()?.let { (it.background as? ColorDrawable)?.color ?: Color.TRANSPARENT }
        ?: statusBarColor
    set(value) {
        val scrim = statusBarScrim()
        if (scrim == null) {
            statusBarColor = value
        } else if ((scrim.background as? ColorDrawable)?.color != value) {
            scrim.setBackgroundColor(value)
        }
    }

/** Makes [scrim], a view covering the status bar area, draw [statusBarTint] on Android 15+. */
fun Window.registerStatusBarScrim(scrim: View) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) {
        decorView.setTag(R.id.status_bar_scrim, scrim)
    }
}

private fun Window.statusBarScrim(): View? = decorView.getTag(R.id.status_bar_scrim) as? View
