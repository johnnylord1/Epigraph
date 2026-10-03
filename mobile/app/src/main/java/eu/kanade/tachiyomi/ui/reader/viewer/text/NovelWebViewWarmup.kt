package eu.kanade.tachiyomi.ui.reader.viewer.text

import android.content.Context
import android.os.Looper
import android.webkit.WebView
import co.touchlab.kermit.Logger

/**
 * Initialises the WebView provider ahead of the first novel chapter.
 *
 * Chromium's first init costs 0.3–1.5 s on the main thread. Doing it at app launch held the splash
 * that long on every cold start, for users who may never open a novel; doing it in the reader
 * made the chapter tap freeze instead. It runs once per process, when a novel's details screen has
 * finished opening and the main thread goes idle.
 */
object NovelWebViewWarmup {

    private var requested = false

    fun schedule(context: Context) {
        if (requested) return
        requested = true
        val app = context.applicationContext
        Looper.myQueue().addIdleHandler {
            try {
                WebView(app).destroy()
            } catch (e: Throwable) {
                Logger.w(e) { "Novel WebView warm-up failed" }
            }
            false
        }
    }
}
