package eu.kanade.tachiyomi.ui.library

import android.content.Context
import android.util.AttributeSet
import android.view.View
import eu.kanade.tachiyomi.widget.AutofitRecyclerView

class LibraryRecyclerView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    AutofitRecyclerView(context, attrs) {

    override fun onWindowVisibilityChanged(visibility: Int) {
        super.onWindowVisibilityChanged(visibility)
        // Screen-off need not detach the recycler. Finish again on return for updates queued hidden.
        itemAnimator?.endAnimations()
    }

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        // Retained Library tabs can be hidden by an ancestor while reading or navigating.
        itemAnimator?.endAnimations()
    }
}
