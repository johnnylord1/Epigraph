package epigraph.library

import java.util.Base64
import java.util.Random
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class LibraryShareLinkTest {
    private val samplePng: ByteArray = Base64.getDecoder().decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    )

    @Test
    fun `round-trips manifest with deduplicated sources, repo URL, remote works, and local works`() {
        val manifest = LibraryShareLink.buildManifest(
            listOf(
                LibraryShareLink.WorkInput(
                    title = "Solo Leveling",
                    sourceId = 2499283573021220255L,
                    url = "/manga/solo-leveling",
                    sourceName = "MangaDex",
                    sourceLang = "en",
                    pkgName = "eu.kanade.tachiyomi.extension.all.mangadex",
                    repoUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
                    webUrl = "https://mangadex.org/title/solo-leveling",
                    coverUrl = "https://mangadex.org/covers/solo-leveling.jpg",
                ),
                LibraryShareLink.WorkInput(
                    title = "Frieren",
                    sourceId = 2499283573021220255L,
                    url = "/manga/frieren",
                    sourceName = "MangaDex",
                    sourceLang = "en",
                    pkgName = "eu.kanade.tachiyomi.extension.all.mangadex",
                    repoUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
                    webUrl = "https://mangadex.org/title/solo-leveling",
                    coverUrl = "https://mangadex.org/covers/solo-leveling.jpg",
                ),
                LibraryShareLink.WorkInput(
                    title = "Local Comic",
                    sourceId = 0L,
                    url = "/local/comic",
                ),
            ),
        )

        assertEquals(1, manifest.sources.size)
        val token = LibraryShareLink.encodeManifest(manifest)
        assertTrue(token.startsWith("d."))

        val decoded = LibraryShareLink.decodeManifest(token)
        assertEquals(manifest, decoded)
    }

    @Test
    fun `embeds and extracts share token in PNG tEXt chunk cleanly`() {
        val manifest = LibraryShareLink.buildManifest(
            listOf(LibraryShareLink.WorkInput("One Piece", 12345L, "/manga/one-piece", "TestSource")),
        )
        val token = LibraryShareLink.encodeManifest(manifest)
        val embedded = LibraryShareLink.embedShareTokenInPng(samplePng, token)

        assertTrue(embedded.size > samplePng.size)
        assertEquals(token, LibraryShareLink.extractShareTokenFromPng(embedded))
        assertNull(LibraryShareLink.extractShareTokenFromPng(samplePng))
    }

    @Test
    fun `round-trips a hosted folder larger than the direct link limit`() {
        val random = Random(42)
        val manifest = LibraryShareLink.buildManifest(List(500) { index ->
            val slug = ByteArray(48).also(random::nextBytes).let { Base64.getUrlEncoder().withoutPadding().encodeToString(it) }
            LibraryShareLink.WorkInput("Work $index", 42L, "/manga/$slug", "TestSource")
        })
        val token = LibraryShareLink.encodeManifest(manifest)
        assertTrue(token.length > LibraryShareLink.INLINE_TOKEN_HARD_MAX)
        assertNull(LibraryShareLink.parseIncomingImportLink("epigraph://import?p=$token"))
        val png = LibraryShareLink.embedShareTokenInPng(samplePng, token)
        assertEquals(manifest, LibraryShareLink.extractShareTokenFromPng(png)?.let(LibraryShareLink::decodeManifest))
        assertEquals("i.fixture", LibraryShareLink.chooseShareLinkToken(token, "https://iili.io/fixture.png"))
    }

    @Test
    fun `parses GitHub Pages share links, epigraph deep links, and hosted tokens safely`() {
        val manifest = LibraryShareLink.buildManifest(
            listOf(LibraryShareLink.WorkInput("Berserk", 99L, "/manga/berserk", "Src")),
        )
        val inline = LibraryShareLink.encodeManifest(manifest)

        assertEquals(
            ShareLinkToken.Inline(inline),
            LibraryShareLink.parseIncomingImportLink(LibraryShareLink.buildShareWebUrl(inline)),
        )
        assertEquals(
            ShareLinkToken.Inline(inline),
            LibraryShareLink.parseIncomingImportLink(LibraryShareLink.buildShareWebUrl(inline, "https://iili.io/oKis7El.png")),
        )
        assertEquals(
            ShareLinkToken.Inline(inline),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=$inline"),
        )
        assertEquals(
            ShareLinkToken.Hosted("i.oKis7El", "freeimage", "https://iili.io/oKis7El.png"),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=i.oKis7El"),
        )
        assertEquals(
            ShareLinkToken.Hosted("k.lfAoW8", "kappa", "https://kappa.lol/lfAoW8.png"),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=k.lfAoW8"),
        )
        assertEquals(
            ShareLinkToken.Hosted("p.n6bzrnex", "pomf2", "https://pomf2.lain.la/f/n6bzrnex.png"),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=p.n6bzrnex"),
        )
        assertEquals(
            ShareLinkToken.Hosted("a.dFhZ", "x0at", "https://x0.at/dFhZ.png"),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=a.dFhZ"),
        )
        assertEquals(
            ShareLinkToken.Hosted("l.abc123", "litterbox", "https://litter.catbox.moe/abc123.png"),
            LibraryShareLink.parseIncomingImportLink("epigraph://import?p=l.abc123"),
        )
        assertEquals("i.oKis7El", LibraryShareLink.hostedUrlToShareToken("https://iili.io/oKis7El.png"))
        assertEquals("k.lfAoW8", LibraryShareLink.hostedUrlToShareToken("https://kappa.lol/lfAoW8.png"))
        assertEquals("p.n6bzrnex", LibraryShareLink.hostedUrlToShareToken("https://pomf2.lain.la/f/n6bzrnex.png"))
        assertEquals("a.dFhZ", LibraryShareLink.hostedUrlToShareToken("https://x0.at/dFhZ.png"))
        assertEquals("u.d.XArdEvq", LibraryShareLink.hostedUrlToShareToken("https://d.uguu.se/XArdEvq.png"))
        assertNull(LibraryShareLink.parseIncomingImportLink("https://evil.example.com/share/#l.abc123"))
        assertNull(LibraryShareLink.parseIncomingImportLink("epigraph://pair?b=something"))
    }

    @Test
    fun `round-trips comic and book kinds cleanly`() {
        val manifest = LibraryShareLink.buildManifest(
            listOf(
                LibraryShareLink.WorkInput(
                    title = "+99 Reinforced Wooden Stick",
                    sourceId = 100L,
                    url = "/manga/stick",
                    sourceName = "Mangakakalot",
                    kind = "comic",
                ),
                LibraryShareLink.WorkInput(
                    title = "Lord of the Mysteries",
                    sourceId = 200L,
                    url = "/novel/lotm",
                    sourceName = "NovelSource",
                    kind = "book",
                ),
                LibraryShareLink.WorkInput(
                    title = "Mistborn",
                    sourceId = 0L,
                    url = "",
                    kind = "book",
                ),
                LibraryShareLink.WorkInput(
                    title = "Legacy Work",
                    sourceId = 100L,
                    url = "/manga/legacy",
                    sourceName = "Mangakakalot",
                ),
            ),
        )

        assertEquals(listOf("comic", "book", "book", null), manifest.works.map { it.kind })
        val token = LibraryShareLink.encodeManifest(manifest)
        val decoded = LibraryShareLink.decodeManifest(token)
        assertEquals(manifest, decoded)
    }

    @Test
    fun `classifies duplicates, installed sources, needs_repo, and local works in import plan`() {
        val manifest = LibraryShareLink.buildManifest(
            listOf(
                LibraryShareLink.WorkInput("Owned", 100L, "/manga/owned", "InstalledSrc"),
                LibraryShareLink.WorkInput("Owned Elsewhere", 100L, "/manga/elsewhere", "InstalledSrc"),
                LibraryShareLink.WorkInput("New Ready", 100L, "/manga/new", "InstalledSrc"),
                LibraryShareLink.WorkInput(
                    title = "Needs Repo",
                    sourceId = 200L,
                    url = "/manga/repo",
                    sourceName = "CustomScan",
                    pkgName = "eu.kanade.tachiyomi.extension.en.custom",
                    repoUrl = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
                ),
                LibraryShareLink.WorkInput("Local", 0L, "/local/1"),
            ),
        )

        val plan = LibraryShareImportPlanner.buildPlan(
            manifest = manifest,
            favoriteKeys = setOf(LibraryShareImportPlanner.workKey(100L, "/manga/owned")),
            installedSourceIds = setOf(100L),
            availableExtensions = emptyList(),
            installedCatalogueSources = emptyList(),
            categories = emptyList(),
            libraryEntries = listOf(
                ShareImportLibraryEntry(100L, "InstalledSrc", "/manga/owned", "Owned"),
                ShareImportLibraryEntry(555L, "MangaFire", "/manga/owned-elsewhere", "Owned Elsewhere"),
            ),
        )

        assertTrue(plan.works[0].alreadyInLibrary)
        assertEquals(false, plan.works[0].selected)
        assertEquals(false, plan.works[1].alreadyInLibrary)
        assertEquals("MangaFire", plan.works[1].ownedInOtherSource?.sourceName)
        assertEquals(false, plan.works[1].selected)
        assertTrue(plan.works[1].isReady)
        assertEquals(true, plan.works[2].selected)
        assertEquals(ShareImportExtensionStatus.NEEDS_REPO, plan.works[3].extensionStatus)
        assertEquals(false, plan.works[3].selected)
        assertTrue(plan.works[4].isLocal)

        val needsRepoExt = plan.extensions.find { it.sourceId == 200L }
        assertNotNull(needsRepoExt)
        assertEquals(ShareImportExtensionStatus.NEEDS_REPO, needsRepoExt?.status)
        assertEquals("keiyoushi", needsRepoExt?.repoLabel)
    }
}
