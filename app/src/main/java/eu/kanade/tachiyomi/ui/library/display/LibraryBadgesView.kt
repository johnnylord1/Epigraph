package eu.kanade.tachiyomi.ui.library.display

import android.content.Context
import android.util.AttributeSet
import eu.kanade.tachiyomi.databinding.LibraryBadgesLayoutBinding
import eu.kanade.tachiyomi.util.bindToPreference
import eu.kanade.tachiyomi.widget.BaseLibraryDisplayView

class LibraryBadgesView @JvmOverloads constructor(context: Context, attrs: AttributeSet? = null) :
    BaseLibraryDisplayView<LibraryBadgesLayoutBinding>(context, attrs) {

    override fun inflateBinding() = LibraryBadgesLayoutBinding.bind(this)
    override fun initGeneralPreferences() {
        binding.unreadBadgeGroup.bindToPreference(preferences.unreadBadgeType()) {
            controller?.presenter?.requestUnreadBadgesUpdate()
            controller?.refreshBooksLibrary()
        }
        binding.hideReading.bindToPreference(preferences.hideStartReadingButton())
        binding.downloadBadge.bindToPreference(preferences.downloadBadge()) {
            controller?.presenter?.requestDownloadBadgesUpdate()
            controller?.refreshBooksLibrary()
        }
        binding.languageBadge.bindToPreference(preferences.languageBadge()) {
            controller?.presenter?.requestLanguageBadgesUpdate()
            controller?.refreshBooksLibrary()
        }
        binding.showNumberOfItems.bindToPreference(preferences.categoryNumberOfItems())
    }
}
