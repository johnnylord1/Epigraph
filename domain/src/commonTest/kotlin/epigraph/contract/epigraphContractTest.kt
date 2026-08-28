package epigraph.contract

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Test

class EpigraphContractTest {
    @Test
    fun `entity identity rejects blank trimmed and control values`() {
        shouldThrow<IllegalArgumentException> { EpigraphEntityId("") }
        shouldThrow<IllegalArgumentException> { EpigraphEntityId(" id") }
        shouldThrow<IllegalArgumentException> { EpigraphEntityId("id\nother") }
    }

    @Test
    fun `book identity is derived only from format and canonical byte hash`() {
        val upperHash = "AB".repeat(32)

        EpigraphIdentityRules.importedBookId(ContentType.EPUB, upperHash).value shouldBe
            "epub:sha256:${"ab".repeat(32)}"
        EpigraphIdentityRules.importedBookId(ContentType.PDF, upperHash).value shouldBe
            "pdf:sha256:${"ab".repeat(32)}"
        shouldThrow<IllegalArgumentException> {
            EpigraphIdentityRules.importedBookId(ContentType.MANGA, upperHash)
        }
        shouldThrow<IllegalArgumentException> {
            EpigraphIdentityRules.importedBookId(ContentType.EPUB, "not-a-hash")
        }
    }

    @Test
    fun `source URL normalization removes client fragments and default ports`() {
        SourceUrlNormalizer.normalize(" HTTPS://Example.COM:443/path?q=1#reader ") shouldBe
            "https://example.com/path?q=1"
        SourceUrlNormalizer.normalize("http://Example.COM:80/") shouldBe "http://example.com"
        SourceUrlNormalizer.normalize("https://Example.COM:00444/path") shouldBe "https://example.com:444/path"
        shouldThrow<IllegalArgumentException> {
            SourceUrlNormalizer.normalize("https://user:password@example.com/book")
        }
        shouldThrow<IllegalArgumentException> {
            SourceUrlNormalizer.normalize("https://example.com/a book")
        }
    }

    @Test
    fun `portable dependency indexes reject private hosts and provider keys reject secrets`() {
        for (url in listOf(
            "https://localhost/plugins.min.json",
            "https://repo.local/plugins.min.json",
            "https://192.168.1.5/plugins.min.json",
            "http://repo.example/plugins.min.json",
            "https://repo.example/plugins.min.json?token=secret",
        )) {
            shouldThrow<IllegalArgumentException> {
                SourceUrlNormalizer.normalizePublicHttpsIndex(url)
            }
        }
        SourceUrlNormalizer.normalizePublicHttpsIndex("https://repo.example/plugins.min.json") shouldBe
            "https://repo.example/plugins.min.json"

        shouldThrow<IllegalArgumentException> {
            ProviderOwnedKey("/manga/title?token=secret")
        }
        shouldThrow<IllegalArgumentException> {
            ProviderOwnedKey("https://user:secret@example.com/title")
        }
        ProviderOwnedKey("/manga/title?chapter=one").value shouldBe "/manga/title?chapter=one"
    }

    @Test
    fun `source binding key is deterministic and delimiter safe`() {
        val first = sourceBinding(repository = "a:b", plugin = "c")
        val second = sourceBinding(repository = "a", plugin = "b:c")

        EpigraphIdentityRules.sourceBindingKey(first) shouldBe EpigraphIdentityRules.sourceBindingKey(first)
        (EpigraphIdentityRules.sourceBindingKey(first) == EpigraphIdentityRules.sourceBindingKey(second)) shouldBe false
    }

    @Test
    fun `local identity binding preserves local ID verbatim`() {
        val binding = LocalEntityBinding(
            localId = "00042",
            entityId = EpigraphEntityId("manga:example:42"),
            source = sourceBinding(),
        )

        binding.localId shouldBe "00042"
    }

    @Test
    fun `reader locators reject invalid positions`() {
        val id = EpigraphEntityId("book:one")

        shouldThrow<IllegalArgumentException> { ReaderLocator.Pdf(id, pageIndex = -1) }
        shouldThrow<IllegalArgumentException> { ReaderLocator.Epub(id, progression = Double.NaN) }
        shouldThrow<IllegalArgumentException> {
            ReaderLocator.Manga(id, chapterId = "chapter", pageIndex = 0, pageOffset = 1.1)
        }
    }

    @Test
    fun `PDF document metrics use exact zero based page progression`() {
        val id = EpigraphEntityId("pdf:sha256:${"ab".repeat(32)}")

        ReaderLocator.Pdf(id, pageIndex = 0).withDocumentMetrics(5) shouldBe
            ReaderLocator.Pdf(id, pageIndex = 0, totalPages = 5, documentProgression = 0.0)
        ReaderLocator.Pdf(id, pageIndex = 2).withDocumentMetrics(5) shouldBe
            ReaderLocator.Pdf(id, pageIndex = 2, totalPages = 5, documentProgression = 0.5)
        ReaderLocator.Pdf(id, pageIndex = 4).withDocumentMetrics(5) shouldBe
            ReaderLocator.Pdf(id, pageIndex = 4, totalPages = 5, documentProgression = 1.0)
        ReaderLocator.Pdf(id, pageIndex = 0).withDocumentMetrics(1) shouldBe
            ReaderLocator.Pdf(id, pageIndex = 0, totalPages = 1, documentProgression = 1.0)
    }

    @Test
    fun `progress and bookmark commands cannot target another entity`() {
        val first = EpigraphEntityId("book:first")
        val second = EpigraphEntityId("book:second")
        val locator = ReaderLocator.Pdf(first, pageIndex = 10)

        shouldThrow<IllegalArgumentException> { SyncCommand.SetProgress(second, locator) }
        shouldThrow<IllegalArgumentException> { SyncCommand.SetBookmark(second, locator, bookmarked = true) }
    }

    @Test
    fun `idempotency key depends on both device and mutation without delimiter ambiguity`() {
        val command = SyncCommand.DeleteEntity(EpigraphEntityId("book:one"))
        val scope = SyncScopeId("books:global")
        val entityType = SyncEntityType("book.entry")
        val first = SyncCommandEnvelope(
            EpigraphSyncProtocol.CURRENT_VERSION,
            DeviceId("a:b"),
            ClientMutationId("c"),
            scope,
            entityType,
            command,
        )
        val second = SyncCommandEnvelope(
            EpigraphSyncProtocol.CURRENT_VERSION,
            DeviceId("a"),
            ClientMutationId("b:c"),
            scope,
            entityType,
            command,
        )

        (first.idempotencyKey == second.idempotencyKey) shouldBe false
        first.idempotencyKey shouldBe SyncCommandEnvelope(
            EpigraphSyncProtocol.CURRENT_VERSION,
            DeviceId("a:b"),
            ClientMutationId("c"),
            scope,
            entityType,
            command,
        ).idempotencyKey
    }

    @Test
    fun `public command envelope survives serialization round trip`() {
        val entityId = EpigraphEntityId("manga:example:42")
        val envelope = SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = DeviceId("phone-1"),
            clientMutationId = ClientMutationId("mutation-1"),
            scopeId = SyncScopeId("comics:profile:main"),
            entityType = SyncEntityType("comic.chapter_state"),
            command = SyncCommand.SetProgress(
                entityId = entityId,
                locator = ReaderLocator.Manga(
                    entityId = entityId,
                    chapterId = "chapter-5",
                    pageIndex = 12,
                    pageOffset = 0.25,
                ),
            ),
        )

        val encoded = Json.encodeToString(SyncCommandEnvelope.serializer(), envelope)
        Json.decodeFromString(SyncCommandEnvelope.serializer(), encoded) shouldBe envelope
        encoded.contains("\"protocolVersion\":2") shouldBe true
        envelope.command.operationWireName() shouldBe "set_progress"
    }

    private fun sourceBinding(
        repository: String = "official",
        plugin: String = "example.plugin",
    ): SourceBinding = SourceBinding.create(
        ecosystem = "mihon",
        repository = repository,
        plugin = plugin,
        sourceId = "1234",
        url = "https://Example.com/title/42#chapter",
    )
}
