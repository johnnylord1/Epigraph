package eu.kanade.tachiyomi.ui.manga

import android.content.Context
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.view.Gravity
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import com.google.android.material.R as materialR
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.getResourceColor

/**
 * The cover a details header shows when a title has no artwork: a 2:3 surface carrying the
 * content-type glyph, like the library's placeholder. The header cover sizes itself from its
 * drawable (adjustViewBounds), so without an intrinsic 2:3 size the card would collapse to nothing.
 */
object DetailsCoverPlaceholder {

    fun create(context: Context, @DrawableRes icon: Int = R.drawable.ic_book_24dp): Drawable {
        val surface = GradientDrawable().apply {
            setColor(context.getResourceColor(materialR.attr.colorSurfaceContainerHigh))
            setSize(100.dpToPx, 150.dpToPx)
        }
        val glyph = ContextCompat.getDrawable(context, icon)!!.mutate().apply {
            setTint(context.getResourceColor(android.R.attr.textColorSecondary))
        }
        return LayerDrawable(arrayOf(surface, glyph)).apply {
            setLayerGravity(1, Gravity.CENTER)
            setLayerSize(1, 32.dpToPx, 32.dpToPx)
        }
    }
}
