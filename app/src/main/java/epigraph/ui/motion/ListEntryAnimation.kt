package epigraph.ui.motion

import android.view.View
import android.view.animation.AlphaAnimation
import android.view.animation.Animation
import android.view.animation.AnimationSet
import android.view.animation.LayoutAnimationController
import android.view.animation.TranslateAnimation
import androidx.recyclerview.widget.RecyclerView
import eu.kanade.tachiyomi.R
import yokai.presentation.theme.Motion
import yokai.presentation.theme.ReducedMotion

/**
 * Staggered first-load entry for lists and grids (DESIGN.md §9 "Entrada de lista"): each visible
 * item fades in and rises `motion_list_offset`, 20ms after the previous one, capped at 10 steps so
 * a dense grid never takes longer than `dur-standard` + 180ms. Runs once per [RecyclerView]; a data
 * change before it ends simply lets the remaining items land.
 */
object ListEntryAnimation {
    fun runOnce(recycler: RecyclerView) {
        if (ReducedMotion.isEnabled()) return
        if (recycler.getTag(R.id.list_entry_played) == true) return
        recycler.setTag(R.id.list_entry_played, true)
        val offset = recycler.resources.getDimension(R.dimen.motion_list_offset)
        val item = AnimationSet(true).apply {
            addAnimation(AlphaAnimation(0f, 1f))
            addAnimation(TranslateAnimation(0f, 0f, offset, 0f))
            duration = Motion.DurStandard.toLong()
            interpolator = Motion.Interpolators.Enter
        }
        recycler.layoutAnimation = CappedStagger(item)
        // Drop the controller once it has played so later layouts (paging, filters) never replay it.
        recycler.layoutAnimationListener = object : Animation.AnimationListener {
            override fun onAnimationStart(animation: Animation?) = Unit
            override fun onAnimationRepeat(animation: Animation?) = Unit
            override fun onAnimationEnd(animation: Animation?) {
                recycler.layoutAnimation = null
                recycler.layoutAnimationListener = null
            }
        }
        recycler.scheduleLayoutAnimation()
    }

    /** Resets the one-shot guard, e.g. when the screen is re-created for a different source. */
    fun reset(recycler: RecyclerView) = recycler.setTag(R.id.list_entry_played, null)

    private class CappedStagger(animation: AnimationSet) :
        LayoutAnimationController(animation, Motion.StaggerStepMs.toFloat() / Motion.DurStandard) {
        override fun getDelayForView(view: View): Long {
            // super keeps the controller's end time (isDone) in step; the cap only shortens delays.
            super.getDelayForView(view)
            val params = view.layoutParams?.layoutAnimationParameters ?: return 0L
            return minOf(params.index, Motion.StaggerMaxItems - 1) * Motion.StaggerStepMs.toLong()
        }
    }
}
