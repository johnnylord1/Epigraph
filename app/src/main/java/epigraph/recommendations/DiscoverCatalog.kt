package epigraph.recommendations

/** One work in Discover › Catalog: something an installed extension lists, with its tracker score. */
data class DiscoverCatalogEntry(
    val candidate: RecommendationCandidate,
    val badge: TrackerScoreBadge?,
)

/**
 * Discover › Catalog: every work the installed extensions listed while Discover gathered its pool,
 * in the order the sources returned them, with the tracker score badge when a tracker knows the
 * title. Tracker-only picks are left out because they cannot be opened from a source. Library,
 * NSFW and blocked-tag filters are the same ones the For you rails use.
 */
fun buildDiscoverCatalog(
    candidates: List<RecommendationCandidate>,
    options: BuildRecommendationSectionsOptions,
): List<DiscoverCatalogEntry> =
    candidates
        .filter { it.targets.isNotEmpty() && passesFilters(it, options) }
        .distinctBy { it.id }
        .map { DiscoverCatalogEntry(it, buildTrackerScoreBadge(it)) }
