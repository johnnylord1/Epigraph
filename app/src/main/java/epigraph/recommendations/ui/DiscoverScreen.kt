package epigraph.recommendations.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.rounded.Star
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cafe.adriel.voyager.core.model.rememberScreenModel
import dev.icerock.moko.resources.StringResource
import dev.icerock.moko.resources.compose.stringResource
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.RecommendationContentType
import epigraph.recommendations.RecommendationItem
import epigraph.recommendations.RecommendationSection
import epigraph.recommendations.RecommendationSectionKey
import eu.kanade.tachiyomi.ui.manga.MangaDetailsController
import eu.kanade.tachiyomi.ui.source.globalsearch.GlobalSearchController
import eu.kanade.tachiyomi.util.compose.LocalBackPress
import eu.kanade.tachiyomi.util.compose.LocalRouter
import eu.kanade.tachiyomi.util.compose.currentOrThrow
import eu.kanade.tachiyomi.util.view.withFadeTransaction
import java.io.File
import kotlinx.coroutines.launch
import yokai.domain.manga.models.MangaCover as CoverData
import yokai.i18n.MR
import yokai.presentation.AppBarType
import yokai.presentation.YokaiScaffold
import yokai.presentation.manga.components.MangaCover
import yokai.util.Screen

class DiscoverScreen(private val initialMode: DiscoverMode) : Screen() {

    @Composable
    override fun Content() {
        val backPress = LocalBackPress.currentOrThrow
        val router = LocalRouter.current
        val scope = rememberCoroutineScope()
        val screenModel = rememberScreenModel { DiscoverScreenModel(initialMode) }
        val state by screenModel.state.collectAsState()

        YokaiScaffold(
            onNavigationIconClicked = backPress::invoke,
            title = stringResource(MR.strings.discover),
            navigationIcon = Icons.AutoMirrored.Outlined.ArrowBack,
            appBarType = AppBarType.SMALL,
            actions = {
                IconButton(onClick = { screenModel.load(force = true) }, enabled = !state.loading) {
                    Icon(Icons.Outlined.Refresh, contentDescription = stringResource(MR.strings.refresh))
                }
            },
        ) { contentPadding ->
            Column(modifier = Modifier.fillMaxSize().padding(contentPadding)) {
                ModeSelector(state.mode, onSelect = screenModel::setMode)
                if (state.loading && state.result != null) {
                    LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
                }
                val result = state.result
                when {
                    result == null && state.loading -> CenteredBox { CircularProgressIndicator() }
                    result == null -> CenteredMessage(
                        text = stringResource(MR.strings.discover_error) +
                            state.error?.takeIf { it.isNotBlank() }?.let { "\n$it" }.orEmpty(),
                        onRetry = { screenModel.load(force = true) },
                    )
                    result.sections.isEmpty() -> CenteredMessage(
                        text = stringResource(MR.strings.discover_empty),
                        onRetry = { screenModel.load(force = true) },
                    )
                    else -> DiscoverSections(
                        sections = result.sections,
                        seedCount = result.seedCount,
                        failedProviders = result.failedProviders,
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
    }
}

@Composable
private fun ModeSelector(mode: DiscoverMode, onSelect: (DiscoverMode) -> Unit) {
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        FilterChip(
            selected = mode == DiscoverMode.COMICS,
            onClick = { onSelect(DiscoverMode.COMICS) },
            label = { Text(stringResource(MR.strings.discover_comics)) },
        )
        FilterChip(
            selected = mode == DiscoverMode.NOVELS,
            onClick = { onSelect(DiscoverMode.NOVELS) },
            label = { Text(stringResource(MR.strings.novels)) },
        )
    }
}

@Composable
private fun DiscoverSections(
    sections: List<RecommendationSection>,
    seedCount: Int,
    failedProviders: List<String>,
    onClick: (RecommendationItem) -> Unit,
) {
    LazyColumn(
        contentPadding = PaddingValues(bottom = 24.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        item(key = "summary") {
            Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp)) {
                if (seedCount > 0) {
                    Text(
                        text = stringResource(MR.strings.discover_seed_count, seedCount),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (failedProviders.isNotEmpty()) {
                    Text(
                        text = stringResource(MR.strings.discover_partial_failure, failedProviders.joinToString()),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        }
        items(sections, key = { it.key.key }) { section ->
            SectionRow(section, onClick)
        }
    }
}

@Composable
private fun SectionRow(section: RecommendationSection, onClick: (RecommendationItem) -> Unit) {
    val (title, reason) = section.key.labels()
    Column(modifier = Modifier.fillMaxWidth()) {
        Text(
            text = stringResource(title),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 16.dp),
        )
        Text(
            text = stringResource(reason),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 2.dp, bottom = 10.dp),
        )
        LazyRow(
            contentPadding = PaddingValues(horizontal = 16.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            items(section.items, key = { it.candidate.id }) { item ->
                RecommendationCard(item, onClick = { onClick(item) })
            }
        }
    }
}

@Composable
private fun RecommendationCard(item: RecommendationItem, onClick: () -> Unit) {
    val candidate = item.candidate
    Column(
        modifier = Modifier
            .width(112.dp)
            .clickable(onClick = onClick),
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
                        .padding(4.dp)
                        .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.88f), RoundedCornerShape(6.dp))
                        .padding(horizontal = 5.dp, vertical = 1.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        Icons.Rounded.Star,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.width(12.dp).height(12.dp),
                    )
                    Spacer(Modifier.width(2.dp))
                    Text(badge.displayScore, style = MaterialTheme.typography.labelSmall)
                }
            }
            Text(
                text = candidate.contentType.label(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier
                    .align(Alignment.BottomStart)
                    .padding(4.dp)
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.9f), RoundedCornerShape(4.dp))
                    .padding(horizontal = 4.dp),
            )
        }
        Text(
            text = candidate.title,
            modifier = Modifier.padding(top = 4.dp),
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall,
        )
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
            Button(onClick = onRetry) { Text(stringResource(MR.strings.retry)) }
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
