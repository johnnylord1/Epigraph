package epigraph.contract

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.collections.shouldContainExactly
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test

class SyncCommandContractTest {
    private val entityId = EpigraphEntityId("manga:source:title")
    private val categoryId = EpigraphEntityId("category:favorites")
    private val repositoryId = EpigraphEntityId("repository:mihon:official")
    private val canonicalId = EpigraphEntityId("manga:source:canonical")
    private val hash = "ab".repeat(32)
    private val locator = ReaderLocator.Manga(
        entityId = entityId,
        chapterId = "chapter:12",
        pageIndex = 7,
        pageOffset = 0.25,
    )

    @Test
    fun `book cover metadata is an all or nothing bounded contract`() {
        val bookId = EpigraphEntityId("epub:sha256:$hash")
        shouldThrow<IllegalArgumentException> {
            BookEntrySnapshot(
                bookId = bookId,
                contentType = ContentType.EPUB,
                sha256 = hash,
                title = "Book",
                mimeType = "application/epub+zip",
                byteSize = 1,
                coverAssetSha256 = hash,
                createdAtEpochMillis = 1,
                updatedAtEpochMillis = 1,
            )
        }
        shouldThrow<IllegalArgumentException> {
            BookEntrySnapshot(
                bookId = bookId,
                contentType = ContentType.EPUB,
                sha256 = hash,
                title = "Book",
                mimeType = "application/epub+zip",
                byteSize = 1,
                coverAssetSha256 = hash,
                coverAssetByteSize = 8L * 1024L * 1024L + 1,
                coverAssetMimeType = "image/png",
                createdAtEpochMillis = 1,
                updatedAtEpochMillis = 1,
            )
        }
    }

    @Test
    fun `every command has an explicit stable wire name and round trips`() {
        val commands = listOf(
            SyncCommand.UpsertIdentity(entityId, ContentType.MANGA, sourceBinding()),
            SyncCommand.SetLibraryMembership(entityId, inLibrary = true),
            SyncCommand.UpsertCategory(categoryId, "Favorites", CategoryScope.MANGA, position = 0),
            SyncCommand.SetCategoryOrder(categoryId, CategoryScope.MANGA, position = 2),
            SyncCommand.SetCategoryAssignment(entityId, categoryId, assigned = true),
            SyncCommand.SetChapterState(
                entityId,
                ChapterStatePatch(
                    chapterId = "chapter:12",
                    read = true,
                    bookmarked = false,
                    lastPageRead = 7,
                    lastReadAtEpochMillis = 1234,
                ),
            ),
            SyncCommand.SetProgress(entityId, locator),
            SyncCommand.SetBookmark(entityId, locator, bookmarked = true),
            SyncCommand.AppendHistory(entityId, "history:phone:1", locator, visitedAtEpochMillis = 1234),
            SyncCommand.ClearHistory(entityId, throughEpochMillis = 1234),
            SyncCommand.PatchTracking(
                entityId,
                trackerId = "anilist",
                fields = listOf(
                    TrackingFieldPatch(TrackingField.STATUS, "reading"),
                    TrackingFieldPatch(TrackingField.SCORE, null),
                ),
            ),
            SyncCommand.UpsertRepository(
                repositoryId,
                RepositoryDescriptor(
                    ecosystem = "mihon",
                    displayName = "Official",
                    canonicalUrl = "https://example.com/index.min.json",
                    enabled = true,
                ),
            ),
            SyncCommand.UpsertComicExtension(
                EpigraphEntityId("extension:app.example.source"),
                ComicExtensionDescriptor(
                    repositoryId = repositoryId,
                    packageName = "app.example.source",
                    displayName = "Example Source",
                    versionCode = 12,
                    versionName = "1.2.0",
                    artifactSha256 = hash,
                    desiredInstalled = true,
                ),
            ),
            SyncCommand.UpsertNovelPlugin(
                EpigraphEntityId("plugin:lnreader:example"),
                NovelPluginDescriptor(
                    repositoryId = repositoryId,
                    pluginId = "example.plugin",
                    displayName = "Example Novels",
                    version = "2.0.0",
                    manifestVersion = 1,
                    artifactSha256 = hash,
                    desiredInstalled = true,
                ),
            ),
            SyncCommand.SetAssetBinding(
                entityId,
                AssetDescriptor(hash, sizeBytes = 42, mediaType = "application/epub+zip"),
                AssetRole.PUBLICATION,
                bound = true,
            ),
            SyncCommand.SetEntityAlias(entityId, canonicalId, active = true),
            SyncCommand.MigrateEntity(
                entityId,
                canonicalId,
                reason = IdentityMigrationReason.USER_CONFIRMED,
            ),
            SyncCommand.DeleteEntity(entityId),
            SyncCommand.UpsertBookEntry(
                EpigraphEntityId("epub:sha256:$hash"),
                BookEntrySnapshot(
                    bookId = EpigraphEntityId("epub:sha256:$hash"),
                    contentType = ContentType.EPUB,
                    sha256 = hash,
                    title = "Example book",
                    mimeType = "application/epub+zip",
                    byteSize = 42,
                    createdAtEpochMillis = 1,
                    updatedAtEpochMillis = 2,
                ),
            ),
            SyncCommand.SetBookCategoryAssignments(
                EpigraphEntityId("epub:sha256:$hash"),
                listOf(categoryId),
            ),
        )
        val expectedNames = listOf(
            "upsert_identity",
            "set_library_membership",
            "upsert_category",
            "set_category_order",
            "set_category_assignment",
            "set_chapter_state",
            "set_progress",
            "set_bookmark",
            "append_history",
            "clear_history",
            "patch_tracking",
            "upsert_repository",
            "upsert_comic_extension",
            "upsert_novel_plugin",
            "set_asset_binding",
            "set_entity_alias",
            "migrate_entity",
            "delete_entity",
            "upsert_book_entry",
            "set_book_category_assignments",
        )

        commands.map(SyncCommand::operationWireName) shouldContainExactly expectedNames
        commands.map { command ->
            val encoded = Json.encodeToString(SyncCommand.serializer(), command)
            Json.parseToJsonElement(encoded).jsonObject.getValue("type").jsonPrimitive.content shouldBe
                command.operationWireName()
            Json.decodeFromString(SyncCommand.serializer(), encoded) shouldBe command
        }.size shouldBe commands.size
    }

    @Test
    fun `existing command wire names remain unchanged`() {
        SyncCommand.UpsertIdentity(entityId, ContentType.MANGA, sourceBinding()).operationWireName() shouldBe
            "upsert_identity"
        SyncCommand.SetLibraryMembership(entityId, true).operationWireName() shouldBe "set_library_membership"
        SyncCommand.SetCategoryAssignment(entityId, categoryId, true).operationWireName() shouldBe
            "set_category_assignment"
        SyncCommand.SetProgress(entityId, locator).operationWireName() shouldBe "set_progress"
        SyncCommand.SetBookmark(entityId, locator, true).operationWireName() shouldBe "set_bookmark"
        SyncCommand.DeleteEntity(entityId).operationWireName() shouldBe "delete_entity"
    }

    @Test
    fun `chapter patches distinguish omitted false and explicit progress reset`() {
        val patch = ChapterStatePatch(
            chapterId = "chapter:12",
            read = false,
            bookmarked = false,
            lastPageRead = 0,
            explicitProgressReset = true,
        )

        patch.read shouldBe false
        patch.bookmarked shouldBe false
        patch.lastPageRead shouldBe 0
        shouldThrow<IllegalArgumentException> {
            ChapterStatePatch(chapterId = "chapter:12", explicitProgressReset = true)
        }
        shouldThrow<IllegalArgumentException> {
            ChapterStatePatch(chapterId = "chapter:12")
        }
    }

    @Test
    fun `tracking updates are field granular and reject duplicate fields`() {
        val clearScore = TrackingFieldPatch(TrackingField.SCORE)
        clearScore.value shouldBe null

        shouldThrow<IllegalArgumentException> {
            SyncCommand.PatchTracking(
                entityId,
                trackerId = "anilist",
                fields = listOf(
                    TrackingFieldPatch(TrackingField.STATUS, "reading"),
                    TrackingFieldPatch(TrackingField.STATUS, "completed"),
                ),
            )
        }
    }

    @Test
    fun `artifact identities require immutable lowercase hashes`() {
        shouldThrow<IllegalArgumentException> {
            AssetDescriptor("AB".repeat(32), sizeBytes = 10, mediaType = "application/pdf")
        }
        shouldThrow<IllegalArgumentException> {
            ComicExtensionDescriptor(
                repositoryId = repositoryId,
                packageName = "not a package",
                displayName = "Bad",
                versionCode = 1,
                versionName = "1",
                artifactSha256 = hash,
                desiredInstalled = true,
            )
        }
    }

    @Test
    fun `aliases and migrations cannot target the source itself`() {
        shouldThrow<IllegalArgumentException> { SyncCommand.SetEntityAlias(entityId, entityId, active = true) }
        shouldThrow<IllegalArgumentException> {
            SyncCommand.MigrateEntity(entityId, entityId, IdentityMigrationReason.CANONICALIZED)
        }
    }

    private fun sourceBinding(): SourceBinding = SourceBinding.create(
        ecosystem = "mihon",
        repository = "official",
        plugin = "app.example.source",
        sourceId = "1234",
        url = "https://example.com/title",
    )
}
