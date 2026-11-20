package epigraph.reader

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.view.View
import androidx.core.content.ContextCompat
import eu.kanade.tachiyomi.R
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Slim feedback pill for [EdgeBrightnessGesture], shown near the bottom of the reader: a small
 * sun, a thin horizontal level line spanning the whole -75..100 range and the current value.
 * A tick marks 0 (system brightness); the part of the line left of it is the dimming range,
 * filled in a fainter tone.
 */
internal class BrightnessLevelView(context: Context) : View(context) {

    var value: Int = 0
        set(v) {
            if (field == v) return
            field = v
            invalidate()
        }

    private val density = resources.displayMetrics.density

    private val preferredWidth = dp(200f)
    private val pillHeight = dp(24f)
    private val paddingH = dp(10f)
    private val iconSize = dp(12f)
    private val gap = dp(8f)
    private val lineHeight = dp(2.5f)

    /**
     * Opaque so the text under it never shows through: novels, PDFs and comics fill the whole screen,
     * so the pill usually sits over content. The hairline keeps it visible on dark themes.
     */
    private val pillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(0x1C, 0x1C, 0x20) }
    private val outlinePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(1f)
        color = Color.argb(0x2E, 0xFF, 0xFF, 0xFF)
    }
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(0x40, 0xFF, 0xFF, 0xFF) }
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(0xEE, 0xFF, 0xFF, 0xFF) }
    private val dimFillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(0x80, 0xFF, 0xFF, 0xFF) }
    private val tickPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(0x99, 0xFF, 0xFF, 0xFF)
        strokeWidth = dp(1.5f)
        strokeCap = Paint.Cap.ROUND
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = Color.argb(0xEE, 0xFF, 0xFF, 0xFF)
        textAlign = Paint.Align.RIGHT
        textSize = 11f * density * resources.configuration.fontScale
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    }

    /** Fixed so the line does not shift while the number changes width. */
    private val textWidth = textPaint.measureText("−75%")

    private val icon = ContextCompat.getDrawable(context, R.drawable.ic_brightness_day_24dp)?.mutate()?.apply {
        setTint(Color.WHITE)
    }
    private val rect = RectF()

    init {
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val width = resolveSize(preferredWidth.roundToInt(), widthMeasureSpec)
        setMeasuredDimension(width, pillHeight.roundToInt())
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val h = height.toFloat()
        val cy = h / 2f
        rect.set(0f, 0f, w, h)
        canvas.drawRoundRect(rect, h / 2f, h / 2f, pillPaint)
        val inset = outlinePaint.strokeWidth / 2f
        rect.inset(inset, inset)
        canvas.drawRoundRect(rect, h / 2f - inset, h / 2f - inset, outlinePaint)

        var x = paddingH
        icon?.let {
            it.setBounds(x.roundToInt(), (cy - iconSize / 2f).roundToInt(), (x + iconSize).roundToInt(), (cy + iconSize / 2f).roundToInt())
            it.alpha = if (value > 0) 0xEE else 0x99
            it.draw(canvas)
        }
        x += iconSize + gap

        val textRight = w - paddingH
        val lineLeft = x
        val lineRight = textRight - textWidth - gap
        if (lineRight > lineLeft) drawLevel(canvas, lineLeft, lineRight, cy)

        val metrics = textPaint.fontMetrics
        canvas.drawText(label(value), textRight, cy - (metrics.ascent + metrics.descent) / 2f, textPaint)
    }

    private fun drawLevel(canvas: Canvas, left: Float, right: Float, cy: Float) {
        val span = right - left
        val radius = lineHeight / 2f
        val top = cy - radius
        val bottom = cy + radius
        rect.set(left, top, right, bottom)
        canvas.drawRoundRect(rect, radius, radius, trackPaint)

        val levelX = left + span * fraction(value)
        val zeroX = left + span * fraction(0)
        if (value > 0) {
            rect.set(left, top, zeroX, bottom)
            canvas.drawRoundRect(rect, radius, radius, dimFillPaint)
            rect.set(zeroX - radius, top, levelX, bottom)
            canvas.drawRoundRect(rect, radius, radius, fillPaint)
        } else {
            rect.set(left, top, levelX.coerceAtLeast(left + lineHeight), bottom)
            canvas.drawRoundRect(rect, radius, radius, dimFillPaint)
        }
        val tickHalf = dp(4f)
        canvas.drawLine(zeroX, cy - tickHalf, zeroX, cy + tickHalf, tickPaint)
    }

    private fun fraction(v: Int): Float {
        val min = EdgeBrightnessGesture.MIN_VALUE
        val max = EdgeBrightnessGesture.MAX_VALUE
        return (v.coerceIn(min, max) - min).toFloat() / (max - min)
    }

    private fun label(v: Int) = if (v >= 0) "$v%" else "−${abs(v)}%"

    private fun dp(v: Float) = v * density
}
