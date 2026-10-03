package epigraph.ui.motion

import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.stack.StackEvent
import cafe.adriel.voyager.navigator.Navigator
import cafe.adriel.voyager.transitions.ScreenTransition
import soup.compose.material.motion.animation.materialSharedAxisX
import soup.compose.material.motion.animation.rememberSlideDistance
import yokai.presentation.theme.LocalReducedMotion
import yokai.presentation.theme.Motion

/**
 * Voyager screen changes inside a Compose host (Settings subpages, About, stats, repos): the same
 * shared axis X as Conductor pushes (DESIGN.md §9), or a `dur-quick` fade under reduced motion.
 */
@Composable
fun EpigraphScreenTransition(navigator: Navigator, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val slideDistance = rememberSlideDistance(slideDistance = Motion.SlideDistanceDp.dp)
    ScreenTransition(
        navigator = navigator,
        modifier = modifier,
        transition = {
            if (reduced) {
                fadeIn(tween(Motion.DurQuick)) togetherWith fadeOut(tween(Motion.DurQuick))
            } else {
                materialSharedAxisX(
                    forward = navigator.lastEvent != StackEvent.Pop,
                    slideDistance = slideDistance,
                    durationMillis = Motion.DurMedium,
                )
            }
        },
    )
}
