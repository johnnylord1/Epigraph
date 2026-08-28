package epigraph.sync.core.protocol

/** Ordered bootstrap required by both Android -> Core and Core -> Android. */
enum class CoreBootstrapPhase {
    REPOSITORIES,
    EXTENSIONS_AND_PLUGINS,
    CATEGORIES,
    LIBRARY_ENTRIES,
    CATEGORY_ASSIGNMENTS,
    READER_STATE,
    ASSETS,
}

data class CoreSyncCandidate(
    val id: String,
    val entityType: String,
)

data class CoreBootstrapPlan(
    val phases: Map<CoreBootstrapPhase, List<CoreSyncCandidate>>,
    val blockedByCore: List<CoreSyncCandidate>,
) {
    fun orderedCandidates(): List<CoreSyncCandidate> =
        CoreBootstrapPhase.entries.flatMap { phases[it].orEmpty() }
}

object EpigraphCoreBootstrapPlanner {
    fun plan(capabilities: CoreCapabilities, candidates: List<CoreSyncCandidate>): CoreBootstrapPlan {
        val supported = candidates.filter {
            EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, it.entityType)
        }
        val blocked = candidates.filterNot {
            EpigraphCoreCompatibilityEvaluator.canSynchronizeEntity(capabilities, it.entityType)
        }

        return CoreBootstrapPlan(
            phases = CoreBootstrapPhase.entries.associateWith { phase ->
                supported.filter { phaseOf(it.entityType) == phase }
            },
            blockedByCore = blocked,
        )
    }

    fun phaseOf(entityType: String): CoreBootstrapPhase = when (entityType) {
        EpigraphCoreEntityType.COMIC_REPOSITORY,
        EpigraphCoreEntityType.NOVEL_REPOSITORY,
        -> CoreBootstrapPhase.REPOSITORIES

        EpigraphCoreEntityType.COMIC_EXTENSION,
        EpigraphCoreEntityType.NOVEL_PLUGIN,
        -> CoreBootstrapPhase.EXTENSIONS_AND_PLUGINS

        EpigraphCoreEntityType.BOOK_CATEGORY,
        EpigraphCoreEntityType.NOVEL_CATEGORY,
        EpigraphCoreEntityType.COMIC_CATEGORY,
        -> CoreBootstrapPhase.CATEGORIES

        EpigraphCoreEntityType.BOOK_ENTRY,
        EpigraphCoreEntityType.NOVEL_ENTRY,
        EpigraphCoreEntityType.COMIC_ENTRY,
        -> CoreBootstrapPhase.LIBRARY_ENTRIES

        EpigraphCoreEntityType.BOOK_CATEGORY_ASSIGNMENT,
        EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT,
        EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT,
        -> CoreBootstrapPhase.CATEGORY_ASSIGNMENTS

        EpigraphCoreEntityType.BOOK_PROGRESS,
        EpigraphCoreEntityType.BOOK_BOOKMARK,
        EpigraphCoreEntityType.BOOK_HIGHLIGHT,
        EpigraphCoreEntityType.BOOK_HISTORY,
        EpigraphCoreEntityType.BOOK_LIBRARY_UI,
        EpigraphCoreEntityType.NOVEL_CHAPTER,
        EpigraphCoreEntityType.NOVEL_PROGRESS,
        EpigraphCoreEntityType.NOVEL_BOOKMARK,
        EpigraphCoreEntityType.NOVEL_HISTORY,
        EpigraphCoreEntityType.NOVEL_CLASSIFICATION,
        EpigraphCoreEntityType.NOVEL_TRACKING,
        EpigraphCoreEntityType.COMIC_CHAPTER_STATE,
        EpigraphCoreEntityType.COMIC_HISTORY,
        EpigraphCoreEntityType.COMIC_PAGE_BOOKMARK,
        EpigraphCoreEntityType.COMIC_TRACKING,
        -> CoreBootstrapPhase.READER_STATE

        EpigraphCoreEntityType.NOVEL_CHAPTER_ASSET -> CoreBootstrapPhase.ASSETS
        else -> throw IllegalArgumentException("unknown Epigraph Core entity type: $entityType")
    }
}
