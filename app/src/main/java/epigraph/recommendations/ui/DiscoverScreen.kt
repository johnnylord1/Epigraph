package epigraph.recommendations.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.model.rememberScreenModel
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.stringResource
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.RecommendationContentType
import epigraph.recommendations.RecommendationItem
import epigraph.recommendations.RecommendationSection
import epigraph.recommendations.RecommendationSectionKey
import epigraph.recommendations.SEARCH_RECOMMENDATION_BASE_LIMIT
import eu.kanade.tachiyomi.ui.manga.MangaDetailsController
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchController
import eu.kanade.tachiyomi.util.compose.LocalBackPress
import eu.kanade.tachiyomi.util.compose.LocalRouter
import eu.kanade.tachiyomi.util.compose.currentOrThrow
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import java.io.File
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import yokai.domain.manga.models.MangaCover as CoverData
import yokai.i18n.MR
import yokai.presentation.AppBarType
import yokai.presentation.YokaiScaffold
import yokai.presentation.manga.components.MangaCover
import yokai.util.Screen

class DiscoverScreen(private val initialMode: DiscoverMode) : Screen() {

@OptIn(ExperimentalMaterial3Api::class)
    @Composable
    override fun Content() {
        val backPress = LocalBackPress.currentOrThrow
        val router = LocalRouter.current
        val scope = rememberCoroutineScope()
        val screenModel = rememberScreenModel { DiscoverScreenModel(initialMode) }
        val state by screenModel.state.collectAsState()
        var showFilterSheet by remember { mutableStateOf(false) }

        YokaiScaffold(
            onNavigationIconClicked = backPress::invoke,
            title = stringResource(MR.strings.discover_card_title),
            navigationIcon = Icons.AutoMirrored.Outlined.ArrowBack,
            appBarType = AppBarType.SMALL,
            actions = {
                IconButton(onClick = { showFilterSheet = true }) {
                    Icon(Icons.Outlined.FilterList, contentDescription = stringResource(MR.strings.filter))
                }
                IconButton(onClick = { screenModel.load(force = true) }, enabled = !state.loading) {
                    Icon(Icons.Outlined.Refresh, contentDescription = stringResource(MR.strings.refresh))
                }
            },
        ) { contentPadding ->
            Column(modifier = Modifier.fillMaxSize().padding(contentPadding)) {
                ModeSelector(state.mode, onSelect = screenModel::setMode)
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
                        onRetry = { screenModel.load(force = true) },
                    )
                    result.sections.isEmpty() -> CenteredMessage(
                        text = stringResource(
                            if (state.includeLibrary) MR.strings.discover_empty_filters else MR.strings.discover_empty_filtered,
                        ),
                        onRetry = { screenModel.load(force = true) },
                    )
                    else -> DiscoverSections(
                        sections = result.sections,
                        failedProviders = result.failedProviders,
                        visibleLimits = state.visibleLimits,
                        onNearEnd = screenModel::showMore,
                        onClick = { item ->
                            scope.launch {
                                val manga = runCatching { screenModel.resolveLocalManga(item) }.getOrNull()
                                val controller = if (manga?.id != null) {
                                    MangaDetailsController(manga, fromCatalogue = true)
                                } else {
                                    GlobalSearchController(item.candidate.title)
                                }
                                router?.pushController(controller.withFadeTransaction())
                            }
                        },
                    )
                }
            }
        }
        if (showFilterSheet) {
            ModalBottomSheet(
                onDismissRequest = { showFilterSheet = false },
                sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
            ) {
                Column(
                    modifier = Modifier
                        .navigationBarsPadding()
                        .padding(bottom = 16.dp),
                ) {
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
                }
            }
        }
    }
}

@Composable
private fun ModeSelector(mode: DiscoverMode, onSelect: (DiscoverMode) -> Unit) {
    val modes = listOf(DiscoverMode.COMICS to MR.strings.discover_comics, DiscoverMode.NOVELS to MR.strings.novels)
    BoxWithConstraints(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .height(40.dp)
            .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.05f), RoundedCornerShape(12.dp))
            .padding(3.dp),
    ) {
        val segmentWidth = maxWidth / modes.size
        val selectedIndex = modes.indexOfFirst { it.first == mode }.coerceAtLeast(0)
        val indicatorOffset by animateDpAsState(
            targetValue = segmentWidth * selectedIndex,
            animationSpec = spring(dampingRatio = 0.72f, stiffness = 420f),
            label = "discover-mode-indicator",
        )
        Box(
            modifier = Modifier
                .offset(x = indicatorOffset)
                .width(segmentWidth)
                .fillMaxHeight()
                .background(MaterialTheme.colorScheme.secondary.copy(alpha = 0.16f), RoundedCornerShape(9.dp)),
        )
        Row(modifier = Modifier.fillMaxSize()) {
            modes.forEach { (value, label) ->
                val selected = value == mode
                val color by animateColorAsState(
                    if (selected) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.onSurfaceVariant,
                    label = "discover-mode-color",
                )
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .fillMaxHeight()
                        .clip(RoundedCornerShape(9.dp))
                        .clickable { onSelect(value) },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = stringResource(label),
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Medium,
                        color = color,
                    )
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
    onNearEnd: (RecommendationSectionKey) -> Unit,
    onClick: (RecommendationItem) -> Unit,
) {
    LazyColumn(
        contentPadding = PaddingValues(top = 4.dp, bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
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
        items(sections, key = { it.key.key }) { section ->
            SectionRow(
                section,
                visibleLimit = visibleLimits[section.key] ?: SEARCH_RECOMMENDATION_BASE_LIMIT,
                onNearEnd = { onNearEnd(section.key) },
                onClick = onClick,
            )
        }
    }
}

@Composable
private fun SectionRow(
    section: RecommendationSection,
    visibleLimit: Int,
    onNearEnd: () -> Unit,
    onClick: (RecommendationItem) -> Unit,
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
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        BoxWithConstraints(modifier = Modifier.fillMaxWidth()) {
            val cardWidth = (maxWidth - 16.dp * 4) / 3
            LazyRow(
                state = listState,
                contentPadding = PaddingValues(horizontal = 16.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                items(section.items.take(visibleLimit), key = { it.candidate.id }) { item ->
                    RecommendationCard(item, cardWidth = cardWidth, onClick = { onClick(item) })
                }
            }
        }
    }
}

@Composable
private fun RecommendationCard(item: RecommendationItem, cardWidth: Dp, onClick: () -> Unit) {
    val candidate = item.candidate
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val scale by animateFloatAsState(
        targetValue = if (pressed) 0.95f else 1f,
        animationSpec = spring(dampingRatio = 0.55f, stiffness = 600f),
        label = "recommendation-press",
    )
    Column(
        modifier = Modifier
            .width(cardWidth)
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
            item.badge?.let { badge ->
                Row(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(5.dp)
                        .background(Color.Black.copy(alpha = 0.62f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.Star,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.secondary,
                        modifier = Modifier.width(11.dp).height(11.dp),
                    )
                    Spacer(Modifier.width(2.dp))
                    Text(badge.displayScore, style = MaterialTheme.typography.labelSmall, color = Color.White)
                }
            }
        }
        Text(
            text = candidate.title,
            modifier = Modifier.padding(top = 6.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall,
            fontWeight = FontWeight.Medium,
        )
        Text(
            text = candidate.contentType.label(),
            maxLines = 1,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
    CenteredBox {
        Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(32.dp)) {
            Text(
                text = text,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(12.dp))
            Button(onClick = onRetry, shape = MaterialTheme.shapes.small) { Text(stringResource(MR.strings.retry)) }
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

private fun RecommendationContentType.label(): String = when (this) {
    RecommendationContentType.MANGA -> "Manga"
    RecommendationContentType.MANHWA -> "Manhwa"
    RecommendationContentType.MANHUA -> "Manhua"
    RecommendationContentType.NOVEL -> "Novel"
    RecommendationContentType.BOOK -> "Book"
}

private fun RecommendationSectionKey.labels(): Pair<StringResource, StringResource> = when (this) {
    RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY -> MR.strings.discover_section_profile to MR.strings.discover_section_profile_reason
    RecommendationSectionKey.HIGH_CONFIDENCE -> MR.strings.discover_section_confidence to MR.strings.discover_section_confidence_reason
    RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE -> MR.strings.discover_section_trending to MR.strings.discover_section_trending_reason
    RecommendationSectionKey.FRESH_IN_YOUR_SOURCES -> MR.strings.discover_section_fresh to MR.strings.discover_section_fresh_reason
    RecommendationSectionKey.OUTSIDE_YOUR_USUAL_READS -> MR.strings.discover_section_outside to MR.strings.discover_section_outside_reason
}
