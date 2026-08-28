package epigraph.contract

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import org.junit.jupiter.api.Test

class PortableContentContractTest {
    @Test
    fun `portable IDs are deterministic and preserve opaque provider keys`() {
        val work = PortableWorkRef.Comic(
            DecimalSourceId("42"),
            ProviderOwnedKey("/Manga/Keep?chapter=A%2FB"),
        )
        val chapter = PortableChapterRef.Comic(
            work,
            ProviderOwnedKey("/Chapter/7?quality=raw"),
        )

        PortableIdentityV3.workId(work.copy()) shouldBe PortableIdentityV3.workId(work)
        PortableIdentityV3.chapterId(chapter.copy()) shouldBe PortableIdentityV3.chapterId(chapter)
        PortableIdentityV3.workId(work).startsWith("comic:") shouldBe true
        PortableIdentityV3.chapterId(chapter).startsWith("comic-chapter:") shouldBe true
    }

    @Test
    fun `provider-owned keys remain opaque`() {
        val raw = "/Manga/Title?chapter=AbC%2F123#chapter-fragment"
        val ref = PortableWorkRef.Comic(
            sourceId = DecimalSourceId("9223372036854775807"),
            mangaKey = ProviderOwnedKey(raw),
        )

        ref.mangaKey.value shouldBe raw
        ref.sourceId.toLong() shouldBe Long.MAX_VALUE
    }

    @Test
    fun `wire source IDs reject non-canonical or unsafe numeric forms`() {
        listOf("", "01", "+1", "-0", "1.0", " 1").forEach { value ->
            shouldThrow<IllegalArgumentException> { DecimalSourceId(value) }
        }
        shouldThrow<IllegalArgumentException> {
            DecimalSourceId("9223372036854775808").toLong()
        }
        DecimalSourceId("-1").toLong() shouldBe -1L
    }

    @Test
    fun `comic dependency keeps extension and source identities separate`() {
        val dependency = ProviderDependency.Comic(
            ComicDependency(
                pkgName = "eu.kanade.tachiyomi.extension.en.example",
                requiredSourceIds = setOf(DecimalSourceId("10001"), DecimalSourceId("10002")),
                extensionStore = ExtensionStoreReference(
                    storeIndexUrl = "https://example.org/index.min.json",
                ),
            ),
        )

        dependency.dependency.requiredSourceIds.size shouldBe 2
        dependency.dependency.pkgName shouldBe "eu.kanade.tachiyomi.extension.en.example"
    }

    @Test
    fun `novel plugin identity does not depend on repository or artifact hash`() {
        val ref = PortableWorkRef.Novel(
            pluginId = "novel.example",
            novelKey = ProviderOwnedKey("series/Keep-Case?lang=en"),
        )
        val dependency = NovelDependency(pluginId = ref.pluginId)

        dependency.pluginId shouldBe "novel.example"
        dependency.repository shouldBe null
        dependency.observedArtifactSha256 shouldBe null
    }

    @Test
    fun `bound resolution cannot retain a failure reason`() {
        shouldThrow<IllegalArgumentException> {
            PortableResolution(
                state = PortableResolutionState.BOUND,
                reason = PortableResolutionReason.SOURCE_OFFLINE,
            )
        }
        PortableResolution(PortableResolutionState.BOUND).state shouldBe PortableResolutionState.BOUND
    }

    @Test
    fun `dependency ready remains distinct from a bound local entity`() {
        PortableResolution(PortableResolutionState.READY).state shouldBe PortableResolutionState.READY
        PortableResolution(PortableResolutionState.BOUND).state shouldBe PortableResolutionState.BOUND
    }
}
