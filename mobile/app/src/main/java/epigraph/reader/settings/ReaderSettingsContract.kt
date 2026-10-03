package epigraph.reader.settings

enum class ReaderDomain {
    COMIC,
    NOVEL,
    BOOK,
}

data class ReaderSettingsCapabilities(
    val supportsPagedNavigation: Boolean,
    val supportsTextLayout: Boolean,
    val supportsColorFilters: Boolean,
    val supportsDoublePages: Boolean,
    val supportsCropBorders: Boolean,
    val supportsTts: Boolean,
    val supportsChapterTransitions: Boolean,
)

interface ReaderSettingsHost {
    val readerDomain: ReaderDomain
    val readerSettingsCapabilities: ReaderSettingsCapabilities

    fun applyReaderSettings()
    fun resetReaderSettingsToDefaults()
    fun openGlobalReaderSettings()
}
