package epigraph.ui

import android.os.Build
import android.view.HapticFeedbackConstants
import android.view.View

/**
 * DESIGN.md §12. Four feedback kinds, mapped to the closest platform constant per API level. Never
 * passes FLAG_IGNORE_GLOBAL_SETTING: the system "touch feedback" switch always wins.
 */
object Haptics {
    /** Discrete step: slider notch, reorder slot, page snap. */
    fun tick(view: View) = view.performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK)

    fun toggle(view: View, on: Boolean) = view.performHapticFeedback(
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE ->
                if (on) HapticFeedbackConstants.TOGGLE_ON else HapticFeedbackConstants.TOGGLE_OFF
            else -> HapticFeedbackConstants.CLOCK_TICK
        },
    )

    /** A completed action worth marking (moment peak, backup done). */
    fun confirm(view: View) = view.performHapticFeedback(
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            HapticFeedbackConstants.CONFIRM
        } else {
            HapticFeedbackConstants.CONTEXT_CLICK
        },
    )

    fun reject(view: View) = view.performHapticFeedback(
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            HapticFeedbackConstants.REJECT
        } else {
            HapticFeedbackConstants.LONG_PRESS
        },
    )
}
