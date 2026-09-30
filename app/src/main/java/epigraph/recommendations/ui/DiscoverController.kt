package epigraph.recommendations.ui

import android.os.Bundle
import androidx.compose.runtime.Composable
import cafe.adriel.voyager.navigator.CurrentScreen
import cafe.adriel.voyager.navigator.Navigator
import epigraph.recommendations.DiscoverMode
import eu.kanade.tachiyomi.ui.base.controller.BaseComposeController

/** Library-based recommendations, the mobile counterpart of the desktop Discover page. */
class DiscoverController(bundle: Bundle? = null) : BaseComposeController(bundle) {

    constructor(mode: DiscoverMode) : this(Bundle().apply { putString(MODE_KEY, mode.name) })

    private val mode: DiscoverMode
        get() = args.getString(MODE_KEY)?.let { runCatching { DiscoverMode.valueOf(it) }.getOrNull() }
            ?: DiscoverMode.COMICS

    @Composable
    override fun ScreenContent() {
        Navigator(
            screen = DiscoverScreen(mode),
            content = { navigator ->
                this.navigator = navigator
                CurrentScreen()
            },
        )
    }

    companion object {
        private const val MODE_KEY = "discover_mode"
    }
}
