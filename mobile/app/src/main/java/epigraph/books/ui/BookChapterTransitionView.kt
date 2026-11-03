package epigraph.books.ui

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.ColorInt
import androidx.core.graphics.ColorUtils
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.util.system.dpToPx

/**
 * The novel reader's chapter transition card ("Finished / Next", "Previous / Current") for the
 * EPUB scroll flow. Readium shows one spine resource at a time, so the card is drawn natively at
 * the chapter edge instead of inside the chapter document.
 */
class BookChapterTransitionView(context: Context) : FrameLayout(context) {

    /** One label/title pair; a missing chapter shows the outlined notice instead. */
    data class Row(val label: String, val title: String?)

    /** The novel card keeps its rows at most 460px wide and left aligned. */
    private val rows = object : LinearLayout(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val cap = MAX_CONTENT_WIDTH_DP.dpToPx
            val spec = if (MeasureSpec.getSize(widthMeasureSpec) > cap) {
                MeasureSpec.makeMeasureSpec(cap, MeasureSpec.EXACTLY)
            } else {
                widthMeasureSpec
            }
            super.onMeasure(spec, heightMeasureSpec)
        }
    }.apply { orientation = LinearLayout.VERTICAL }

    init {
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        addView(rows, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT, Gravity.START))
    }

    fun bind(
        top: Row,
        bottom: Row,
        missing: String,
        @ColorInt foreground: Int,
        @ColorInt background: Int,
    ) {
        rows.removeAllViews()
        setBackgroundColor(background)
        rows.addView(rowView(top, missing, foreground))
        rows.addView(
            rowView(bottom, missing, foreground),
            LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                topMargin = ROW_GAP_DP.dpToPx
            },
        )
        contentDescription = listOf(top, bottom).joinToString(". ") { row ->
            row.title?.let { "${row.label}: $it" } ?: missing
        }
    }

    private fun rowView(row: Row, missing: String, @ColorInt foreground: Int): View {
        val title = row.title ?: return noticeView(missing, foreground)
        return LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                TextView(context).apply {
                    text = row.label
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, LABEL_SIZE_SP)
                    typeface = weighted(500)
                    setTextColor(ColorUtils.setAlphaComponent(foreground, (255 * 0.8f).toInt()))
                },
                LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
                    bottomMargin = 4.dpToPx
                },
            )
            addView(
                TextView(context).apply {
                    text = title
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, TITLE_SIZE_SP)
                    typeface = weighted(600)
                    setTextColor(foreground)
                    maxLines = 3
                    ellipsize = TextUtils.TruncateAt.END
                },
            )
        }
    }

    private fun noticeView(text: String, @ColorInt foreground: Int): View =
        LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(16.dpToPx, 12.dpToPx, 16.dpToPx, 12.dpToPx)
            background = GradientDrawable().apply {
                cornerRadius = 12.dpToPx.toFloat()
                setStroke(1.dpToPx, foreground)
            }
            addView(
                ImageView(context).apply {
                    setImageResource(R.drawable.ic_info_outline_24dp)
                    imageTintList = ColorStateList.valueOf(foreground)
                },
                LinearLayout.LayoutParams(20.dpToPx, 20.dpToPx).apply { marginEnd = 12.dpToPx },
            )
            addView(
                TextView(context).apply {
                    this.text = text
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, LABEL_SIZE_SP)
                    setTextColor(foreground)
                },
                LinearLayout.LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f),
            )
        }

    private fun weighted(weight: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Typeface.create(Typeface.DEFAULT, weight, false)
        } else {
            if (weight >= 600) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
        }

    private companion object {
        const val ROW_GAP_DP = 24
        const val MAX_CONTENT_WIDTH_DP = 460
        const val LABEL_SIZE_SP = 15f
        const val TITLE_SIZE_SP = 22f
    }
}
