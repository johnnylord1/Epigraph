package epigraph.recommendations.ui

import android.content.Context
import android.content.ContextWrapper
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.model.rememberScreenModel
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.stringResource
import epigraph.recommendations.DiscoverCatalogEntry
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.RecommendationCandidate
import epigraph.recommendations.RecommendationItem
import epigraph.recommendations.RecommendationCardBanner
import epigraph.recommendations.RecommendationCardKnownStatus
import epigraph.recommendations.RecommendationCardStatus
import epigraph.recommendations.cardBanner
import epigraph.recommendations.cardProviderLabel
import epigraph.recommendations.cardStatus
import epigraph.recommendations.RecommendationSection
import epigraph.recommendations.RecommendationSectionKey
import epigraph.recommendations.SEARCH_RECOMMENDATION_BASE_LIMIT
import epigraph.recommendations.TrackerScoreBadge
import epigraph.recommendations.discoverGridColumns
import kotlin.math.roundToInt
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.ui.main.MainActivity
import eu.kanade.tachiyomi.ui.manga.MangaDetailsController
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchController
import eu.kanade.tachiyomi.util.compose.LocalRouter
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import java.io.File
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import yokai.domain.manga.models.MangaCover as CoverData
import yokai.i18n.MR
import yokai.presentation.AppBarType
import yokai.presentation.core.enterAlwaysCollapsedAppBarScrollBehavior
import yokai.presentation.YokaiScaffold
import yokai.presentation.component.SegmentedSwitch
import yokai.presentation.manga.components.MangaCover
import yokai.util.Screen

class DiscoverScreen(private val initialMode: DiscoverMode) : Screen() {

@OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun Content() {
        val router = LocalRouter.current
        val context = LocalContext.current
        val mainActivity = remember(context) { context.findMainActivity() }
        val scope = rememberCoroutineScope()
        val screenModel = rememberScreenModel { DiscoverScreenModel(initialMode) }
        val state by screenModel.state.collectAsState()
        var showFilterSheet by remember { mutableStateOf(false) }
        // The bottom navigation floats over the tab, so the lists end above it.
        val bottomNavHeight = with(LocalDensity.current) {
            (mainActivity?.takeIf { it.isBindingInitialized }?.binding?.bottomNav?.height ?: 0).toDp()
        }
        val openCandidate: (RecommendationCandidate) -> Unit = { candidate ->
            scope.launch {
                val manga = runCatching { screenModel.resolveLocalManga(candidate) }.getOrNull()
                val controller = if (manga?.id != null) {
                    MangaDetailsController(manga, fromCatalogue = true)
                } else {
                    GlobalSearchController(candidate.title)
                }
                router?.pushController(controller.withFadeTransaction())
            }
        }

        DiscoverContent(
            state = state,
            bottomPadding = bottomNavHeight,
            onFilter = { showFilterSheet = true },
            onRefresh = { screenModel.load(force = true) },
            // Same overflow as the other tabs (settings, stats, about…).
            onOverflow = { mainActivity?.showOverflowDialog() },
            onSection = screenModel::setSection,
            onMode = screenModel::setMode,
            onShowMore = screenModel::showMore,
            onLoadMoreCatalog = screenModel::loadMoreCatalog,
            onRemoveGenre = { genre -> screenModel.setGenres(state.genres - genre) },
            onClearGenres = { screenModel.setGenres(emptyList()) },
            onOpen = openCandidate,
        )
        if (showFilterSheet) {
            ModalBottomSheet(
                onDismissRequest = { showFilterSheet = false },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            ) {
                Column(
                    modifier = Modifier
                        .verticalScroll(rememberScrollState())
                        .navigationBarsPadding()
                        .padding(bottom = 16.dp),
                ) {
                    DiscoverGridSizeRow(gridSize = state.gridSize, onGridSizeChange = screenModel::setGridSize)
                    DiscoverFilterRows(
                        mode = state.mode,
                        includeLibrary = state.includeLibrary,
                        includeNsfw = state.includeNsfw,
                        onIncludeLibraryChange = screenModel::setIncludeLibrary,
                        onIncludeNsfwChange = screenModel::setIncludeNsfw,
                    )
                    state.result?.let { result ->
                        if (result.seedCount > 0) {
                            Text(
                                text = stringResource(MR.strings.discover_seed_count, result.seedCount),
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                            )
                        }
                    }
                    // Genres narrow the Catalog only; For you ranks by the library profile.
                    if (state.section == DiscoverSection.CATALOG && state.genreOptions.isNotEmpty()) {
                        HorizontalDivider(modifier = Modifier.padding(vertical = 8.dp))
                        DiscoverGenreFilter(
                            options = state.genreOptions,
                            selected = state.genres,
                            onSelectedChange = screenModel::setGenres,
                        )
                    }
                }
            }
        }
    }
}

/**
 * The Discover tab without its screen model: app bar, sub-tabs and the For you / Catalog bodies.
 * [DiscoverScreen] feeds it; screenshot tests render it with fixed states.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun DiscoverContent(
    state: DiscoverScreenModel.State,
    bottomPadding: Dp,
    onFilter: () -> Unit,
    onRefresh: () -> Unit,
    onOverflow: () -> Unit,
    onSection: (DiscoverSection) -> Unit,
    onMode: (DiscoverMode) -> Unit,
    onShowMore: (RecommendationSectionKey) -> Unit,
    onLoadMoreCatalog: () -> Unit,
    onOpen: (RecommendationCandidate) -> Unit,
    onRemoveGenre: (String) -> Unit = {},
    onClearGenres: () -> Unit = {},
) {
    YokaiScaffold(
        onNavigationIconClicked = {},
        title = stringResource(MR.strings.discover),
        // A bottom navigation tab: nothing to go back to.
        navigationIcon = null,
        appBarType = AppBarType.LARGE,
        scrollBehavior = enterAlwaysCollapsedAppBarScrollBehavior(),
        actions = {
            IconButton(onClick = onFilter) {
                Icon(Icons.Outlined.FilterList, contentDescription = stringResource(MR.strings.filter))
            }
            IconButton(onClick = onRefresh, enabled = !state.loading) {
                Icon(Icons.Outlined.Refresh, contentDescription = stringResource(MR.strings.refresh))
            }
            // Same place on every screen that switches content type: right before the overflow menu.
            SegmentedSwitch(
                options = listOf(
                    DiscoverMode.COMICS to stringResource(MR.strings.discover_comics),
                    DiscoverMode.NOVELS to stringResource(MR.strings.novels),
                ),
                selected = state.mode,
                onSelect = onMode,
                modifier = Modifier.padding(horizontal = 4.dp),
            )
            IconButton(onClick = onOverflow) {
                Icon(Icons.Outlined.MoreVert, contentDescription = stringResource(MR.strings.more))
            }
        },
        // Inside the app bar so the tabs take its scrolled tone too.
        appBarBottomContent = {
            DiscoverHeader(section = state.section, onSection = onSection)
        },
    ) { contentPadding ->
        Column(modifier = Modifier.fillMaxSize().padding(contentPadding)) {
            Spacer(Modifier.height(4.dp))
            if (state.loading && state.result != null) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).clip(RoundedCornerShape(2.dp)),
                    color = MaterialTheme.colorScheme.secondary,
                    trackColor = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f),
                )
            }
            val result = state.result
            when {
                result == null && state.loading -> CenteredBox {
                    CircularProgressIndicator(color = MaterialTheme.colorScheme.secondary)
                }
                result == null -> CenteredMessage(
                    text = stringResource(MR.strings.discover_error) +
                        state.error?.takeIf { it.isNotBlank() }?.let { "\n$it" }.orEmpty(),
                    onRetry = onRefresh,
                )
                state.section == DiscoverSection.CATALOG -> Column(modifier = Modifier.fillMaxSize()) {
                    if (state.genres.isNotEmpty()) {
                        SelectedGenres(genres = state.genres, onRemove = onRemoveGenre)
                    }
                    when {
                        state.catalog.isNotEmpty() -> DiscoverCatalogGrid(
                            entries = state.catalog,
                            gridSize = state.gridSize,
                            loadingMore = state.catalogLoadingMore,
                            exhausted = state.catalogExhausted,
                            bottomPadding = bottomPadding,
                            onNearEnd = onLoadMoreCatalog,
                            onClick = onOpen,
                        )
                        // The genre search is still asking the sources.
                        state.genres.isNotEmpty() && !state.catalogExhausted -> CenteredBox {
                            CircularProgressIndicator(color = MaterialTheme.colorScheme.secondary)
                        }
                        state.genres.isNotEmpty() -> CenteredMessage(
                            text = stringResource(MR.strings.discover_catalog_genre_empty),
                            actionLabel = stringResource(MR.strings.clear_filters),
                            onAction = onClearGenres,
                        )
                        else -> CenteredMessage(
                            text = stringResource(MR.strings.discover_catalog_empty),
                            onRetry = onRefresh,
                        )
                    }
                }
                result.sections.isEmpty() -> CenteredMessage(
                    text = stringResource(
                        if (state.includeLibrary) MR.strings.discover_empty_filters else MR.strings.discover_empty_filtered,
                    ),
                    onRetry = onRefresh,
                )
                else -> DiscoverSections(
                    sections = result.sections,
                    failedProviders = result.failedProviders,
                    visibleLimits = state.visibleLimits,
                    gridSize = state.gridSize,
                    bottomPadding = bottomPadding,
                    onNearEnd = onShowMore,
                    onClick = { item -> onOpen(item.candidate) },
                )
            }
        }
    }
}

private tailrec fun Context.findMainActivity(): MainActivity? = when (this) {
    is MainActivity -> this
    is ContextWrapper -> baseContext.findMainActivity()
    else -> null
}

/** The For you · Catalog tabs under the title. The Comics / Novels switch lives in the actions. */
@Composable
private fun DiscoverHeader(
    section: DiscoverSection,
    onSection: (DiscoverSection) -> Unit,
) {
    Column(modifier = Modifier.fillMaxWidth()) {
        UnderlineTabs(
            options = listOf(
                DiscoverSection.FOR_YOU to MR.strings.discover_card_title,
                DiscoverSection.CATALOG to MR.strings.discover_catalog,
            ),
            selected = section,
            onSelect = onSection,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        )
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(1.dp)
                .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.08f)),
        )
    }
}

/** Underlined text tabs (For you · Catalog). */
@Composable
private fun <T> UnderlineTabs(
    options: List<Pair<T, StringResource>>,
    selected: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(modifier = modifier, horizontalArrangement = Arrangement.spacedBy(24.dp)) {
        options.forEach { (value, label) ->
            val isSelected = value == selected
            val textColor by animateColorAsState(
                if (isSelected) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                label = "discover-tab-text",
            )
            val barColor by animateColorAsState(
                if (isSelected) MaterialTheme.colorScheme.secondary else Color.Transparent,
                label = "discover-tab-bar",
            )
            Column(
                modifier = Modifier
                    .width(IntrinsicSize.Max)
                    .selectable(
                        selected = isSelected,
                        role = Role.Tab,
                        interactionSource = remember { MutableInteractionSource() },
                        indication = null,
                    ) { onSelect(value) }
                    .padding(top = 12.dp),
            ) {
                Text(
                    text = stringResource(label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = if (isSelected) FontWeight.Bold else FontWeight.Medium,
                    color = textColor,
                    modifier = Modifier.padding(bottom = 10.dp),
                )
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(2.dp)
                        .background(barColor, RoundedCornerShape(1.dp)),
                )
            }
        }
    }
}

/** Discover › Catalog: everything the installed extensions list, with tracker score badges. */
@Composable
private fun DiscoverCatalogGrid(
    entries: List<DiscoverCatalogEntry>,
    gridSize: Float,
    loadingMore: Boolean,
    exhausted: Boolean,
    bottomPadding: Dp,
    onNearEnd: () -> Unit,
    onClick: (RecommendationCandidate) -> Unit,
) {
    val gridState = rememberLazyGridState()
    val currentOnNearEnd by rememberUpdatedState(onNearEnd)
    // Restarts after every page, so a page that added nothing asks for the next one while the
    // end of the grid is still on screen (until the sources are exhausted).
    LaunchedEffect(gridState, exhausted, loadingMore) {
        if (exhausted || loadingMore) return@LaunchedEffect
        snapshotFlow {
            val info = gridState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 6
        }
            .distinctUntilChanged()
            .filter { it }
            .collect { currentOnNearEnd() }
    }
    BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
        val columns = discoverGridColumns(maxWidth.value, gridSize)
        // Tighter gaps once the cards get small, so the covers keep most of the width.
        val gap = if (columns >= 5) 8.dp else 12.dp
        LazyVerticalGrid(
            state = gridState,
            columns = GridCells.Fixed(columns),
            contentPadding = PaddingValues(start = 16.dp, top = 12.dp, end = 16.dp, bottom = bottomPadding + 24.dp),
            horizontalArrangement = Arrangement.spacedBy(gap),
            verticalArrangement = Arrangement.spacedBy(16.dp),
            modifier = Modifier.fillMaxSize(),
        ) {
            items(entries, key = { it.candidate.id }) { entry ->
                CoverCard(
                    candidate = entry.candidate,
                    badge = entry.badge,
                    modifier = Modifier.fillMaxWidth(),
                    onClick = { onClick(entry.candidate) },
                )
            }
            if (loadingMore) {
                item(key = "loading-more", span = { GridItemSpan(maxLineSpan) }) {
                    Box(modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(24.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.secondary,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun DiscoverSections(
    sections: List<RecommendationSection>,
    failedProviders: List<String>,
    visibleLimits: Map<RecommendationSectionKey, Int>,
    gridSize: Float,
    bottomPadding: Dp,
    onNearEnd: (RecommendationSectionKey) -> Unit,
    onClick: (RecommendationItem) -> Unit,
) {
    // Top pick: the card the desktop shows first, the lead of the first taste row. The overall
    // score also counts popularity, so a hit outside the library's format would lead instead.
    // "Outside your usual reads" is off-taste on purpose, so it never leads.
    val hero = remember(sections) {
        sections
            .firstOrNull { it.key != RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS && it.items.isNotEmpty() }
            ?.items?.firstOrNull()
            ?: sections.firstOrNull()?.items?.firstOrNull()
    }
    LazyColumn(
        contentPadding = PaddingValues(top = 16.dp, bottom = bottomPadding + 32.dp),
        verticalArrangement = Arrangement.spacedBy(32.dp),
    ) {
        if (failedProviders.isNotEmpty()) {
            item(key = "summary") {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                    Text(
                        text = stringResource(MR.strings.discover_partial_failure, failedProviders.joinToString()),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
        if (hero != null) {
            item(key = "hero") { HeroPick(hero, onClick = { onClick(hero) }) }
        }
        items(sections, key = { it.key.key }) { section ->
            SectionRow(
                section,
                visibleLimit = visibleLimits[section.key] ?: SEARCH_RECOMMENDATION_BASE_LIMIT,
                gridSize = gridSize,
                onNearEnd = { onNearEnd(section.key) },
                onClick = onClick,
                heroId = hero?.candidate?.id,
            )
        }
    }
}

@Composable
private fun HeroPick(item: RecommendationItem, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.97f else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 600f),
        label = "hero-press",
    )
    BoxWithConstraints(modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        val coverWidth = maxWidth * 0.42f
        Row(
            verticalAlignment = Alignment.Bottom,
            modifier = Modifier
                .graphicsLayer {
                    scaleX = scale
                    scaleY = scale
                }
                .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        ) {
            MangaCover(
                data = item.candidate.coverData(),
                contentDescription = item.candidate.title,
                modifier = Modifier.width(coverWidth),
                ratio = 2f / 3f,
                shape = RoundedCornerShape(12.dp),
                contentScale = ContentScale.Crop,
            )
            Spacer(Modifier.width(16.dp))
            Column(modifier = Modifier.weight(1f).padding(bottom = 4.dp)) {
                Text(
                    stringResource(MR.strings.discover_top_pick),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.secondary,
                )
                Spacer(Modifier.height(4.dp))
                Text(
                    item.candidate.title,
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(8.dp))
                Text(
                    "${item.candidate.cardProviderLabel()}  ·  ${item.candidate.cardStatus().text()}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                item.candidate.cardBanner(item.badge)?.let { banner ->
                    Spacer(Modifier.height(6.dp))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        banner.trackerIcon()?.let { icon ->
                            Image(
                                painter = painterResource(icon),
                                contentDescription = banner.tracker,
                                modifier = Modifier.size(16.dp).clip(RoundedCornerShape(4.dp)),
                            )
                            Spacer(Modifier.width(5.dp))
                        }
                        Text(
                            banner.score,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                        Spacer(Modifier.width(3.dp))
                        Icon(
                            Icons.Rounded.Star,
                            contentDescription = null,
                            tint = ScoreStar,
                            modifier = Modifier.size(16.dp),
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SectionRow(
    section: RecommendationSection,
    visibleLimit: Int,
    gridSize: Float,
    onNearEnd: () -> Unit,
    onClick: (RecommendationItem) -> Unit,
    heroId: String?,
) {
    val (title, _) = section.key.labels()
    val listState = rememberLazyListState()
    val currentOnNearEnd by rememberUpdatedState(onNearEnd)
    LaunchedEffect(listState) {
        snapshotFlow {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            info.totalItemsCount > 0 && last >= info.totalItemsCount - 2
        }
            .distinctUntilChanged()
            .filter { it }
            .collect { currentOnNearEnd() }
    }
    val visibleItems = section.items.filter { it.candidate.id != heroId }.take(visibleLimit)
    if (visibleItems.isEmpty()) return
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(title),
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Spacer(Modifier.height(12.dp))
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            // As many cards as a Catalog row, plus a peek of the next one to show the rail scrolls.
            val columns = discoverGridColumns(maxWidth.value, gridSize)
            val gap = if (columns >= 5) 8.dp else 12.dp
            val cardWidth = (maxWidth - 16.dp - gap * columns) / (columns + 0.3f)
            LazyRow(
                state = listState,
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                items(visibleItems, key = { it.candidate.id }) { item ->
                    CoverCard(
                        candidate = item.candidate,
                        badge = item.badge,
                        modifier = Modifier.width(cardWidth),
                        onClick = { onClick(item) },
                    )
                }
            }
        }
    }
}

@Composable
private fun CoverCard(
    candidate: RecommendationCandidate,
    badge: TrackerScoreBadge?,
    modifier: Modifier,
    onClick: () -> Unit,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.95f else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 600f),
        label = "recommendation-press",
    )
    Column(
        modifier = modifier
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
    ) {
        Box {
            MangaCover(
                data = candidate.coverData(),
                contentDescription = candidate.title,
                modifier = Modifier.fillMaxWidth(),
                ratio = 2f / 3f,
                shape = RoundedCornerShape(10.dp),
                contentScale = ContentScale.Crop,
            )
            candidate.cardBanner(badge)?.let { banner ->
                Row(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(5.dp)
                        .background(Color.Black.copy(alpha = 0.62f), RoundedCornerShape(6.dp))
                        .padding(start = 3.dp, end = 5.dp, top = 2.dp, bottom = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    banner.trackerIcon()?.let { icon ->
                        Image(
                            painter = painterResource(icon),
                            contentDescription = banner.tracker,
                            modifier = Modifier.size(13.dp).clip(RoundedCornerShape(3.dp)),
                        )
                        Spacer(Modifier.width(3.dp))
                    }
                    Text(banner.score, style = MaterialTheme.typography.labelSmall, color = Color.White)
                    Spacer(Modifier.width(2.dp))
                    Icon(
                        Icons.Rounded.Star,
                        contentDescription = null,
                        tint = ScoreStar,
                        modifier = Modifier.size(11.dp),
                    )
                }
            }
        }
        Text(
            text = candidate.title,
            modifier = Modifier.padding(top = 8.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.SemiBold,
        )
        Row(modifier = Modifier.padding(top = 2.dp), verticalAlignment = Alignment.CenterVertically) {
            val metaStyle = MaterialTheme.typography.labelMedium
            val metaColor = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.8f)
            Text(
                text = candidate.cardProviderLabel(),
                modifier = Modifier.weight(1f, fill = false),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = metaStyle,
                color = metaColor,
            )
            Text(text = "  ·  ", maxLines = 1, style = metaStyle, color = metaColor)
            Text(
                text = candidate.cardStatus().text(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                style = metaStyle,
                color = metaColor,
            )
        }
    }
}

/**
 * Card size, on the library grid scale and with its slider steps: -0.5..3 in halves, shown as
 * cards per row. The size applies when the thumb is released, like the library.
 */
@Composable
private fun DiscoverGridSizeRow(gridSize: Float, onGridSizeChange: (Float) -> Unit) {
    var slider by remember(gridSize) { mutableFloatStateOf(((gridSize + .5f) * 2f).roundToInt().toFloat()) }
    BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
        val perRow = discoverGridColumns(maxWidth.value, slider / 2f - .5f)
        Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = stringResource(MR.strings.discover_card_size),
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = stringResource(MR.strings._per_row, perRow),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                TextButton(onClick = { slider = 3f; onGridSizeChange(1f) }, enabled = slider != 3f) {
                    Text(stringResource(MR.strings.reset))
                }
            }
            Slider(
                value = slider,
                onValueChange = { slider = it },
                onValueChangeFinished = { onGridSizeChange(slider / 2f - .5f) },
                valueRange = 0f..7f,
                steps = 6,
            )
        }
    }
}

/** Catalog genre chips (desktop Browse genre list): every selected genre must match. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun DiscoverGenreFilter(
    options: List<String>,
    selected: List<String>,
    onSelectedChange: (List<String>) -> Unit,
) {
    Column(modifier = Modifier.padding(horizontal = 16.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = stringResource(MR.strings.discover_genres),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
                modifier = Modifier.weight(1f),
            )
            TextButton(onClick = { onSelectedChange(emptyList()) }, enabled = selected.isNotEmpty()) {
                Text(stringResource(MR.strings.clear))
            }
        }
        Text(
            text = stringResource(MR.strings.discover_genres_help),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(8.dp))
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            options.forEach { genre ->
                val isSelected = genre in selected
                FilterChip(
                    selected = isSelected,
                    onClick = { onSelectedChange(if (isSelected) selected - genre else selected + genre) },
                    label = { Text(genre) },
                    colors = FilterChipDefaults.filterChipColors(
                        selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer,
                    ),
                )
            }
        }
    }
}

/** The active genre filter above the Catalog grid; a tap removes that genre. */
@Composable
private fun SelectedGenres(genres: List<String>, onRemove: (String) -> Unit) {
    LazyRow(
        contentPadding = PaddingValues(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    ) {
        items(genres, key = { it }) { genre ->
            InputChip(
                selected = true,
                onClick = { onRemove(genre) },
                label = { Text(genre) },
                trailingIcon = {
                    Icon(Icons.Outlined.Close, contentDescription = null, modifier = Modifier.size(InputChipDefaults.IconSize))
                },
            )
        }
    }
}

@Composable
private fun DiscoverFilterRows(
    mode: DiscoverMode,
    includeLibrary: Boolean,
    includeNsfw: Boolean,
    onIncludeLibraryChange: (Boolean) -> Unit,
    onIncludeNsfwChange: (Boolean) -> Unit,
) {
    val libraryLabel = if (mode == DiscoverMode.COMICS) MR.strings.discover_include_library_comics else MR.strings.discover_include_library_novels
    val libraryHelp = when {
        includeLibrary -> MR.strings.discover_include_library_on_help
        mode == DiscoverMode.COMICS -> MR.strings.discover_include_library_off_help_comics
        else -> MR.strings.discover_include_library_off_help_novels
    }
    Column {
        DiscoverSwitchRow(
            label = stringResource(libraryLabel),
            help = stringResource(libraryHelp),
            checked = includeLibrary,
            onCheckedChange = onIncludeLibraryChange,
        )
        DiscoverSwitchRow(
            label = stringResource(MR.strings.discover_include_nsfw),
            help = null,
            checked = includeNsfw,
            onCheckedChange = onIncludeNsfwChange,
        )
    }
}

@Composable
private fun DiscoverSwitchRow(
    label: String,
    help: String?,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 16.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(text = label, style = MaterialTheme.typography.bodyLarge)
            if (help != null) {
                Text(
                    text = help,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.width(16.dp))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@Composable
private fun CenteredBox(content: @Composable () -> Unit) {
    Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { content() }
}

@Composable
private fun CenteredMessage(text: String, onRetry: () -> Unit) {
    CenteredMessage(text = text, actionLabel = stringResource(MR.strings.retry), onAction = onRetry)
}

@Composable
private fun CenteredMessage(text: String, actionLabel: String, onAction: () -> Unit) {
    CenteredBox {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = onAction, shape = MaterialTheme.shapes.small) { Text(actionLabel) }
        }
    }
}

private fun epigraph.recommendations.RecommendationCandidate.coverData(): Any? {
    val cover = cover ?: return null
    return when {
        cover.sourceId != null -> CoverData(mangaId = null, sourceId = cover.sourceId, url = cover.url, lastModified = 0L, inLibrary = false)
        cover.url.startsWith("/") -> File(cover.url)
        else -> cover.url
    }
}

// The desktop's golden score star.
private val ScoreStar = Color(0xFFFFB800)

@Composable
private fun RecommendationCardStatus.text(): String = when (this) {
    is RecommendationCardStatus.Text -> text
    is RecommendationCardStatus.Known -> stringResource(
        when (status) {
            RecommendationCardKnownStatus.ONGOING -> MR.strings.ongoing
            RecommendationCardKnownStatus.COMPLETED -> MR.strings.completed
            RecommendationCardKnownStatus.CANCELLED -> MR.strings.cancelled
            RecommendationCardKnownStatus.HIATUS -> MR.strings.on_hiatus
            RecommendationCardKnownStatus.UNKNOWN -> MR.strings.unknown
            RecommendationCardKnownStatus.IN_LIBRARY -> MR.strings.in_library
        },
    )
}

private fun RecommendationCardBanner.trackerIcon(): Int? = when (tracker) {
    "anilist" -> R.drawable.ic_tracker_anilist
    "myanimelist" -> R.drawable.ic_tracker_mal
    "kitsu" -> R.drawable.ic_tracker_kitsu
    "bangumi" -> R.drawable.ic_tracker_bangumi
    "mangaupdates" -> R.drawable.ic_tracker_manga_updates
    "hardcover" -> R.drawable.ic_tracker_hardcover
    else -> null
}

private fun RecommendationSectionKey.labels(): Pair<StringResource, StringResource> = when (this) {
    RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY -> MR.strings.discover_section_profile to MR.strings.discover_section_profile_reason
    RecommendationSectionKey.HIGH_CONFIDENCE -> MR.strings.discover_section_confidence to MR.strings.discover_section_confidence_reason
    RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE -> MR.strings.discover_section_trending to MR.strings.discover_section_trending_reason
    RecommendationSectionKey.FRESH_IN_YOUR_SOURCES -> MR.strings.discover_section_fresh to MR.strings.discover_section_fresh_reason
    RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS -> MR.strings.discover_section_outside to MR.strings.discover_section_outside_reason
}
