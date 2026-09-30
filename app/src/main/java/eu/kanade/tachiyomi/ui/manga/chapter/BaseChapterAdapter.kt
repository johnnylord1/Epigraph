package eu.kanade.tachiyomi.ui.manga.chapter

import eu.davidea.flexibleadapter.FlexibleAdapter
import eu.davidea.flexibleadapter.items.IFlexible
import eu.kanade.tachiyomi.data.database.models.Chapter

open class BaseChapterAdapter<T : IFlexible<*>>(
    obj: DownloadInterface,
) : FlexibleAdapter<T>(null, obj, true) {

    val baseDelegate = obj

    /**
     * Chapter lists run without an ItemAnimator and with stable ids, so rebinding reuses a swiped
     * ViewHolder in place and ItemTouchHelper never sees the detach it waits for to clear the
     * swiped-out row. Re-attaching the helper ends that pending recover animation and resets the
     * front view (ItemTouchHelperCallback.clearView) without touching the list layout.
     */
    protected fun releaseSwipedRow() {
        val helper = itemTouchHelper ?: return
        val recycler = recyclerView ?: return
        helper.attachToRecyclerView(null)
        helper.attachToRecyclerView(recycler)
    }

    interface DownloadInterface {
        fun downloadChapter(position: Int)
        fun startDownloadNow(position: Int)
    }

    interface GroupedDownloadInterface : DownloadInterface {
        fun downloadChapter(position: Int, chapter: Chapter)
        fun startDownloadNow(position: Int, chapter: Chapter)
    }
}
