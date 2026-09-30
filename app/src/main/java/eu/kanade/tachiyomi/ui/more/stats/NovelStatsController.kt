package eu.kanade.tachiyomi.ui.more.stats

import androidx.compose.runtime.Composable
import cafe.adriel.voyager.navigator.Navigator
import epigraph.ui.motion.EpigraphScreenTransition
import eu.kanade.tachiyomi.ui.base.controller.BaseComposeController
import yokai.presentation.stats.novel.NovelStatsScreen

/** Conductor controller hosting the Voyager [NovelStatsScreen]. Pushed from [StatsController]. */
class NovelStatsController : BaseComposeController() {

    @Composable
    override fun ScreenContent() {
        Navigator(
            screen = NovelStatsScreen(),
            content = { navigator ->
                this.navigator = navigator
                EpigraphScreenTransition(navigator = navigator)
            },
        )
    }
}
