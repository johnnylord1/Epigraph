package epigraph.recommendations.ui

import android.os.Bundle
import androidx.compose.runtime.Composable
import cafe.adriel.voyager.navigator.CurrentScreen
import cafe.adriel.voyager.navigator.Navigator
import epigraph.recommendations.DiscoverMode
import eu.kanade.tachiyomi.ui.base.controller.BaseComposeController
import eu.kanade.tachiyomi.ui.main.RootTabContent

/**
 * The Discover bottom navigation tab: library-based picks (For you) and everything the installed
 * extensions list (Catalog), the mobile counterpart of the desktop Browse page.
 */
class DiscoverController(bundle: Bundle? = null) : BaseComposeController(bundle), RootTabContent {

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
