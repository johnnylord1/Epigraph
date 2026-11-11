package eu.kanade.tachiyomi.ui.library

import android.app.Activity
import android.app.Application
import android.view.ContextThemeWrapper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.recyclerview.widget.RecyclerView
import eu.kanade.tachiyomi.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode

@RunWith(RobolectricTestRunner::class)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], application = Application::class, manifest = Config.NONE)
class LibraryRecyclerViewTest {

    @Test
    fun screenOffFinishesPendingCardMoves() = forEachLibraryGrid { recycler ->
        val holder = pendingMove(recycler)

        recycler.dispatchWindowVisibilityChanged(View.GONE)

        assertSettled(recycler, holder)
    }

    @Test
    fun unlockFinishesMovesQueuedWhileWindowWasHidden() = forEachLibraryGrid { recycler ->
        recycler.dispatchWindowVisibilityChanged(View.GONE)
        val holder = pendingMove(recycler)

        recycler.dispatchWindowVisibilityChanged(View.VISIBLE)

        assertSettled(recycler, holder)
    }

    @Test
    fun hidingLibraryFinishesPendingCardMoves() = forEachLibraryGrid { recycler ->
        val holder = pendingMove(recycler)

        recycler.visibility = View.GONE

        assertSettled(recycler, holder)
    }

    @Test
    fun returningToHiddenLibraryFinishesNewlyQueuedMoves() = forEachLibraryGrid { recycler ->
        val parent = recycler.parent as View
        parent.visibility = View.GONE
        val holder = pendingMove(recycler)

        parent.visibility = View.VISIBLE

        assertSettled(recycler, holder)
    }

    @Test
    fun visibleLibraryKeepsCardMoveAnimations() = forEachLibraryGrid { recycler ->
        val holder = pendingMove(recycler)

        assertTrue(recycler.itemAnimator!!.isRunning)
        assertEquals(-240f, holder.itemView.translationX, 0f)
        assertEquals(-360f, holder.itemView.translationY, 0f)
        recycler.itemAnimator!!.endAnimations()
    }

    private fun pendingMove(recycler: RecyclerView): RecyclerView.ViewHolder {
        val holder = recycler.getChildViewHolder(recycler.getChildAt(0))
        holder.setIsRecyclable(false)
        assertTrue(
            recycler.itemAnimator!!.animatePersistence(
                holder,
                RecyclerView.ItemAnimator.ItemHolderInfo().apply {
                    left = 0
                    top = 0
                },
                RecyclerView.ItemAnimator.ItemHolderInfo().apply {
                    left = 240
                    top = 360
                },
            ),
        )
        return holder
    }

    private fun assertSettled(recycler: RecyclerView, holder: RecyclerView.ViewHolder) {
        assertEquals(0f, holder.itemView.translationX, 0f)
        assertEquals(0f, holder.itemView.translationY, 0f)
        assertEquals(1f, holder.itemView.alpha, 0f)
        assertFalse(recycler.itemAnimator!!.isRunning)
        assertTrue(holder.isRecyclable)
    }

    private fun forEachLibraryGrid(block: (RecyclerView) -> Unit) {
        for (layout in listOf(R.layout.library_grid_recycler, R.layout.library_pager_page)) {
            val activityController = Robolectric.buildActivity(Activity::class.java).setup().visible()
            val context = ContextThemeWrapper(activityController.get(), R.style.Theme_Tachiyomi)
            val recycler = LayoutInflater.from(context).inflate(layout, null) as RecyclerView
            val container = FrameLayout(context).apply { addView(recycler) }
            activityController.get().setContentView(container)
            recycler.adapter = object : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
                override fun getItemCount() = 4
                override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) = Unit
                override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
                    object : RecyclerView.ViewHolder(View(parent.context).apply {
                        layoutParams = RecyclerView.LayoutParams(240, 360)
                    }) {}
            }
            recycler.measure(
                View.MeasureSpec.makeMeasureSpec(960, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(1440, View.MeasureSpec.EXACTLY),
            )
            recycler.layout(0, 0, 960, 1440)
            try {
                block(recycler)
            } finally {
                recycler.itemAnimator?.endAnimations()
                activityController.pause().stop().destroy()
            }
        }
    }
}
