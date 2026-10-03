package yokai.presentation.theme

import android.view.animation.PathInterpolator
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.dynamicanimation.animation.SpringForce

// DESIGN.md §9 motion tokens, shared by Views and Compose. The XML mirror lives in
// res/values/epigraph_design.xml and res/interpolator; keep the three in step.
object Motion {
    const val DurInstant = 90
    const val DurQuick = 150
    const val DurStandard = 250
    const val DurMedium = 300
    const val DurEmphasized = 400
    const val DurLong = 600

    /** Shared axis travel, in dp. */
    const val SlideDistanceDp = 30f

    /** Share of a shared-axis/fade-through run spent fading the outgoing screen. */
    const val OutgoingFraction = 0.35f

    /** Fade-through incoming scale start. */
    const val FadeThroughScale = 0.94f

    /** Modal (dialog, menu, popup) entry scale start and exit scale end. */
    const val ModalEnterScale = 0.9f
    const val ModalExitScale = 0.96f

    /** Press feedback scale. */
    const val PressScale = 0.96f

    /** Staggered list entry: per-item delay and cap. */
    const val StaggerStepMs = 20
    const val StaggerMaxItems = 10
    const val ListEntryOffsetDp = 8f

    /** Predictive back preview: scale floor and corner radius (r-l) while dragging. */
    const val BackPreviewScale = 0.92f

    val EaseStandard = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val EaseEnter = CubicBezierEasing(0f, 0f, 0f, 1f)
    val EaseExit = CubicBezierEasing(0.3f, 0f, 1f, 1f)
    val EaseEmphasized = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EaseOvershoot = CubicBezierEasing(0.3f, 1.25f, 0.5f, 1f)

    /** The same curves for Views; immutable, so one shared instance each. */
    object Interpolators {
        val Standard = PathInterpolator(0.2f, 0f, 0f, 1f)
        val Enter = PathInterpolator(0f, 0f, 0f, 1f)
        val Exit = PathInterpolator(0.3f, 0f, 1f, 1f)
        val Emphasized = PathInterpolator(0.05f, 0.7f, 0.1f, 1f)
        val Overshoot = PathInterpolator(0.3f, 1.25f, 0.5f, 1f)
    }

    /** Named springs (damping ratio / stiffness), identical for Compose and DynamicAnimation. */
    enum class Spring(val damping: Float, val stiffness: Float) {
        Snappy(0.9f, 1400f),
        Default(0.85f, 700f),
        Gentle(0.9f, 300f),
        Effects(1f, 1600f),
        Moment(0.6f, 380f),
        ;

        fun <T> spec(visibilityThreshold: T? = null): FiniteAnimationSpec<T> =
            spring(dampingRatio = damping, stiffness = stiffness, visibilityThreshold = visibilityThreshold)

        fun force(finalPosition: Float): SpringForce =
            SpringForce(finalPosition).setDampingRatio(damping).setStiffness(stiffness)
    }
}
