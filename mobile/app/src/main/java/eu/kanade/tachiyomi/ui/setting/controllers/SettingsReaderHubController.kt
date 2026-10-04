package eu.kanade.tachiyomi.ui.setting.controllers

import android.content.Context
import android.os.Bundle
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Menu
import android.view.MenuInflater
import android.view.MenuItem
import androidx.compose.runtime.mutableStateOf
import androidx.core.view.updatePaddingRelative
import androidx.preference.PreferenceScreen
import androidx.preference.R as preferenceR
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.ui.setting.SettingsLegacyController
import eu.kanade.tachiyomi.util.system.dpToPx
import yokai.i18n.MR
import yokai.presentation.component.setSegmentedSwitchActionView
import yokai.util.lang.getString
import eu.kanade.tachiyomi.ui.setting.titleMRes as titleRes

/**
 * Reader settings hub. Delegates its preference screen to either
 * [SettingsMangaReaderController] or [SettingsNovelReaderController] based on
 * [selectedTab]. Manga / Novel / Books is the app bar pill, in the same place as every other
 * content-type switch.
 */
class SettingsReaderHubController : SettingsLegacyController() {

    private enum class ReaderTab { MANGA, NOVEL, BOOKS }

    /** Drives the pill; [selectedTab] reads and writes it. */
    private val selectedTabState = mutableStateOf(ReaderTab.MANGA)

    private var selectedTab: ReaderTab
        get() = selectedTabState.value
        set(value) {
            selectedTabState.value = value
        }

    fun selectInitialTab(tab: String?): SettingsReaderHubController = apply {
        selectedTab = ReaderTab.entries.firstOrNull { it.name == tab } ?: selectedTab
    }

    override fun setupPreferenceScreen(screen: PreferenceScreen) = screen.apply {
        titleRes = MR.strings.reader
        when (selectedTab) {
            ReaderTab.MANGA -> populateMangaReaderPreferences(this)
            ReaderTab.NOVEL -> populateNovelReaderPreferences(this)
            ReaderTab.BOOKS -> populateBooksReaderPreferences(this)
        }
    }

    private fun rebuildPreferenceScreen() {
        if (!isAttached) return
        val newScreen = preferenceManager.createPreferenceScreen(getThemedContext())
        preferenceScreen = newScreen
        setupPreferenceScreen(newScreen)
        setTitle()
    }

    private fun getThemedContext(): Context {
        val tv = TypedValue()
        activity!!.theme.resolveAttribute(preferenceR.attr.preferenceTheme, tv, true)
        return ContextThemeWrapper(activity, tv.resourceId)
    }

    override fun onCreateOptionsMenu(menu: Menu, inflater: MenuInflater) {
        inflater.inflate(R.menu.settings_reader_hub, menu)
        val act = activity ?: return
        val labels = listOf(
            act.getString(MR.strings.manga),
            act.getString(MR.strings.novel),
            act.getString(R.string.epigraph_books),
        )
        menu.findItem(R.id.action_reader_type)?.apply {
            setSegmentedSwitchActionView(
                context = act,
                options = ReaderTab.entries.zip(labels),
                selected = selectedTabState,
                onSelect = ::selectTab,
            )
            // Nothing follows the pill in this toolbar, so keep it off the screen edge.
            actionView?.updatePaddingRelative(end = 12.dpToPx)
        }
    }

    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        // Only reached if the toolbar shows the item instead of the pill: step to the next reader.
        if (item.itemId == R.id.action_reader_type) {
            selectTab(ReaderTab.entries[(selectedTab.ordinal + 1) % ReaderTab.entries.size])
            return true
        }
        return super.onOptionsItemSelected(item)
    }

    private fun selectTab(target: ReaderTab) {
        if (target == selectedTab) {
            if (view != null) listView.scrollToPosition(0)
            return
        }
        selectedTab = target
        rebuildPreferenceScreen()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putInt(STATE_SELECTED_TAB, selectedTab.ordinal)
        super.onSaveInstanceState(outState)
    }

    override fun onRestoreInstanceState(savedInstanceState: Bundle) {
        super.onRestoreInstanceState(savedInstanceState)
        val idx = savedInstanceState.getInt(STATE_SELECTED_TAB, ReaderTab.MANGA.ordinal)
        selectedTab = ReaderTab.entries.getOrElse(idx) { ReaderTab.MANGA }
    }

    companion object {
        private const val STATE_SELECTED_TAB = "SettingsReaderHubController.selectedTab"
    }
}
