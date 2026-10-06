package epigraph.recommendations.ui

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import android.os.Looper
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.activity.ComponentActivity
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialExpressiveTheme
import androidx.compose.material3.MotionScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.platform.LocalInspectionMode
import coil3.annotation.ExperimentalCoilApi
import coil3.asImage
import coil3.compose.AsyncImagePreviewHandler
import coil3.compose.LocalAsyncImagePreviewHandler
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.google.accompanist.themeadapter.material3.createMdc3Theme
import com.google.android.material.bottomnavigation.BottomNavigationView
import com.google.android.material.navigation.NavigationBarView
import epigraph.recommendations.DiscoverCatalogEntry
import epigraph.recommendations.DiscoverMode
import epigraph.recommendations.DiscoverResult
import epigraph.recommendations.NormalizedMetric
import epigraph.recommendations.RecommendationContentType
import epigraph.recommendations.RecommendationCover
import epigraph.recommendations.RecommendationDiversityBucket
import epigraph.recommendations.RecommendationItem
import epigraph.recommendations.RecommendationProviderKind
import epigraph.recommendations.RecommendationProviderSignal
import epigraph.recommendations.RecommendationScoreBreakdown
import epigraph.recommendations.RecommendationSection
import epigraph.recommendations.RecommendationSectionKey
import epigraph.recommendations.RecommendationCandidate
import epigraph.recommendations.RecommendationTarget
import epigraph.recommendations.buildTrackerScoreBadge
import eu.kanade.tachiyomi.R
import java.io.File
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode
import yokai.presentation.theme.AppShapes
import yokai.presentation.theme.AppTypography

/**
 * Screenshots of the Discover tab, rendered on the JVM (no emulator). Covers are generated
 * gradients, so no third-party artwork is involved. Run with
 * `./gradlew :app:testDevDebugUnitTest --tests '*DiscoverScreenshotTest*' -Proborazzi.record=true`;
 * the images land in app/build/outputs/roborazzi.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
// The app ships conscrypt-android, whose JNI library does not exist on the JVM; screenshots need no TLS.
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], application = Application::class, qualifiers = "w411dp-h891dp-night-xxhdpi")
class DiscoverScreenshotTest {

    @Test
    fun forYouComics() = capture("discover-for-you-comics", forYouState())

    @Test
    fun catalogComics() = capture("discover-catalog-comics", catalogState())

    @Test
    fun catalogLoadingMore() = capture("discover-catalog-loading-more", catalogState().copy(catalogLoadingMore = true))

    @Test
    fun novelsLoading() = capture(
        "discover-novels-loading",
        DiscoverScreenModel.State(mode = DiscoverMode.NOVELS, loading = true),
    )

    @Test
    fun catalogEmpty() = capture(
        "discover-catalog-empty",
        DiscoverScreenModel.State(
            mode = DiscoverMode.COMICS,
            loading = false,
            result = DiscoverResult(emptyList(), seedCount = 0, failedProviders = emptyList()),
            section = DiscoverSection.CATALOG,
        ),
    )

    @Test
    fun loadError() = capture(
        "discover-error",
        DiscoverScreenModel.State(mode = DiscoverMode.COMICS, loading = false, error = "Unable to resolve host"),
    )

    private fun capture(name: String, state: DiscoverScreenModel.State) {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        activity.setTheme(R.style.Theme_Tachiyomi)
        val root = LinearLayout(activity).apply { orientation = LinearLayout.VERTICAL }
        val compose = ComposeView(activity).apply {
            setContent { ScreenshotTheme { DiscoverTabPreview(state) } }
        }
        // The real bottom navigation widget and menu, with Discover selected.
        val nav = BottomNavigationView(activity).apply {
            inflateMenu(R.menu.bottom_navigation)
            labelVisibilityMode = NavigationBarView.LABEL_VISIBILITY_LABELED
            selectedItemId = R.id.nav_discover
        }
        root.addView(compose, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        root.addView(nav, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        activity.setContentView(root, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        repeat(4) { shadowOf(Looper.getMainLooper()).idle() }
        root.captureRoboImage("build/outputs/roborazzi/$name.png")
    }

    @Composable
    private fun DiscoverTabPreview(state: DiscoverScreenModel.State) {
        DiscoverContent(
            state = state,
            bottomPadding = 0.dp,
            onFilter = {},
            onRefresh = {},
            onOverflow = {},
            onSection = {},
            onMode = {},
            onShowMore = {},
            onLoadMoreCatalog = {},
            onOpen = {},
        )
    }

    /** [yokai.presentation.theme.YokaiTheme] without the preference-backed reduced-motion lookup. */
    @OptIn(ExperimentalMaterial3ExpressiveApi::class)
    @Composable
    private fun ScreenshotTheme(content: @Composable () -> Unit) {
        val context = androidx.compose.ui.platform.LocalContext.current
        @Suppress("DEPRECATION")
        val scheme = createMdc3Theme(context = context, layoutDirection = LayoutDirection.Ltr, setTextColors = true, readTypography = false)
            .component1()!!
        // Coil loads asynchronously; in inspection mode it asks this handler instead, so the generated
        // covers are drawn in the same frame the screenshot is taken.
        @OptIn(ExperimentalCoilApi::class)
        val covers = AsyncImagePreviewHandler { request ->
            val bitmap = (request.data as? File)?.let { BitmapFactory.decodeFile(it.absolutePath) }
            (bitmap ?: Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)).asImage()
        }
        CompositionLocalProvider(LocalInspectionMode provides true, LocalAsyncImagePreviewHandler provides covers) {
            MaterialExpressiveTheme(colorScheme = scheme, motionScheme = MotionScheme.standard(), typography = AppTypography, shapes = AppShapes) {
                content()
            }
        }
    }

    private fun forYouState(): DiscoverScreenModel.State {
        val titles = listOf(
            "Northern Lights Atelier", "The Last Lighthouse", "Ember & Ash", "Paper Moon Courier", "Glass Garden",
            "Iron Tide", "A Quiet Kingdom", "Starfall Academy", "Salt and Silver", "Echoes of Rain",
        )
        val items = titles.mapIndexed { index, title -> item(index, title, score = 0.92 - index * 0.04) }
        val sections = listOf(
            RecommendationSection(RecommendationSectionKey.BECAUSE_YOU_RATED_HIGHLY, items.take(6)),
            RecommendationSection(RecommendationSectionKey.HIGH_CONFIDENCE, items.drop(3).take(6)),
            RecommendationSection(RecommendationSectionKey.TRENDING_NEAR_YOUR_TASTE, items.drop(1).take(6)),
        )
        return DiscoverScreenModel.State(
            mode = DiscoverMode.COMICS,
            loading = false,
            result = DiscoverResult(sections, seedCount = 42, failedProviders = emptyList()),
        )
    }

    private fun catalogState(): DiscoverScreenModel.State {
        val titles = listOf(
            "Northern Lights Atelier", "The Last Lighthouse", "Ember & Ash", "Paper Moon Courier", "Glass Garden",
            "Iron Tide", "A Quiet Kingdom", "Starfall Academy", "Salt and Silver", "Echoes of Rain", "Clockwork Fox",
            "Tidebound", "Lantern Road", "Velvet Comet", "Hollow Crown",
        )
        val catalog = titles.mapIndexed { index, title ->
            val candidate = candidate(index, title, score = if (index % 4 == 3) null else 0.88 - (index % 5) * 0.05)
            DiscoverCatalogEntry(candidate, buildTrackerScoreBadge(candidate))
        }
        return forYouState().copy(section = DiscoverSection.CATALOG, catalog = catalog)
    }

    private fun item(index: Int, title: String, score: Double): RecommendationItem {
        val candidate = candidate(index, title, score)
        return RecommendationItem(
            candidate = candidate,
            breakdown = RecommendationScoreBreakdown(
                personalRatingAffinity = score, profileTagOverlap = score, contentTypeFit = 1.0, sourceAffinity = 0.5,
                contentSimilarity = score, trackerConsensus = score, trendingVelocity = 0.4, recency = 0.5,
                sourceAvailability = 1.0, novelty = 0.3, negativeTagPenalty = 0.0, matchedTagCount = 3,
                finalScore = score, diversityBucket = RecommendationDiversityBucket.FAMILIAR,
            ),
            badge = buildTrackerScoreBadge(candidate),
        )
    }

    private fun candidate(index: Int, title: String, score: Double?) = RecommendationCandidate(
        id = "fixture:$index",
        title = title,
        cover = RecommendationCover(coverFile(index).absolutePath),
        contentType = listOf(RecommendationContentType.MANGA, RecommendationContentType.MANHWA, RecommendationContentType.MANHUA)[index % 3],
        providers = listOfNotNull(
            score?.let {
                RecommendationProviderSignal(
                    providerId = "anilist",
                    providerName = "AniList",
                    kind = RecommendationProviderKind.TRACKER,
                    score = NormalizedMetric(value = it, confidence = 0.9, method = "fixture"),
                )
            },
        ),
        targets = listOf(RecommendationTarget(sourceId = 1L, url = "/title/$index", title = title)),
    )

    /** A generated gradient "cover", written once per run into the test's temp directory. */
    private fun coverFile(index: Int): File {
        val file = File(System.getProperty("java.io.tmpdir"), "discover-fixture-cover-$index.png")
        if (file.exists()) return file
        val palette = listOf(
            0xFF5B4B8A.toInt() to 0xFFE8A87C.toInt(),
            0xFF1F4E5F.toInt() to 0xFF9AD1D4.toInt(),
            0xFF7A2E3A.toInt() to 0xFFF2C14E.toInt(),
            0xFF2D3A6B.toInt() to 0xFFB8C5F2.toInt(),
            0xFF35524A.toInt() to 0xFFC7E8CA.toInt(),
        )
        val (start, end) = palette[index % palette.size]
        val bitmap = Bitmap.createBitmap(300, 450, Bitmap.Config.ARGB_8888)
        val paint = Paint().apply { shader = LinearGradient(0f, 0f, 300f, 450f, start, end, Shader.TileMode.CLAMP) }
        Canvas(bitmap).drawRect(0f, 0f, 300f, 450f, paint)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return file
    }
}
