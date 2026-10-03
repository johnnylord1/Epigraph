package epigraph.sync.core.protocol

object EpigraphCoreEntityType {
    const val BOOK_ENTRY = "book.entry"
    const val BOOK_CATEGORY = "book.category"
    const val BOOK_CATEGORY_ASSIGNMENT = "book.category_assignment"
    const val BOOK_LIBRARY_UI = "book.library_ui"
    const val BOOK_PROGRESS = "book.progress"
    const val BOOK_BOOKMARK = "book.bookmark"
    const val BOOK_HIGHLIGHT = "book.highlight"
    const val BOOK_HISTORY = "book.history"
    const val NOVEL_ENTRY = "novel.entry"
    const val NOVEL_CHAPTER = "novel.chapter"
    const val NOVEL_CHAPTER_ASSET = "novel.chapter_asset"
    const val NOVEL_PROGRESS = "novel.progress"
    const val NOVEL_BOOKMARK = "novel.bookmark"
    const val NOVEL_HISTORY = "novel.history"
    const val NOVEL_CLASSIFICATION = "novel.classification"
    const val NOVEL_REPOSITORY = "novel.repository"
    const val NOVEL_PLUGIN = "novel.plugin"
    const val NOVEL_CATEGORY = "novel.category"
    const val NOVEL_CATEGORY_ASSIGNMENT = "novel.category_assignment"
    const val COMIC_HISTORY = "comic.history"
    const val COMIC_PAGE_BOOKMARK = "comic.page_bookmark"

    // Planned Core additions. They are not assumed available until advertised.
    const val COMIC_REPOSITORY = "comic.repository"
    const val COMIC_EXTENSION = "comic.extension"
    const val COMIC_ENTRY = "comic.entry"
    const val COMIC_CATEGORY = "comic.category"
    const val COMIC_CATEGORY_ASSIGNMENT = "comic.category_assignment"
    const val COMIC_CHAPTER_STATE = "comic.chapter_state"
    const val COMIC_TRACKING = "comic.tracking"
    const val NOVEL_TRACKING = "novel.tracking"
}

sealed interface CoreCompatibility {
    data object Compatible : CoreCompatibility
    data class ProtocolMismatch(val expected: Int, val actual: Int) : CoreCompatibility
    data class SnapshotSchemaMismatch(val expected: Int, val actual: Int) : CoreCompatibility
    data class MissingCapabilities(val names: Set<String>) : CoreCompatibility
}

object EpigraphCoreCompatibilityEvaluator {
    fun evaluate(capabilities: CoreCapabilities): CoreCompatibility {
        if (capabilities.serverProtocolVersion != EpigraphCoreWireProtocol.CURRENT_VERSION) {
            return CoreCompatibility.ProtocolMismatch(
                expected = EpigraphCoreWireProtocol.CURRENT_VERSION,
                actual = capabilities.serverProtocolVersion,
            )
        }
        if (capabilities.snapshotSchemaVersion !in
            EpigraphCoreWireProtocol.MIN_SNAPSHOT_SCHEMA_VERSION..EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION
        ) {
            return CoreCompatibility.SnapshotSchemaMismatch(
                expected = EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
                actual = capabilities.snapshotSchemaVersion,
            )
        }

        val missing = buildSet {
            if (!capabilities.supportsSnapshot) add("snapshot")
            if (!capabilities.supportsSseReplay) add("sseReplay")
        }
        return if (missing.isEmpty()) CoreCompatibility.Compatible else CoreCompatibility.MissingCapabilities(missing)
    }

    /** Never sends an entity merely because the Android domain knows about it. */
    fun canSynchronizeEntity(capabilities: CoreCapabilities, entityType: String): Boolean =
        entityType in capabilities.snapshotEntityTypes

    fun supportsCanonicalComicProjection(capabilities: CoreCapabilities): Boolean =
        capabilities.supportsCausalMutationsV3 &&
            capabilities.snapshotEntityTypes.containsAll(CANONICAL_COMIC_PROJECTION_TYPES)

    /**
     * Returns true only when the Core explicitly declares the managed Suwayomi
     * instance as the authority for comic catalog state.  Older Cores omitted
     * this field, so they remain on the legacy compatibility path instead of
     * being treated as authoritative by inference from entity names alone.
     */
    fun isSuwayomiAuthoritativeComics(capabilities: CoreCapabilities): Boolean =
        capabilities.comicAuthorityMode == "suwayomi-confirmed-v1" &&
            capabilities.supportsConfirmedSuwayomiCommandsV1

    fun supportsSyncStatus(capabilities: CoreCapabilities): Boolean =
        capabilities.supportsSyncStatusV1

    private val CANONICAL_COMIC_PROJECTION_TYPES = setOf(
        EpigraphCoreEntityType.COMIC_ENTRY,
        EpigraphCoreEntityType.COMIC_CATEGORY,
        EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT,
        EpigraphCoreEntityType.COMIC_CHAPTER_STATE,
        EpigraphCoreEntityType.COMIC_HISTORY,
    )
}
