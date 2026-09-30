package epigraph.ui.moment

import android.animation.Animator
import android.animation.AnimatorListenerAdapter
import android.animation.ValueAnimator
import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.annotation.DrawableRes
import androidx.core.content.ContextCompat
import androidx.core.content.getSystemService
import androidx.core.content.res.ResourcesCompat
import androidx.core.view.ViewCompat
import androidx.core.view.isVisible
import androidx.core.widget.TextViewCompat
import androidx.dynamicanimation.animation.DynamicAnimation
import androidx.dynamicanimation.animation.FloatPropertyCompat
import androidx.dynamicanimation.animation.SpringAnimation
import androidx.graphics.shapes.CornerRounding
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.MutableCubic
import androidx.graphics.shapes.RoundedPolygon
import androidx.graphics.shapes.circle
import androidx.graphics.shapes.star
import com.google.android.material.color.MaterialColors
import epigraph.ui.Haptics
import eu.kanade.tachiyomi.R
import yokai.presentation.theme.Motion
import yokai.presentation.theme.ReducedMotion
import kotlin.math.min
import kotlin.math.roundToInt

/** What a memorable moment shows: a seal icon, a title, an optional rolling count and a detail line. */
class MomentSpec(
    @param:DrawableRes val icon: Int,
    val title: CharSequence,
    val count: Int? = null,
    val detail: CharSequence? = null,
)

/**
 * The one memorable moment per flow (DESIGN.md §9): finished work, reading milestone, import done,
 * backup done. Five phases, each with one primary mover:
 *
 * 1. Anticipation (`dur-instant`): scrim and card fade in, the seal squashes to 0.85.
 * 2. Impulse (`spring-moment`): the seal springs to 1.0 with overshoot while morphing from a circle
 *    into an 8-petal flower.
 * 3. Peak (`dur-long`, starts when the seal first reaches full size): the icon draws in, the counter
 *    rolls up to its value, one `confirm` haptic.
 * 4. Settle (`spring-default`): the flower relaxes back into a circle; the detail line rises 8dp.
 * 5. Rest: stays until a tap or 2.4s (longer if accessibility asks), then fades out in `dur-quick`.
 *
 * A tap during any phase jumps to rest; a tap or back at rest dismisses. Under reduced motion the
 * final card simply fades in. The overlay lives in the activity content view, so it disappears with
 * the activity (rotation included) and never outlives it.
 */
object MomentOverlay {
    const val RestMillis = 2400

    fun show(activity: Activity, spec: MomentSpec) {
        if (activity.isFinishing || activity.isDestroyed) return
        val content = activity.findViewById<ViewGroup>(android.R.id.content) ?: return
        // One moment at a time; a second completion while one is on screen is dropped.
        if (content.findViewById<View>(R.id.moment_overlay) != null) return
        val overlay = MomentView(activity, spec)
        content.addView(overlay, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        overlay.play(reduced = ReducedMotion.isEnabled())
    }
}

private class MomentView(context: Context, private val spec: MomentSpec) : FrameLayout(context) {

    private enum class Phase { Idle, Anticipation, Impulse, Peak, Settle, Rest, Exiting }

    private var phase = Phase.Idle

    private val density = resources.displayMetrics.density
    private val listOffset = resources.getDimension(R.dimen.motion_list_offset)

    private val seal = SealView(context)
    private val title = TextView(context)
    private val counter = TextView(context)
    private val detail = TextView(context)
    private val card = LinearLayout(context)

    private val scrimAlpha = ResourcesCompat.getFloat(resources, R.dimen.scrim_alpha)

    private var entryAnimator: ValueAnimator? = null
    private var peakAnimator: ValueAnimator? = null
    private var exitAnimator: ValueAnimator? = null
    private val sealScale = SpringAnimation(seal, DynamicAnimation.SCALE_X)
    private val sealScaleY = SpringAnimation(seal, DynamicAnimation.SCALE_Y)
    private val morph = SpringAnimation(seal, SealView.MorphProgress)
    private val detailRise = SpringAnimation(detail, DynamicAnimation.TRANSLATION_Y)
    private val detailAlpha = SpringAnimation(detail, DynamicAnimation.ALPHA)

    private val counterChars = CharArray(11)
    private var shownCount = -1

    private val restTimeout = Runnable { dismiss() }

    private val backCallback = object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
            if (phase == Phase.Rest) dismiss() else jumpToRest()
        }
    }

    init {
        id = R.id.moment_overlay
        isClickable = true
        isFocusable = true
        setBackgroundColor(Color.BLACK)
        background.alpha = 0
        setOnClickListener { if (phase == Phase.Rest) dismiss() else jumpToRest() }

        val pad = resources.getDimensionPixelSize(R.dimen.space_3)
        card.orientation = LinearLayout.VERTICAL
        card.gravity = Gravity.CENTER_HORIZONTAL
        card.setPadding(pad, pad, pad, pad)
        card.background = GradientDrawable().apply {
            cornerRadius = resources.getDimension(R.dimen.radius_l)
            setColor(MaterialColors.getColor(this@MomentView, com.google.android.material.R.attr.colorSurfaceContainer))
        }
        card.alpha = 0f

        val sealSize = (96 * density).roundToInt()
        card.addView(seal, LinearLayout.LayoutParams(sealSize, sealSize))
        seal.bind(
            fill = MaterialColors.getColor(this, com.google.android.material.R.attr.colorSecondaryContainer),
            icon = ContextCompat.getDrawable(context, spec.icon)?.mutate()?.apply {
                setTint(MaterialColors.getColor(this@MomentView, com.google.android.material.R.attr.colorSecondary))
            },
            iconSize = (40 * density).roundToInt(),
        )

        val gap = resources.getDimensionPixelSize(R.dimen.space_2)
        TextViewCompat.setTextAppearance(title, R.style.TextAppearance_Epigraph_TitleL)
        title.gravity = Gravity.CENTER
        title.text = spec.title
        card.addView(title, wrapWithTop(gap))

        TextViewCompat.setTextAppearance(counter, R.style.TextAppearance_Epigraph_Display)
        counter.gravity = Gravity.CENTER
        counter.fontFeatureSettings = "tnum"
        counter.isVisible = spec.count != null
        card.addView(counter, wrapWithTop(resources.getDimensionPixelSize(R.dimen.space_1)))

        TextViewCompat.setTextAppearance(detail, R.style.TextAppearance_Epigraph_Body)
        detail.setTextColor(MaterialColors.getColor(this, android.R.attr.textColorSecondary))
        detail.gravity = Gravity.CENTER
        detail.text = spec.detail
        detail.isVisible = spec.detail != null
        card.addView(detail, wrapWithTop(resources.getDimensionPixelSize(R.dimen.space_1)))

        val maxWidth = (360 * density).roundToInt()
        val margin = resources.getDimensionPixelSize(R.dimen.space_3)
        val width = min(maxWidth, resources.displayMetrics.widthPixels - 2 * margin)
        addView(card, LayoutParams(width, LayoutParams.WRAP_CONTENT, Gravity.CENTER))

        sealScale.spring = Motion.Spring.Moment.force(1f)
        sealScaleY.spring = Motion.Spring.Moment.force(1f)
        morph.spring = Motion.Spring.Moment.force(1f)
        morph.setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_SCALE)
        detailRise.spring = Motion.Spring.Default.force(0f)
        detailAlpha.spring = Motion.Spring.Effects.force(1f)
        detailAlpha.setMinimumVisibleChange(DynamicAnimation.MIN_VISIBLE_CHANGE_ALPHA)
    }

    private fun wrapWithTop(top: Int) =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            .apply { topMargin = top }

    fun play(reduced: Boolean) {
        (context as? ComponentActivity)?.onBackPressedDispatcher?.addCallback(backCallback)
        ViewCompat.setAccessibilityPaneTitle(card, spec.title)
        if (reduced) {
            showFinalState()
            alpha = 0f
            phase = Phase.Rest
            animate().alpha(1f).setDuration(Motion.DurQuick.toLong()).withEndAction { scheduleRest() }.start()
            Haptics.confirm(this)
            return
        }
        anticipation()
    }

    // Phase 1
    private fun anticipation() {
        phase = Phase.Anticipation
        setCount(0)
        seal.iconProgress = 0f
        detail.alpha = 0f
        detail.translationY = listOffset
        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = Motion.DurInstant.toLong()
        animator.interpolator = Motion.Interpolators.Enter
        animator.addUpdateListener {
            val t = it.animatedValue as Float
            background.alpha = (255 * scrimAlpha * t).roundToInt()
            card.alpha = t
            val squash = 1f - 0.15f * t
            seal.scaleX = squash
            seal.scaleY = squash
        }
        animator.addListener(onEnd { impulse() })
        entryAnimator = animator
        animator.start()
    }

    // Phase 2
    private fun impulse() {
        if (phase != Phase.Anticipation) return
        phase = Phase.Impulse
        sealScale.addUpdateListener(peakTrigger)
        sealScale.start()
        sealScaleY.start()
        morph.start()
    }

    private val peakTrigger = DynamicAnimation.OnAnimationUpdateListener { _, value, _ ->
        if (value >= 1f && phase == Phase.Impulse) post { peak() }
    }

    // Phase 3
    private fun peak() {
        if (phase != Phase.Impulse) return
        phase = Phase.Peak
        sealScale.removeUpdateListener(peakTrigger)
        Haptics.confirm(this)
        val target = spec.count ?: 0
        val animator = ValueAnimator.ofFloat(0f, 1f)
        animator.duration = Motion.DurLong.toLong()
        animator.interpolator = Motion.Interpolators.Emphasized
        animator.addUpdateListener {
            val t = it.animatedValue as Float
            // The icon draws in over the first half; the count rolls across the whole peak.
            seal.iconProgress = (t * 2f).coerceAtMost(1f)
            setCount((target * t).roundToInt())
        }
        animator.addListener(onEnd { settle() })
        peakAnimator = animator
        animator.start()
    }

    // Phase 4
    private fun settle() {
        if (phase != Phase.Peak) return
        phase = Phase.Settle
        setCount(spec.count ?: 0)
        morph.spring = Motion.Spring.Default.force(0f)
        morph.addEndListener(settleEnd)
        morph.start()
        detailRise.start()
        detailAlpha.start()
    }

    private val settleEnd = object : DynamicAnimation.OnAnimationEndListener {
        override fun onAnimationEnd(animation: DynamicAnimation<*>?, canceled: Boolean, value: Float, velocity: Float) {
            morph.removeEndListener(this)
            if (!canceled && phase == Phase.Settle) {
                phase = Phase.Rest
                scheduleRest()
            }
        }
    }

    // Phase 5
    private fun scheduleRest() {
        removeCallbacks(restTimeout)
        val millis = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            context.getSystemService<AccessibilityManager>()?.getRecommendedTimeoutMillis(
                MomentOverlay.RestMillis,
                AccessibilityManager.FLAG_CONTENT_ICONS or AccessibilityManager.FLAG_CONTENT_TEXT,
            ) ?: MomentOverlay.RestMillis
        } else {
            MomentOverlay.RestMillis
        }
        postDelayed(restTimeout, millis.toLong())
    }

    private fun jumpToRest() {
        if (phase == Phase.Rest || phase == Phase.Exiting) return
        stopAll()
        showFinalState()
        phase = Phase.Rest
        scheduleRest()
    }

    private fun showFinalState() {
        background.alpha = (255 * scrimAlpha).roundToInt()
        card.alpha = 1f
        seal.scaleX = 1f
        seal.scaleY = 1f
        seal.morphProgress = 0f
        seal.iconProgress = 1f
        setCount(spec.count ?: 0)
        detail.alpha = 1f
        detail.translationY = 0f
    }

    fun dismiss() {
        if (phase == Phase.Exiting) return
        phase = Phase.Exiting
        stopAll()
        backCallback.remove()
        val startAlpha = alpha
        val animator = ValueAnimator.ofFloat(startAlpha, 0f)
        animator.duration = Motion.DurQuick.toLong()
        animator.interpolator = Motion.Interpolators.Exit
        animator.addUpdateListener { alpha = it.animatedValue as Float }
        animator.addListener(onEnd { (parent as? ViewGroup)?.removeView(this) })
        exitAnimator = animator
        animator.start()
    }

    private fun stopAll() {
        removeCallbacks(restTimeout)
        animate().cancel()
        entryAnimator?.removeAllListeners()
        entryAnimator?.cancel()
        peakAnimator?.removeAllListeners()
        peakAnimator?.cancel()
        sealScale.removeUpdateListener(peakTrigger)
        morph.removeEndListener(settleEnd)
        sealScale.cancel()
        sealScaleY.cancel()
        morph.cancel()
        detailRise.cancel()
        detailAlpha.cancel()
    }

    override fun onDetachedFromWindow() {
        stopAll()
        exitAnimator?.cancel()
        backCallback.remove()
        super.onDetachedFromWindow()
    }

    /** Writes the count without allocating a String per frame. */
    private fun setCount(value: Int) {
        if (value == shownCount) return
        shownCount = value
        var n = value.coerceAtLeast(0)
        var i = counterChars.size
        do {
            counterChars[--i] = '0' + n % 10
            n /= 10
        } while (n > 0)
        counter.setText(counterChars, i, counterChars.size - i)
    }

    private fun onEnd(block: () -> Unit): Animator.AnimatorListener = object : AnimatorListenerAdapter() {
        private var canceled = false
        override fun onAnimationCancel(animation: Animator) {
            canceled = true
        }
        override fun onAnimationEnd(animation: Animator) {
            if (!canceled) block()
        }
    }
}

/** The seal: an `accent-soft` shape morphing between a circle and an 8-petal flower, with the icon on top. */
private class SealView(context: Context) : View(context) {

    private val morph = Morph(
        RoundedPolygon.circle(numVertices = 8),
        RoundedPolygon.star(
            numVerticesPerRadius = 8,
            radius = 1f,
            innerRadius = 0.78f,
            rounding = CornerRounding(radius = 0.18f, smoothing = 0.6f),
            innerRounding = CornerRounding(radius = 0.12f),
        ),
    )
    private val path = Path()
    private val cubic = MutableCubic()
    private var pathStarted = false
    private val appendCubic: (MutableCubic) -> Unit = { c ->
        if (!pathStarted) {
            path.moveTo(c.anchor0X, c.anchor0Y)
            pathStarted = true
        }
        path.cubicTo(c.control0X, c.control0Y, c.control1X, c.control1Y, c.anchor1X, c.anchor1Y)
    }

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private var icon: Drawable? = null
    private var iconSize = 0

    var morphProgress = 0f
        set(value) {
            val clamped = value.coerceIn(-0.2f, 1.2f)
            if (field == clamped) return
            field = clamped
            rebuildPath()
            invalidate()
        }

    var iconProgress = 1f
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }

    init {
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        rebuildPath()
    }

    fun bind(fill: Int, icon: Drawable?, iconSize: Int) {
        paint.color = fill
        this.icon = icon
        this.iconSize = iconSize
        invalidate()
    }

    private fun rebuildPath() {
        path.rewind()
        pathStarted = false
        morph.forEachCubic(morphProgress, cubic, appendCubic)
        path.close()
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        // Radius leaves room for the flower's petals and the spring overshoot.
        val radius = min(width, height) / 2f / 1.08f
        val save = canvas.save()
        canvas.translate(cx, cy)
        canvas.scale(radius, radius)
        canvas.drawPath(path, paint)
        canvas.restoreToCount(save)

        val drawable = icon ?: return
        if (iconProgress <= 0f) return
        val scale = 0.6f + 0.4f * iconProgress
        val half = iconSize / 2
        drawable.setBounds((cx - half).toInt(), (cy - half).toInt(), (cx + half).toInt(), (cy + half).toInt())
        drawable.alpha = (255 * iconProgress).roundToInt()
        val iconSave = canvas.save()
        canvas.scale(scale, scale, cx, cy)
        drawable.draw(canvas)
        canvas.restoreToCount(iconSave)
    }

    companion object {
        val MorphProgress = object : FloatPropertyCompat<SealView>("morphProgress") {
            override fun getValue(view: SealView) = view.morphProgress
            override fun setValue(view: SealView, value: Float) {
                view.morphProgress = value
            }
        }
    }
}
