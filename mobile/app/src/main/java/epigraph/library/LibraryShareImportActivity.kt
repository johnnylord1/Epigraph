package epigraph.library

import android.content.Context
import android.content.Intent
import android.os.Bundle
import androidx.activity.compose.setContent
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.outlined.Book
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Download
import androidx.compose.material.icons.outlined.Extension
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.DropdownMenuPopup
import androidx.compose.material3.DropdownMenuPopupPositionProvider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImagePainter
import dev.icerock.moko.resources.compose.stringResource
import eu.kanade.tachiyomi.data.database.models.Category
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.system.setThemeByPref
import eu.kanade.tachiyomi.util.system.toast
import kotlinx.coroutines.launch
import yokai.data.DatabaseHandler
import yokai.domain.category.interactor.GetCategories
import yokai.domain.category.interactor.SetMangaCategories
import yokai.domain.extension.repo.interactor.CreateExtensionRepo
import yokai.domain.manga.interactor.GetManga
import yokai.domain.manga.interactor.InsertManga
import yokai.domain.manga.interactor.UpdateManga
import yokai.domain.manga.models.MangaCover
import yokai.i18n.MR
import yokai.presentation.manga.components.MangaCover as MangaCoverImage
import yokai.presentation.theme.Size
import yokai.presentation.theme.YokaiTheme
import yokai.util.koin.injectLazy
import yokai.util.lang.getString

private val ComparisonCoverWidth = 128.dp
private val ComparisonCoverHeight = 192.dp

class LibraryShareImportActivity : AppCompatActivity() {
    private val preferences: PreferencesHelper by injectLazy()
    private val extensionManager: ExtensionManager by injectLazy()
    private val sourceManager: SourceManager by injectLazy()
    private val createExtensionRepo: CreateExtensionRepo by injectLazy()
    private val getManga: GetManga by injectLazy()
    private val insertManga: InsertManga by injectLazy()
    private val updateManga: UpdateManga by injectLazy()
    private val getCategories: GetCategories by injectLazy()
    private val setMangaCategories: SetMangaCategories by injectLazy()
    private val databaseHandler: DatabaseHandler by injectLazy()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setThemeByPref(preferences)
        val rawLink = intent.getStringExtra(EXTRA_LINK).orEmpty()
        val coordinator = LibraryShareImportCoordinator(
            extensionManager = extensionManager,
            sourceManager = sourceManager,
            createExtensionRepo = createExtensionRepo,
            getManga = getManga,
            insertManga = insertManga,
            updateManga = updateManga,
            getCategories = getCategories,
            setMangaCategories = setMangaCategories,
            databaseHandler = databaseHandler,
        )

        setContent {
            YokaiTheme {
                LibraryShareImportScreen(
                    rawLink = rawLink,
                    coordinator = coordinator,
                    defaultCategoryId = preferences.defaultCategory().get(),
                    onClose = { finish() },
                    onImported = { count ->
                        toast(
                            if (count == 1) {
                                getString(MR.strings.library_import_toast_added_one)
                            } else {
                                getString(MR.strings.library_import_toast_added_many, count)
                            },
                        )
                        finish()
                    },
                )
            }
        }
    }

    companion object {
        private const val EXTRA_LINK = "epigraph.library_share.import_link"

        fun intent(context: Context, rawLink: String): Intent =
            Intent(context, LibraryShareImportActivity::class.java)
                .putExtra(EXTRA_LINK, rawLink)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LibraryShareImportScreen(
    rawLink: String,
    coordinator: LibraryShareImportCoordinator,
    defaultCategoryId: Int,
    onClose: () -> Unit,
    onImported: (Int) -> Unit,
) {
    val scope = rememberCoroutineScope()
    var loading by remember { mutableStateOf(true) }
    var loadError by remember { mutableStateOf(false) }
    var plan by remember { mutableStateOf<ShareImportPlan?>(null) }
    var works by remember { mutableStateOf<List<ShareImportWorkRow>>(emptyList()) }
    var extensions by remember { mutableStateOf<List<ShareImportExtensionItem>>(emptyList()) }
    var installingSourceIds by remember { mutableStateOf<Set<Long>>(emptySet()) }
    var failedSourceIds by remember { mutableStateOf<Set<Long>>(emptySet()) }
    var batchSearching by remember { mutableStateOf(false) }
    var importing by remember { mutableStateOf(false) }
    var importError by remember { mutableStateOf(false) }
    var extraCategoryIds by remember { mutableStateOf(emptySet<Int>()) }

    suspend fun hydrate(keepAlternatives: Boolean) {
        val previousByKey = works.associateBy { it.key }
        val manifest = plan?.manifest ?: LibraryShareLink.resolveIncomingManifest(rawLink)
        if (manifest == null) {
            loadError = true
            return
        }
        val next = coordinator.analyze(manifest)
        plan = next
        extensions = next.extensions
        works = next.works.map { work ->
            if (!keepAlternatives) return@map work
            val prev = previousByKey[work.key] ?: return@map work
            val becameInstalled = work.extensionStatus == ShareImportExtensionStatus.INSTALLED &&
                prev.extensionStatus != ShareImportExtensionStatus.INSTALLED
            work.copy(
                cover = work.cover ?: prev.cover,
                candidates = prev.candidates,
                searchDone = prev.searchDone,
                chosenAlternative = if (work.extensionStatus == ShareImportExtensionStatus.INSTALLED) null else prev.chosenAlternative,
                selected = if (becameInstalled) !work.alreadyInLibrary && work.ownedInOtherSource == null && !work.isLocal else prev.selected,
            )
        }
    }

    LaunchedEffect(rawLink) {
        loading = true
        loadError = false
        try {
            hydrate(keepAlternatives = false)
        } catch (_: Exception) {
            loadError = true
        } finally {
            loading = false
        }
    }

    val coverFetchKeys = remember(works) {
        works.filter {
            !it.isLocal && it.cover == null &&
                it.extensionStatus == ShareImportExtensionStatus.INSTALLED &&
                it.sourceId != null
        }.map { it.key }
    }
    LaunchedEffect(coverFetchKeys) {
        for (key in coverFetchKeys) {
            val row = works.firstOrNull { it.key == key } ?: continue
            val srcId = row.sourceId ?: continue
            val loaded = coordinator.fetchCoverForInstalledWork(srcId, row.url, row.title) ?: continue
            works = works.map { if (it.key == key && it.cover == null) it.copy(cover = loaded) else it }
        }
    }

    val missingExtensions = remember(extensions) {
        extensions.filter { it.status != ShareImportExtensionStatus.INSTALLED }
    }
    val installableMissing = remember(missingExtensions) {
        missingExtensions.filter {
            it.status == ShareImportExtensionStatus.AVAILABLE || it.status == ShareImportExtensionStatus.NEEDS_REPO
        }
    }
    val installedSources = plan?.installedCatalogueSources.orEmpty()
    val extraCategories = plan?.categories.orEmpty().filterNot { it.id == defaultCategoryId }
    val ownedCount = remember(works) { works.count { it.alreadyInLibrary || it.ownedInOtherSource != null } }
    val selectedCount = remember(works) { works.count { it.selected && it.isReady } }
    val missingWorksCount = remember(works) {
        works.count {
            !it.isLocal && !it.alreadyInLibrary &&
                it.ownedInOtherSource == null &&
                it.extensionStatus != ShareImportExtensionStatus.INSTALLED &&
                it.chosenAlternative == null
        }
    }

    val colors = MaterialTheme.colorScheme
    val shapes = MaterialTheme.shapes
    val successColor = colors.onTertiary
    val accentColor = colors.primary
    val dangerColor = colors.error
    val dividerColor = colors.outlineVariant

    fun chooseAlternative(workKey: String, candidate: ShareImportAlternativeMatch?, selected: Boolean) {
        works = works.map { if (it.key == workKey) it.copy(chosenAlternative = candidate, selected = selected) else it }
    }

    fun setWorkSelected(workKey: String, selected: Boolean) {
        works = works.map { if (it.key == workKey && it.isReady) it.copy(selected = selected) else it }
    }

    fun installOne(ext: ShareImportExtensionItem, silentBatch: Boolean = false) {
        if (ext.sourceId in installingSourceIds || importing) return
        scope.launch {
            installingSourceIds = installingSourceIds + ext.sourceId
            failedSourceIds = failedSourceIds - ext.sourceId
            try {
                val ok = coordinator.installExtension(ext, useSilentBatchInstaller = silentBatch)
                if (ok) {
                    hydrate(keepAlternatives = true)
                } else {
                    failedSourceIds = failedSourceIds + ext.sourceId
                }
            } catch (_: Exception) {
                failedSourceIds = failedSourceIds + ext.sourceId
            } finally {
                installingSourceIds = installingSourceIds - ext.sourceId
            }
        }
    }

    fun searchOne(target: ShareImportWorkRow) {
        if (target.searching || batchSearching || installedSources.isEmpty() || importing) return
        scope.launch {
            works = works.map { if (it.key == target.key) it.copy(searching = true) else it }
            val candidates = runCatching {
                coordinator.searchInInstalledSources(target.title, installedSources)
            }.getOrDefault(emptyList())
            val top = candidates.firstOrNull()
            works = works.map { work ->
                if (work.key != target.key) {
                    work
                } else {
                    work.copy(
                        searching = false,
                        searchDone = true,
                        candidates = candidates,
                        chosenAlternative = work.chosenAlternative ?: top.takeUnless { work.isReady },
                        selected = work.selected || (top != null && !work.isReady && work.ownedInOtherSource == null),
                    )
                }
            }
        }
    }

    fun searchAllMissing() {
        if (batchSearching || installedSources.isEmpty() || importing) return
        scope.launch {
            batchSearching = true
            try {
                val queue = works.filter {
                    !it.isLocal && !it.alreadyInLibrary &&
                        it.ownedInOtherSource == null &&
                        it.extensionStatus != ShareImportExtensionStatus.INSTALLED &&
                        it.chosenAlternative == null && !it.searching
                }
                for (work in queue) {
                    works = works.map { if (it.key == work.key) it.copy(searching = true) else it }
                    val candidates = runCatching {
                        coordinator.searchInInstalledSources(work.title, installedSources)
                    }.getOrDefault(emptyList())
                    val top = candidates.firstOrNull()
                    works = works.map { row ->
                        if (row.key != work.key) {
                            row
                        } else {
                            row.copy(
                                searching = false,
                                searchDone = true,
                                candidates = candidates,
                                chosenAlternative = top,
                                selected = top != null || row.selected,
                            )
                        }
                    }
                }
            } finally {
                batchSearching = false
            }
        }
    }

    Scaffold(
        containerColor = colors.background,
        topBar = {
            TopAppBar(
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = colors.background,
                    scrolledContainerColor = colors.surfaceContainer,
                ),
                title = {
                    Column {
                        Text(
                            text = stringResource(MR.strings.library_import_title),
                            style = MaterialTheme.typography.titleLarge,
                            color = colors.onBackground,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (!loading && !loadError) {
                            Text(
                                text = stringResource(MR.strings.library_import_summary, works.size, ownedCount),
                                style = MaterialTheme.typography.bodySmall,
                                color = colors.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                },
                navigationIcon = {
                    IconButton(onClick = { if (!importing) onClose() }) {
                        Icon(
                            Icons.Outlined.Close,
                            contentDescription = null,
                            tint = colors.onBackground,
                        )
                    }
                },
            )
        },
        bottomBar = {
            if (!loading && !loadError) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(colors.surfaceContainer)
                        .navigationBarsPadding(),
                ) {
                    HorizontalDivider(color = dividerColor)
                    if (importError) {
                        Text(
                            text = stringResource(MR.strings.library_import_failed),
                            color = dangerColor,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(start = Size.medium, end = Size.medium, top = Size.small),
                        )
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Size.medium, vertical = 12.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(Size.small),
                    ) {
                        if (extraCategories.isNotEmpty()) {
                            ExtraFoldersMenu(
                                categories = extraCategories,
                                selectedIds = extraCategoryIds,
                                enabled = !importing,
                                onToggle = { id ->
                                    extraCategoryIds = if (id in extraCategoryIds) {
                                        extraCategoryIds - id
                                    } else {
                                        extraCategoryIds + id
                                    }
                                },
                            )
                        }

                        Spacer(modifier = Modifier.weight(1f))

                        Button(
                            modifier = Modifier.height(48.dp),
                            shape = shapes.small,
                            contentPadding = PaddingValues(horizontal = 20.dp),
                            enabled = selectedCount > 0 && !importing,
                            onClick = {
                                scope.launch {
                                    importing = true
                                    importError = false
                                    try {
                                        val added = coordinator.importSelectedWorks(works, defaultCategoryId, extraCategoryIds)
                                        onImported(added)
                                    } catch (_: Exception) {
                                        importError = true
                                    } finally {
                                        importing = false
                                    }
                                }
                            },
                        ) {
                            Text(
                                text = when {
                                    importing -> stringResource(MR.strings.library_import_importing)
                                    selectedCount == 1 -> stringResource(MR.strings.library_import_add_one)
                                    else -> stringResource(MR.strings.library_import_add_many, selectedCount)
                                },
                                style = MaterialTheme.typography.labelLarge,
                            )
                        }
                    }
                }
            }
        },
    ) { padding ->
        when {
            loading -> LoadingSkeletonCards(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
            )
            loadError -> Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding)
                    .padding(Size.large),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = stringResource(MR.strings.library_import_load_failed),
                    color = dangerColor,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
            else -> LazyColumn(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(padding),
                contentPadding = PaddingValues(top = Size.tiny, bottom = Size.large),
            ) {
                if (missingExtensions.isNotEmpty()) {
                    if (installedSources.isNotEmpty() && missingWorksCount > 0) {
                        item(key = "search-all-lead") {
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable(enabled = !batchSearching && !importing) { searchAllMissing() }
                                    .padding(horizontal = Size.medium, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(Size.medium),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(40.dp)
                                        .clip(shapes.small)
                                        .background(colors.primaryContainer),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (batchSearching) {
                                        CircularProgressIndicator(
                                            modifier = Modifier.size(18.dp),
                                            strokeWidth = 2.dp,
                                            color = accentColor,
                                        )
                                    } else {
                                        Icon(
                                            Icons.Outlined.Search,
                                            contentDescription = null,
                                            tint = accentColor,
                                            modifier = Modifier.size(20.dp),
                                        )
                                    }
                                }
                                Text(
                                    text = if (batchSearching) {
                                        stringResource(MR.strings.library_import_searching_all)
                                    } else {
                                        stringResource(MR.strings.library_import_search_all_installed)
                                    },
                                    style = MaterialTheme.typography.titleMedium,
                                    color = colors.onBackground,
                                    modifier = Modifier.weight(1f),
                                )
                                Icon(
                                    Icons.AutoMirrored.Outlined.ArrowForward,
                                    contentDescription = null,
                                    tint = colors.onSurfaceVariant,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                        }
                    }

                    item(key = "ext-header") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(start = Size.medium, end = Size.medium, top = Size.small, bottom = Size.tiny),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = stringResource(MR.strings.library_import_extensions_heading),
                                style = MaterialTheme.typography.labelLarge,
                                color = colors.onSurfaceVariant,
                            )
                            if (installableMissing.size > 1) {
                                QuietActionLabel(
                                    text = stringResource(MR.strings.library_import_install_all),
                                    enabled = installingSourceIds.isEmpty() && !importing,
                                    onClick = {
                                        scope.launch {
                                            for (ext in installableMissing) {
                                                installingSourceIds = installingSourceIds + ext.sourceId
                                                try {
                                                    val ok = coordinator.installExtension(ext, useSilentBatchInstaller = true)
                                                    if (ok) hydrate(keepAlternatives = true)
                                                    else failedSourceIds = failedSourceIds + ext.sourceId
                                                } catch (_: Exception) {
                                                    failedSourceIds = failedSourceIds + ext.sourceId
                                                } finally {
                                                    installingSourceIds = installingSourceIds - ext.sourceId
                                                }
                                            }
                                        }
                                    },
                                )
                            }
                        }
                    }

                    items(missingExtensions, key = { "ext:${it.sourceId}" }) { ext ->
                        val busy = ext.sourceId in installingSourceIds
                        val failed = ext.sourceId in failedSourceIds
                        val canInstall = ext.status == ShareImportExtensionStatus.AVAILABLE ||
                            ext.status == ShareImportExtensionStatus.NEEDS_REPO
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable(enabled = canInstall && !busy && !importing) { installOne(ext) }
                                .padding(horizontal = Size.medium, vertical = Size.small),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(Size.medium),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(40.dp)
                                    .clip(shapes.small)
                                    .background(colors.surfaceContainerHigh),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    Icons.Outlined.Extension,
                                    contentDescription = null,
                                    tint = colors.onSurfaceVariant,
                                    modifier = Modifier.size(20.dp),
                                )
                            }
                            Column(
                                modifier = Modifier.weight(1f),
                                verticalArrangement = Arrangement.spacedBy(2.dp),
                            ) {
                                Text(
                                    text = ext.extensionName ?: ext.sourceName,
                                    style = MaterialTheme.typography.titleMedium,
                                    color = colors.onBackground,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                                val sub = when (ext.status) {
                                    ShareImportExtensionStatus.NEEDS_REPO -> stringResource(
                                        MR.strings.library_import_repo_auto_notice,
                                        ext.repoLabel ?: ext.repoUrl.orEmpty(),
                                    )
                                    ShareImportExtensionStatus.AVAILABLE -> stringResource(MR.strings.library_import_extension_available)
                                    else -> stringResource(MR.strings.library_import_extension_unavailable)
                                }
                                Text(
                                    text = if (failed) {
                                        stringResource(MR.strings.library_import_extension_install_failed)
                                    } else {
                                        sub
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = if (failed) dangerColor else colors.onSurfaceVariant,
                                )
                            }
                            if (canInstall) {
                                if (busy) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(18.dp),
                                        strokeWidth = 2.dp,
                                        color = accentColor,
                                    )
                                } else {
                                    Row(
                                        verticalAlignment = Alignment.CenterVertically,
                                        horizontalArrangement = Arrangement.spacedBy(Size.tiny),
                                    ) {
                                        Icon(
                                            Icons.Outlined.Download,
                                            contentDescription = null,
                                            tint = accentColor,
                                            modifier = Modifier.size(16.dp),
                                        )
                                        Text(
                                            text = if (ext.status == ShareImportExtensionStatus.NEEDS_REPO) {
                                                stringResource(MR.strings.library_import_add_repo_and_install)
                                            } else {
                                                stringResource(MR.strings.library_import_install_extension)
                                            },
                                            style = MaterialTheme.typography.labelLarge,
                                            color = accentColor,
                                        )
                                    }
                                }
                            }
                        }
                    }

                    item(key = "divider") {
                        HorizontalDivider(
                            modifier = Modifier.padding(horizontal = Size.medium, vertical = Size.small),
                            color = dividerColor,
                        )
                    }
                }

                item(key = "works-header") {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = Size.medium, end = Size.medium, top = Size.small, bottom = Size.small),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.SpaceBetween,
                    ) {
                        Text(
                            text = stringResource(MR.strings.library_import_works_heading),
                            style = MaterialTheme.typography.titleMedium,
                            color = colors.onBackground,
                        )
                    }
                }

                items(works, key = { it.key }) { work ->
                    val ownedOther = work.ownedInOtherSource
                    val alt = work.chosenAlternative
                    val altCover = remember(alt) {
                        alt?.thumbnailUrl?.takeIf { it.isNotBlank() }?.let { thumb ->
                            MangaCover(
                                mangaId = null,
                                sourceId = alt.sourceId,
                                url = thumb,
                                lastModified = 0L,
                                inLibrary = false,
                            )
                        }
                    }

                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(start = Size.medium, end = Size.tiny, top = Size.small, bottom = Size.small),
                        horizontalArrangement = Arrangement.spacedBy(Size.small, Alignment.CenterHorizontally),
                    ) {
                        when {
                            work.alreadyInLibrary -> {
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = work.sourceName,
                                    statusLabel = stringResource(MR.strings.library_import_already_in_library),
                                    statusDotColor = accentColor,
                                    cover = work.cover,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            ownedOther != null -> {
                                ImportWorkCard(
                                    title = ownedOther.title,
                                    sourceLabel = ownedOther.sourceName,
                                    statusLabel = stringResource(MR.strings.library_import_already_in_library),
                                    statusDotColor = accentColor,
                                    cover = ownedOther.cover,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            else -> {
                                ImportWorkCard(
                                    title = "",
                                    sourceLabel = "",
                                    statusLabel = stringResource(MR.strings.library_import_not_in_library),
                                    statusDotColor = null,
                                    cover = null,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                        }

                        Box(Modifier.height(ComparisonCoverHeight), contentAlignment = Alignment.Center) {
                            Icon(
                                Icons.Outlined.ChevronRight,
                                contentDescription = null,
                                tint = colors.onSurfaceVariant,
                                modifier = Modifier.size(22.dp),
                            )
                        }

                        when {
                            work.alreadyInLibrary -> {
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = work.sourceName,
                                    statusLabel = stringResource(MR.strings.library_import_already_in_library),
                                    statusDotColor = null,
                                    cover = work.cover,
                                    muted = true,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            work.isLocal -> {
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = "",
                                    statusLabel = stringResource(MR.strings.library_import_local_unavailable),
                                    statusDotColor = null,
                                    cover = null,
                                    muted = true,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            work.searching -> {
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = work.sourceName,
                                    statusLabel = stringResource(MR.strings.library_import_searching_one),
                                    statusDotColor = null,
                                    cover = work.cover,
                                    loading = true,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            alt != null -> {
                                ImportWorkCard(
                                    title = alt.title,
                                    sourceLabel = alt.sourceName,
                                    statusLabel = if (work.selected) {
                                        stringResource(MR.strings.library_import_ready)
                                    } else {
                                        stringResource(MR.strings.library_import_skip_work)
                                    },
                                    statusDotColor = if (work.selected) successColor else null,
                                    cover = altCover,
                                    muted = !work.selected,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            work.extensionStatus == ShareImportExtensionStatus.INSTALLED -> {
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = work.sourceName,
                                    statusLabel = if (work.selected) {
                                        stringResource(MR.strings.library_import_ready)
                                    } else {
                                        stringResource(MR.strings.library_import_skip_work)
                                    },
                                    statusDotColor = if (work.selected) successColor else null,
                                    cover = work.cover,
                                    muted = !work.selected,
                                    onClick = null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                            else -> {
                                val canSearch = installedSources.isNotEmpty() && !importing && !batchSearching
                                ImportWorkCard(
                                    title = work.title,
                                    sourceLabel = work.sourceName,
                                    statusLabel = when {
                                        work.searchDone -> stringResource(MR.strings.library_import_not_found_installed)
                                        canSearch -> stringResource(MR.strings.library_import_search_installed)
                                        else -> stringResource(MR.strings.library_import_extension_unavailable)
                                    },
                                    statusDotColor = if (work.searchDone) dangerColor else null,
                                    cover = work.cover,
                                    onClick = if (canSearch) ({ searchOne(work) }) else null,
                                    fixedWidth = ComparisonCoverWidth,
                                    fixedHeight = ComparisonCoverHeight,
                                )
                            }
                        }

                        Box(
                            modifier = Modifier
                                .width(40.dp)
                                .height(ComparisonCoverHeight),
                            contentAlignment = Alignment.Center,
                        ) {
                            if (!work.alreadyInLibrary && !work.isLocal && (work.isReady || installedSources.isNotEmpty())) {
                                ImportWorkMenu(
                                    work = work,
                                    canSearch = installedSources.isNotEmpty(),
                                    enabled = !importing && !work.searching && !batchSearching,
                                    onSearch = { searchOne(work) },
                                    onSetSelected = { selected -> setWorkSelected(work.key, selected) },
                                    onChoose = { candidate, selected -> chooseAlternative(work.key, candidate, selected) },
                                )
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ExtraFoldersMenu(
    categories: List<Category>,
    selectedIds: Set<Int>,
    enabled: Boolean,
    onToggle: (Int) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(enabled) {
        if (!enabled) expanded = false
    }
    val colors = MaterialTheme.colorScheme
    val label = stringResource(MR.strings.library_import_extra_folders)
    val count = categories.count { it.id in selectedIds }
    val density = LocalDensity.current
    val topInset = WindowInsets.safeDrawing.getTop(density)
    val gap = with(density) { Size.tiny.roundToPx() }
    val menuPosition = remember(topInset, gap) { ExtraFoldersMenuPosition(topInset, gap) }
    var anchorTop by remember { mutableFloatStateOf(0f) }
    val menuHeight = with(density) { (anchorTop - topInset - gap).coerceAtLeast(0f).toDp() }

    Box(Modifier.onGloballyPositioned { anchorTop = it.positionInWindow().y }) {
        Row(
            modifier = Modifier
                .minimumInteractiveComponentSize()
                .widthIn(max = 160.dp)
                .height(36.dp)
                .clip(MaterialTheme.shapes.small)
                .background(colors.surfaceContainerHigh)
                .clickable(enabled = enabled, role = Role.Button) { expanded = true }
                .padding(horizontal = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(Icons.Outlined.Folder, null, Modifier.size(14.dp), tint = colors.onSurfaceVariant)
            Text(
                text = if (count == 0) label else "$label ($count)",
                modifier = Modifier.weight(1f, fill = false),
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(14.dp), tint = colors.onSurfaceVariant)
        }
        DropdownMenuPopup(
            expanded = expanded && menuHeight > 0.dp,
            onDismissRequest = { expanded = false },
            popupPositionProvider = menuPosition,
        ) {
            Surface(
                modifier = Modifier.widthIn(min = 144.dp, max = 184.dp),
                shape = MenuDefaults.shape,
                color = MenuDefaults.containerColor,
                tonalElevation = MenuDefaults.TonalElevation,
                shadowElevation = MenuDefaults.ShadowElevation,
            ) {
                Column(
                    Modifier.heightIn(max = minOf(menuHeight, 320.dp))
                        .verticalScroll(rememberScrollState())
                        .padding(vertical = Size.small),
                ) {
                    categories.forEach { category ->
                        val id = category.id ?: return@forEach
                        val checked = id in selectedIds
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 48.dp)
                                .toggleable(value = checked, role = Role.Checkbox, onValueChange = { onToggle(id) })
                                .padding(horizontal = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                        ) {
                            Checkbox(checked = checked, onCheckedChange = null)
                            Text(
                                text = category.name,
                                style = MaterialTheme.typography.labelMedium,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        }
    }
}

private class ExtraFoldersMenuPosition(
    private val topInset: Int,
    private val gap: Int,
) : DropdownMenuPopupPositionProvider {
    override val transformOriginState = mutableStateOf(TransformOrigin(0.5f, 1f))

    override fun calculatePosition(
        anchorBounds: IntRect,
        windowSize: IntSize,
        layoutDirection: LayoutDirection,
        popupContentSize: IntSize,
    ): IntOffset {
        val start = if (layoutDirection == LayoutDirection.Ltr) {
            anchorBounds.left
        } else {
            anchorBounds.right - popupContentSize.width
        }
        val x = start.coerceIn(0, (windowSize.width - popupContentSize.width).coerceAtLeast(0))
        val y = (anchorBounds.top - popupContentSize.height - gap).coerceAtLeast(topInset)
        return IntOffset(x, y)
    }
}

@Composable
private fun ImportWorkMenu(
    work: ShareImportWorkRow,
    canSearch: Boolean,
    enabled: Boolean,
    onSearch: () -> Unit,
    onSetSelected: (Boolean) -> Unit,
    onChoose: (ShareImportAlternativeMatch?, Boolean) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    LaunchedEffect(enabled) {
        if (!enabled) expanded = false
    }
    val changeLabel = stringResource(MR.strings.library_import_choose_source)
    Box {
        IconButton(onClick = { expanded = true }, enabled = enabled) {
            Icon(
                imageVector = Icons.Outlined.MoreVert,
                contentDescription = "${work.title} · $changeLabel",
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(20.dp),
            )
        }
        DropdownMenu(expanded = expanded && enabled, onDismissRequest = { expanded = false }) {
            if (work.isReady && !work.selected) {
                val activeSource = work.chosenAlternative?.sourceName ?: work.sourceName
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(MR.strings.library_import_using_source, activeSource),
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    },
                    onClick = {
                        expanded = false
                        onSetSelected(true)
                    },
                )
            }
            if (canSearch) {
                DropdownMenuItem(
                    text = {
                        Text(
                            stringResource(
                                if (work.searchDone) MR.strings.retry
                                else MR.strings.library_import_search_installed,
                            ),
                        )
                    },
                    enabled = !work.searching,
                    onClick = {
                        expanded = false
                        onSearch()
                    },
                )
            }
            if (work.chosenAlternative != null && work.extensionStatus == ShareImportExtensionStatus.INSTALLED) {
                DropdownMenuItem(
                    text = { Text("${work.sourceName} — ${work.title}", maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    onClick = {
                        expanded = false
                        onChoose(null, true)
                    },
                )
            }
            for (candidate in work.candidates) {
                val chosen = work.chosenAlternative
                val isChosen = work.selected && chosen?.sourceId == candidate.sourceId && chosen.url == candidate.url
                DropdownMenuItem(
                    text = { Text("${candidate.sourceName} — ${candidate.title}", maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    trailingIcon = if (isChosen) {
                        { Icon(Icons.Outlined.Check, contentDescription = null, modifier = Modifier.size(16.dp)) }
                    } else {
                        null
                    },
                    onClick = {
                        expanded = false
                        onChoose(candidate, true)
                    },
                )
            }
            if (work.selected) {
                DropdownMenuItem(
                    text = { Text(stringResource(MR.strings.library_import_skip_work)) },
                    onClick = {
                        expanded = false
                        onSetSelected(false)
                    },
                )
            }
        }
    }
}

@Composable
private fun ImportWorkCard(
    title: String,
    sourceLabel: String,
    statusLabel: String?,
    statusDotColor: Color?,
    cover: MangaCover?,
    onClick: (() -> Unit)?,
    modifier: Modifier = Modifier,
    fixedWidth: Dp? = null,
    fixedHeight: Dp? = null,
    muted: Boolean = false,
    loading: Boolean = false,
) {
    val colors = MaterialTheme.colorScheme
    val shape = MaterialTheme.shapes.small
    var coverFailed by remember(cover) { mutableStateOf(false) }
    val showCoverImage = cover != null && cover.url.isNotBlank() && !coverFailed
    val interaction = if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier
    val baseModifier = if (fixedWidth != null) modifier.width(fixedWidth) else modifier
    val columnModifier = if (muted) baseModifier.alpha(0.55f) else baseModifier
    val coverBoxModifier = if (fixedHeight != null) {
        Modifier.fillMaxWidth().height(fixedHeight)
    } else {
        Modifier.fillMaxWidth().aspectRatio(2f / 3f)
    }

    Column(
        modifier = columnModifier,
        verticalArrangement = Arrangement.spacedBy(Size.tiny),
    ) {
        Box(coverBoxModifier) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .clip(shape)
                    .background(colors.surfaceContainerHigh)
                    .then(interaction),
                contentAlignment = Alignment.Center,
            ) {
                when {
                    showCoverImage -> MangaCoverImage(
                        data = checkNotNull(cover),
                        contentDescription = "",
                        shape = shape,
                        contentScale = ContentScale.Crop,
                        onState = { state ->
                            if (state is AsyncImagePainter.State.Error) {
                                coverFailed = true
                            }
                        },
                        modifier = Modifier.fillMaxSize(),
                    )
                    title.isNotBlank() && !loading -> Icon(
                        imageVector = Icons.Outlined.Book,
                        contentDescription = null,
                        tint = colors.onSurfaceVariant.copy(alpha = 0.45f),
                        modifier = Modifier.size(24.dp),
                    )
                }
                if (loading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = colors.primary,
                    )
                }

                if (title.isNotBlank()) {
                    Box(
                        Modifier
                            .align(Alignment.BottomCenter)
                            .fillMaxWidth()
                            .height(68.dp)
                            .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.86f)))),
                    )
                    Text(
                        text = title,
                        color = Color.White,
                        style = MaterialTheme.typography.bodySmall,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.align(Alignment.BottomStart).padding(horizontal = 6.dp, vertical = 6.dp),
                    )
                }

                Box(Modifier.fillMaxSize().border(1.dp, colors.outlineVariant, shape))
            }
        }

        if (sourceLabel.isNotBlank()) {
            Text(
                text = sourceLabel,
                style = MaterialTheme.typography.bodySmall,
                color = colors.onBackground,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (statusLabel != null) {
            if (statusDotColor != null) {
                StatusDotWord(label = statusLabel, color = statusDotColor)
            } else {
                Text(
                    text = statusLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StatusDotWord(
    label: String,
    color: Color,
) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Size.tiny),
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color),
        )
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = color,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun QuietActionLabel(
    text: String,
    enabled: Boolean,
    onClick: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    Text(
        text = text,
        style = MaterialTheme.typography.labelLarge,
        color = colors.primary.copy(alpha = if (enabled) 1f else 0.4f),
        maxLines = 1,
        modifier = Modifier
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = Size.small, vertical = Size.tiny),
    )
}

@Composable
private fun LoadingSkeletonCards(modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Column(
        modifier = modifier.padding(horizontal = Size.medium, vertical = Size.small),
        verticalArrangement = Arrangement.spacedBy(Size.medium),
    ) {
        repeat(2) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(Size.small, Alignment.CenterHorizontally),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Box(
                    Modifier
                        .size(ComparisonCoverWidth, ComparisonCoverHeight)
                        .clip(MaterialTheme.shapes.small)
                        .background(colors.surfaceContainerHigh),
                )
                Spacer(Modifier.width(22.dp))
                Box(
                    Modifier
                        .size(ComparisonCoverWidth, ComparisonCoverHeight)
                        .clip(MaterialTheme.shapes.small)
                        .background(colors.surfaceContainerHigh),
                )
                Spacer(Modifier.width(40.dp))
            }
        }
    }
}
