package epigraph.ui.motion

import android.graphics.Rect
import android.graphics.drawable.BitmapDrawable
import android.view.View
import android.view.ViewOverlay
import androidx.core.view.drawToBitmap
import eu.kanade.tachiyomi.R
import kotlin.math.roundToInt

/**
 * The unread badge and the read button of a library cell, redrawn above a flying cover ghost.
 * The ghost lives in the container overlay, above every screen, so on its own it covers both
 * while it leaves or lands on its cell. These copies ride the ghost at the same spot of the cover
 * and fade out on the way to Detalhes or in on the way back.
 */
internal class CoverDecorations private constructor(private val parts: List<Part>) {

    private class Part(
        val view: View,
        val image: BitmapDrawable,
        val width: Int,
        val height: Int,
        // Centre of the decoration as a fraction of the card, so it follows the cover as it resizes.
        val fx: Float,
        val fy: Float,
        val alpha: Float,
    )

    /** Draws the copies above the ghost (overlay drawables paint over overlay views) and hides the real ones. */
    fun attach(overlay: ViewOverlay) {
        parts.forEach {
            overlay.add(it.image)
            it.view.alpha = 0f
        }
    }

    /** Lays the copies over [ghost], in container coordinates, at [alpha]. */
    fun place(ghost: Rect, alpha: Float) {
        parts.forEach {
            val left = ghost.left + (ghost.width() * it.fx).roundToInt() - it.width / 2
            val top = ghost.top + (ghost.height() * it.fy).roundToInt() - it.height / 2
            it.image.setBounds(left, top, left + it.width, top + it.height)
            it.image.alpha = (alpha.coerceIn(0f, 1f) * 255).roundToInt()
        }
    }

    fun detach(overlay: ViewOverlay) {
        parts.forEach {
            overlay.remove(it.image)
            it.view.alpha = it.alpha
        }
    }

    companion object {
        private val IDS = listOf(R.id.unread_download_badge, R.id.play_button)

        /** Snapshots the visible decorations of the cell holding [card]; none when it is not a library cell. */
        fun of(card: View): CoverDecorations {
            val cell = card.parent as? View ?: return CoverDecorations(emptyList())
            if (card.width == 0 || card.height == 0) return CoverDecorations(emptyList())
            val cardLoc = IntArray(2).also(card::getLocationInWindow)
            val loc = IntArray(2)
            val parts = IDS.mapNotNull { id ->
                val view = cell.findViewById<View?>(id)
                    ?.takeIf { it.isShown && it.alpha > 0f && it.width > 0 && it.height > 0 }
                    ?: return@mapNotNull null
                val bitmap = runCatching { view.drawToBitmap() }.getOrNull() ?: return@mapNotNull null
                view.getLocationInWindow(loc)
                Part(
                    view = view,
                    image = BitmapDrawable(view.resources, bitmap),
                    width = view.width,
                    height = view.height,
                    fx = (loc[0] - cardLoc[0] + view.width / 2f) / card.width,
                    fy = (loc[1] - cardLoc[1] + view.height / 2f) / card.height,
                    alpha = view.alpha,
                )
            }
            return CoverDecorations(parts)
        }
    }
}
