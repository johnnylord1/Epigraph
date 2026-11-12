package epigraph.books.ui

import android.app.Activity
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import androidx.core.view.WindowInsetsCompat.Type.systemBars
import androidx.core.view.isInvisible
import androidx.core.view.isVisible
import com.google.android.material.bottomsheet.BottomSheetBehavior
import eu.kanade.tachiyomi.databinding.ChapterSortBottomSheetBinding
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.util.system.dpToPx
import eu.kanade.tachiyomi.util.system.rootWindowInsetsCompat
import eu.kanade.tachiyomi.util.view.checkHeightThen
import eu.kanade.tachiyomi.util.view.setBottomEdge
import eu.kanade.tachiyomi.widget.E2EBottomSheetDialog
import eu.kanade.tachiyomi.widget.SortTextView
import eu.kanade.tachiyomi.widget.TriStateCheckBox
import kotlin.math.max

/**
 * ChaptersSortBottomSheet for a book's chapter list: the same sheet, without what a publication
 * does not have (sources, upload dates, downloads per chapter, scanlator groups).
 */
internal class BookChaptersSortBottomSheet(
    private val activity: Activity,
    private val settings: BookChapterListSettings,
    private val onChanged: () -> Unit,
) : E2EBottomSheetDialog<ChapterSortBottomSheetBinding>(activity) {

    override fun createBinding(inflater: LayoutInflater) = ChapterSortBottomSheetBinding.inflate(inflater)

    init {
        val height = activity.window.decorView.rootWindowInsetsCompat
            ?.getInsetsIgnoringVisibility(systemBars())?.bottom ?: 0
        sheetBehavior.peekHeight = 470.dpToPx + height

        sheetBehavior.addBottomSheetCallback(
            object : BottomSheetBehavior.BottomSheetCallback() {
                override fun onSlide(bottomSheet: View, progress: Float) {
                    if (progress.isNaN()) {
                        binding.pill.alpha = 0f
                    } else {
                        binding.pill.alpha = (1 - max(0f, progress)) * 0.25f
                    }
                }

                override fun onStateChanged(p0: View, state: Int) {
                    if (state == BottomSheetBehavior.STATE_EXPANDED) {
                        sheetBehavior.skipCollapsed = true
                    }
                }
            },
        )
    }

    override fun onStart() {
        super.onStart()
        sheetBehavior.skipCollapsed = true
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        initGeneralPreferences()
        setBottomEdge(binding.hideTitles, activity)
        binding.settingsScrollView.checkHeightThen {
            val isScrollable =
                binding.settingsScrollView.height < binding.sortLayout.height +
                    binding.settingsScrollView.paddingTop + binding.settingsScrollView.paddingBottom
            // making the view gone somehow breaks the layout so lets make it invisible
            binding.pill.isInvisible = isScrollable
        }
    }

    private fun initGeneralPreferences() {
        binding.bySource.isVisible = false
        binding.byUploadDate.isVisible = false
        binding.filterGroupsButton.isVisible = false
        binding.chapterFilterLayout.showDownload.isVisible = false

        setFilterCheckboxes()
        updateFilterDefaultButtons()
        binding.chapterFilterLayout.root.setOnCheckedChangeListener { saveFilters() }

        setSortState()
        updateSortDefaultButtons()
        binding.byChapterNumber.setOnSortChangeListener { _, state ->
            settings.setDescending(state == SortTextView.State.DESCENDING)
            updateSortDefaultButtons()
            onChanged()
        }

        binding.hideTitles.isChecked = settings.hideTitles
        setHideTitleListener()

        binding.setAsDefaultSort.setOnClickListener {
            settings.setSortAsDefault()
            updateSortDefaultButtons()
        }
        binding.resetAsDefaultSort.setOnClickListener {
            settings.resetSort()
            setSortState()
            updateSortDefaultButtons()
            onChanged()
        }
        binding.chapterFilterLayout.setAsDefaultFilter.setOnClickListener {
            settings.setFiltersAsDefault()
            updateFilterDefaultButtons()
        }
        binding.chapterFilterLayout.resetAsDefaultFilter.setOnClickListener {
            settings.resetFilters()
            setFilterCheckboxes()
            binding.hideTitles.setOnCheckedChangeListener { _, _ -> }
            binding.hideTitles.isChecked = settings.hideTitles
            setHideTitleListener()
            updateFilterDefaultButtons()
            onChanged()
        }
    }

    private fun setFilterCheckboxes() = with(binding.chapterFilterLayout) {
        showUnread.state = when (settings.readFilter) {
            Manga.CHAPTER_SHOW_UNREAD -> TriStateCheckBox.State.CHECKED
            Manga.CHAPTER_SHOW_READ -> TriStateCheckBox.State.IGNORE
            else -> TriStateCheckBox.State.UNCHECKED
        }
        showBookmark.state = when (settings.bookmarkFilter) {
            Manga.CHAPTER_SHOW_BOOKMARKED -> TriStateCheckBox.State.CHECKED
            Manga.CHAPTER_SHOW_NOT_BOOKMARKED -> TriStateCheckBox.State.IGNORE
            else -> TriStateCheckBox.State.UNCHECKED
        }
        showAll.isChecked = showUnread.isUnchecked && showBookmark.isUnchecked
    }

    private fun saveFilters() = with(binding.chapterFilterLayout) {
        settings.setFilters(
            read = when (showUnread.state) {
                TriStateCheckBox.State.CHECKED -> Manga.CHAPTER_SHOW_UNREAD
                TriStateCheckBox.State.IGNORE -> Manga.CHAPTER_SHOW_READ
                else -> Manga.SHOW_ALL
            },
            bookmark = when (showBookmark.state) {
                TriStateCheckBox.State.CHECKED -> Manga.CHAPTER_SHOW_BOOKMARKED
                TriStateCheckBox.State.IGNORE -> Manga.CHAPTER_SHOW_NOT_BOOKMARKED
                else -> Manga.SHOW_ALL
            },
        )
        updateFilterDefaultButtons()
        onChanged()
    }

    private fun setSortState() {
        binding.byChapterNumber.state = if (settings.descending) {
            SortTextView.State.DESCENDING
        } else {
            SortTextView.State.ASCENDING
        }
    }

    private fun setHideTitleListener() {
        binding.hideTitles.setOnCheckedChangeListener { _, isChecked ->
            settings.setHideTitles(isChecked)
            updateFilterDefaultButtons()
            onChanged()
        }
    }

    private fun updateFilterDefaultButtons() {
        val matches = settings.filtersMatchDefault()
        binding.chapterFilterLayout.setAsDefaultFilter.isInvisible = matches
        binding.chapterFilterLayout.resetAsDefaultFilter.isInvisible = matches
    }

    private fun updateSortDefaultButtons() {
        val matches = settings.sortMatchesDefault()
        binding.setAsDefaultSort.isInvisible = matches
        binding.resetAsDefaultSort.isInvisible = matches
    }
}
