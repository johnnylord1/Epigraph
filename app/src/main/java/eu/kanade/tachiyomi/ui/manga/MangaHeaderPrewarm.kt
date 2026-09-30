package eu.kanade.tachiyomi.ui.manga

import android.app.Activity
import android.os.Handler
import android.os.Looper
import android.os.MessageQueue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.R

/**
 * Keeps one inflated manga details header ready for the next details screen.
 *
 * The header is ~40 views and inflating it was the largest main-thread cost of opening a details
 * screen, landing on the first frame of the push transition. It is inflated instead while the app
 * is idle (after the splash is gone, and after a details screen has been popped) and handed to the
 * next [MangaDetailsAdapter]. Owned by the activity, so the cached view never outlives the context
 * it was inflated with; a configuration change recreates the activity and with it this cache.
 */
class MangaHeaderPrewarm(private val activity: Activity) {

    private val handler = Handler(Looper.getMainLooper())
    private var view: View? = null
    private var scheduled = false

    private val idle = MessageQueue.IdleHandler {
        inflate()
        false
    }
    private val enqueueIdle = Runnable { Looper.myQueue().addIdleHandler(idle) }

    fun schedule(delayMs: Long) {
        if (view != null || scheduled) return
        scheduled = true
        handler.postDelayed(enqueueIdle, delayMs)
    }

    /** The prepared header for [parent], or null when none is ready or it was built for another context. */
    fun take(parent: ViewGroup): View? {
        val prepared = view ?: return null
        view = null
        return prepared.takeIf { parent.context === activity && it.parent == null }
    }

    fun clear() {
        handler.removeCallbacks(enqueueIdle)
        Looper.myQueue().removeIdleHandler(idle)
        scheduled = false
        view = null
    }

    private fun inflate() {
        scheduled = false
        if (view != null || activity.isFinishing || activity.isDestroyed) return
        view = try {
            // A RecyclerView parent gives the root the same layout params the adapter would; it
            // needs a layout manager to generate them.
            val parent = RecyclerView(activity).apply { layoutManager = LinearLayoutManager(activity) }
            LayoutInflater.from(activity).inflate(R.layout.manga_header_item, parent, false)
        } catch (e: Exception) {
            Logger.w(e) { "Could not prepare the manga details header" }
            null
        }
    }
}
