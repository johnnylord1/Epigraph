package epigraph.sync.core.outbox

import epigraph.contract.EpigraphEntityId
import epigraph.contract.EpigraphSyncProtocol
import epigraph.contract.ChapterStatePatch
import epigraph.contract.BookEntrySnapshot
import epigraph.contract.CategoryScope
import epigraph.contract.ClientMutationId
import epigraph.contract.DeviceId
import epigraph.contract.ContentType
import epigraph.contract.DecimalSourceId
import epigraph.contract.NovelEntrySnapshot
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableIdentityV3
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.ReaderLocator
import epigraph.contract.RepositoryDescriptor
import epigraph.contract.SyncCommand
import epigraph.contract.SyncCommandEnvelope
import epigraph.contract.SyncEntityType
import epigraph.contract.SyncScopeId
import epigraph.contract.TrackingField
import epigraph.contract.TrackingFieldPatch
import epigraph.contract.operationWireName
import epigraph.sync.core.protocol.EpigraphCoreEntityType
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.CoreMutationOperation
import epigraph.sync.core.protocol.CoreMutationsRequest
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class CoreV1OutboxAdapterTest {
    private val json = Json {
        classDiscriminator = "operation"
        encodeDefaults = true
        ignoreUnknownKeys = false
    }
    private val adapter = CoreV1OutboxAdapter(json)

    @Test
    fun `projects category command to exact flat Core v1 mutation`() {
        val command = SyncCommand.UpsertCategory(CATEGORY_ID, "Favorites", CategoryScope.NOVEL, 3)
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_CATEGORY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_CATEGORY)),
                lamport = 17,
            ),
        )

        assertEquals(MUTATION_ID, ready.mutation.clientMutationId)
        assertEquals(CATEGORY_ID.value, ready.mutation.entityId)
        assertEquals(CoreMutationOperation.MERGE, ready.mutation.op)
        assertEquals("Favorites", ready.mutation.patch?.get("name")?.jsonPrimitive?.content)
        assertEquals("3", ready.mutation.patch?.get("order")?.jsonPrimitive?.content)

        val wire = json.parseToJsonElement(
            json.encodeToString(CoreMutationsRequest("request-1", listOf(ready.mutation))),
        ).jsonObject["mutations"]!!.jsonArray.single().jsonObject
        assertEquals(EpigraphCoreEntityType.NOVEL_CATEGORY, wire["entityType"]?.jsonPrimitive?.content)
        assertEquals("merge", wire["op"]?.jsonPrimitive?.content)
        assertTrue("patch" in wire)
        assertFalse("deviceId" in wire)
        assertFalse("protocolVersion" in wire)
        assertFalse("command" in wire)
        assertFalse("operation" in wire)
        assertFalse("payloadJson" in wire)
        assertFalse("entityType" in wire.getValue("patch").jsonObject)
    }

    @Test
    fun `projects a novel library addition as a complete entry patch`() {
        val command = SyncCommand.SetNovelLibraryMembership(
            entityId = WORK_ID,
            inLibrary = true,
            entry = NovelEntrySnapshot(
                identityKey = WORK_ID.value,
                title = "Epigraph Novel",
                author = "Author",
                path = "/novel/epigraph",
                tags = listOf("fantasy"),
                source = buildJsonObject { put("pluginId", "hayai") },
                addedAtMs = 10,
                updatedAtMs = 11,
            ),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                lamport = 5,
            ),
        )

        assertEquals(CoreMutationOperation.MERGE, ready.mutation.op)
        assertEquals("Epigraph Novel", ready.mutation.patch?.get("title")?.jsonPrimitive?.content)
        assertEquals("/novel/epigraph", ready.mutation.patch?.get("path")?.jsonPrimitive?.content)
        assertEquals("fantasy", ready.mutation.patch?.get("tags")?.jsonArray?.single()?.jsonPrimitive?.content)
        assertFalse("locator" in ready.mutation.patch.orEmpty())
    }

    @Test
    fun `projects novel category assignment with a canonical immutable id`() {
        val command = SyncCommand.SetCategoryAssignment(WORK_ID, CATEGORY_ID, assigned = true)
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT)),
                lamport = 6,
            ),
        )

        assertTrue(ready.mutation.entityId.startsWith("novel-category-assignment:"))
        assertEquals(WORK_ID.value, ready.mutation.patch?.get("novelId")?.jsonPrimitive?.content)
        assertEquals(CATEGORY_ID.value, ready.mutation.patch?.get("categoryId")?.jsonPrimitive?.content)
    }

    @Test
    fun `novel category assignment sends only the fields the Core accepts`() {
        val work = PortableWorkRef.Novel("lnreader.plugin", ProviderOwnedKey("/Novel/KeepCase"))
        val command = SyncCommand.SetCategoryAssignment(WORK_ID, CATEGORY_ID, assigned = true, portableWorkRef = work)
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_CATEGORY_ASSIGNMENT)).copy(
                    supportsPortableSyncV3 = true,
                ),
                lamport = 7,
            ),
        )

        assertEquals(setOf("assignmentId", "novelId", "categoryId"), ready.mutation.patch.orEmpty().keys)
    }

    @Test
    fun `projects comic library membership when the Core advertises the additive entity`() {
        val command = SyncCommand.SetLibraryMembership(COMIC_ID, true)
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_ENTRY, COMIC_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_ENTRY)),
                lamport = 1,
            ),
        )

        assertEquals(COMIC_ID.value, ready.mutation.entityId)
        assertEquals(CoreMutationOperation.MERGE, ready.mutation.op)
        assertEquals(COMIC_ID.value, ready.mutation.patch?.get("comicId")?.jsonPrimitive?.content)
        assertEquals("true", ready.mutation.patch?.get("inLibrary")?.jsonPrimitive?.content)
    }

    @Test
    fun `projects portable comic membership and category without leaking local ids`() {
        val work = PortableWorkRef.Comic(
            sourceId = DecimalSourceId("10002"),
            mangaKey = ProviderOwnedKey("/Manga/KeepCase?part=A%2FB"),
        )
        val workId = EpigraphEntityId(PortableIdentityV3.workId(work))
        val membership = SyncCommand.SetLibraryMembership(workId, true, work)
        val membershipReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_ENTRY, COMIC_SCOPE, membership),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_ENTRY)).copy(
                    supportsPortableSyncV3 = true,
                ),
                lamport = 1,
            ),
        )

        assertEquals(workId.value, membershipReady.mutation.entityId)
        assertEquals(
            "10002",
            membershipReady.mutation.patch
                ?.get("portableWorkRef")
                ?.jsonObject
                ?.get("sourceId")
                ?.jsonPrimitive
                ?.content,
        )
        assertFalse("localMangaId" in membershipReady.mutation.patch.orEmpty())

        val assignment = SyncCommand.SetCategoryAssignment(workId, CATEGORY_ID, true, work)
        val assignmentReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT, COMIC_SCOPE, assignment),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT)).copy(
                    supportsPortableSyncV3 = true,
                ),
                lamport = 2,
            ),
        )
        assertEquals(
            workId.value,
            assignmentReady.mutation.patch?.get("comicId")?.jsonPrimitive?.content,
        )
        assertEquals(
            "/Manga/KeepCase?part=A%2FB",
            assignmentReady.mutation.patch
                ?.get("portableWorkRef")
                ?.jsonObject
                ?.get("mangaKey")
                ?.jsonPrimitive
                ?.content,
        )
    }

    @Test
    fun `projects comic category and assignment mutations with stable ids`() {
        val category = SyncCommand.UpsertCategory(CATEGORY_ID, "Comics", CategoryScope.MANGA, 2)
        val categoryReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_CATEGORY, COMIC_SCOPE, category),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_CATEGORY)),
                lamport = 2,
            ),
        )
        assertEquals("Comics", categoryReady.mutation.patch?.get("name")?.jsonPrimitive?.content)

        val assignment = SyncCommand.SetCategoryAssignment(COMIC_ID, CATEGORY_ID, assigned = true)
        val assignmentReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT, COMIC_SCOPE, assignment),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_CATEGORY_ASSIGNMENT)),
                lamport = 3,
            ),
        )
        assertTrue(assignmentReady.mutation.entityId.startsWith("comic-category-assignment:"))
        assertEquals(COMIC_ID.value, assignmentReady.mutation.patch?.get("comicId")?.jsonPrimitive?.content)
        assertEquals(CATEGORY_ID.value, assignmentReady.mutation.patch?.get("categoryId")?.jsonPrimitive?.content)
    }

    @Test
    fun `blocks current entity when capability is not advertised`() {
        val command = SyncCommand.DeleteEntity(WORK_ID)
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(emptySet()),
                lamport = 1,
            ),
        )

        assertEquals(CoreOutboxBlockReason.ENTITY_CAPABILITY_NOT_ADVERTISED, blocked.reason)
    }

    @Test
    fun `does not put device id on wire and blocks a token for another device`() {
        val command = SyncCommand.DeleteEntity(WORK_ID)
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command),
                authenticatedDeviceId = "another-device",
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                lamport = 1,
            ),
        )

        assertEquals(CoreOutboxBlockReason.AUTHENTICATED_DEVICE_MISMATCH, blocked.reason)
        assertEquals(DEVICE_ID, blocked.identity.deviceId)
        assertEquals(MUTATION_ID, blocked.identity.clientMutationId)
    }

    @Test
    fun `blocks payload whose envelope does not match persisted row`() {
        val command = SyncCommand.DeleteEntity(WORK_ID)
        val original = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command)
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = original.copy(clientMutationId = "tampered-id"),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                lamport = 1,
            ),
        )

        assertEquals(CoreOutboxBlockReason.ROW_ENVELOPE_MISMATCH, blocked.reason)
    }

    @Test
    fun `maps delete only for entity types whose Core v1 variant accepts null patch`() {
        val command = SyncCommand.DeleteEntity(WORK_ID)
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                lamport = 8,
            ),
        )
        assertEquals(CoreMutationOperation.DELETE, ready.mutation.op)
        assertNull(ready.mutation.patch)

        val blockedProgress = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_PROGRESS, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_PROGRESS)),
                lamport = 9,
            ),
        )
        assertEquals(CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION, blockedProgress.reason)
    }

    @Test
    fun `projects EPUB progress without nesting the local locator`() {
        val command = SyncCommand.SetProgress(
            WORK_ID,
            ReaderLocator.Epub(WORK_ID, cfi = "epubcfi(/6/2)", progression = 0.42),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.BOOK_PROGRESS, BOOK_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.BOOK_PROGRESS)),
                lamport = 2,
            ),
        )

        val patch = ready.mutation.patch!!
        assertEquals("epub", patch["renderer"]?.jsonPrimitive?.content)
        assertEquals("epubcfi(/6/2)", patch["location"]?.jsonPrimitive?.content)
        assertEquals("0.42", patch["progressPercent"]?.jsonPrimitive?.content)
        assertFalse("locator" in patch)
        assertFalse("explicitReset" in patch)
    }

    @Test
    fun `projects PDF progress only when document progression is explicit`() {
        val incomplete = SyncCommand.SetProgress(
            BOOK_ID,
            ReaderLocator.Pdf(BOOK_ID, pageIndex = 4),
        )
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.BOOK_PROGRESS, BOOK_SCOPE, incomplete),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.BOOK_PROGRESS)),
                lamport = 3,
            ),
        )
        assertEquals(CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION, blocked.reason)

        val complete = SyncCommand.SetProgress(
            BOOK_ID,
            ReaderLocator.Pdf(
                entityId = BOOK_ID,
                pageIndex = 4,
                totalPages = 20,
                documentProgression = 0.25,
            ),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.BOOK_PROGRESS, BOOK_SCOPE, complete),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.BOOK_PROGRESS)),
                lamport = 4,
            ),
        )
        assertEquals("pdf", ready.mutation.patch?.get("renderer")?.jsonPrimitive?.content)
        // The wire carries the desktop's 1-based page number.
        assertEquals("5", ready.mutation.patch?.get("pageIndex")?.jsonPrimitive?.content)
        assertEquals("20", ready.mutation.patch?.get("totalPages")?.jsonPrimitive?.content)
        assertEquals("0.25", ready.mutation.patch?.get("progressPercent")?.jsonPrimitive?.content)
    }

    @Test
    fun `projects complete book metadata categories and annotations without field loss`() {
        val entry = SyncCommand.UpsertBookEntry(
            BOOK_ID,
            BookEntrySnapshot(
                bookId = BOOK_ID,
                contentType = ContentType.EPUB,
                sha256 = BOOK_HASH,
                title = "Example book",
                author = "Author",
                description = "Description",
                mimeType = "application/epub+zip",
                byteSize = 123,
                coverAssetSha256 = COVER_HASH,
                coverAssetByteSize = 456,
                coverAssetMimeType = "image/webp",
                chapterCount = 29,
                pageCount = 321,
                createdAtEpochMillis = 10,
                updatedAtEpochMillis = 20,
            ),
        )
        assertEquals(29, entry.entry.chapterCount)
        val encodedEntry = record(EpigraphCoreEntityType.BOOK_ENTRY, BOOK_SCOPE, entry)
        assertTrue(encodedEntry.payloadJson.contains("\"chapterCount\":29"))
        val decodedEntry = json.decodeFromString<SyncCommandEnvelope>(encodedEntry.payloadJson)
            .command as SyncCommand.UpsertBookEntry
        assertEquals(29, decodedEntry.entry.chapterCount)
        val entryReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                encodedEntry,
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.BOOK_ENTRY)),
                5,
            ),
        )
        assertEquals(BOOK_HASH, entryReady.mutation.patch?.get("assetFingerprint")?.jsonPrimitive?.content)
        assertEquals(COVER_HASH, entryReady.mutation.patch?.get("coverAssetSha256")?.jsonPrimitive?.content)
        assertEquals("456", entryReady.mutation.patch?.get("coverAssetByteSize")?.jsonPrimitive?.content)
        assertEquals("image/webp", entryReady.mutation.patch?.get("coverAssetMimeType")?.jsonPrimitive?.content)
        assertEquals("29", entryReady.mutation.patch?.get("tocCount")?.jsonPrimitive?.content)
        assertEquals("29", entryReady.mutation.patch?.get("spineCount")?.jsonPrimitive?.content)
        assertEquals("29", entryReady.mutation.patch?.get("sectionCount")?.jsonPrimitive?.content)
        assertEquals("321", entryReady.mutation.patch?.get("pageCount")?.jsonPrimitive?.content)
        assertFalse(entryReady.mutation.patch?.containsKey("coverPath") == true)

        val categories = SyncCommand.SetBookCategoryAssignments(BOOK_ID, listOf(CATEGORY_ID))
        val categoryReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.BOOK_CATEGORY_ASSIGNMENT, BOOK_SCOPE, categories),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.BOOK_CATEGORY_ASSIGNMENT)),
                6,
            ),
        )
        assertEquals(CATEGORY_ID.value, categoryReady.mutation.patch?.get("categoryIds")?.jsonArray?.single()?.jsonPrimitive?.content)

        val bookmark = SyncCommand.UpsertBookBookmark(
            entityId = EpigraphEntityId("bookmark-1"),
            bookId = BOOK_ID,
            locator = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/2)", 0.5),
            label = "Chapter 2",
            note = "Remember this",
            createdAtEpochMillis = 30,
            updatedAtEpochMillis = 40,
        )
        val bookmarkReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.BOOK_BOOKMARK, BOOK_SCOPE, bookmark),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.BOOK_BOOKMARK)),
                7,
            ),
        )
        assertEquals("Remember this", bookmarkReady.mutation.patch?.get("note")?.jsonPrimitive?.content)
        assertEquals("40", bookmarkReady.mutation.patch?.get("updatedAtMs")?.jsonPrimitive?.content)

        val highlight = SyncCommand.UpsertBookHighlight(
            entityId = EpigraphEntityId("highlight-1"),
            bookId = BOOK_ID,
            start = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/2)", 0.5),
            end = ReaderLocator.Epub(BOOK_ID, "epubcfi(/6/4)", 0.55),
            selectedText = "Selected",
            colorArgb = 0xffaa55,
            note = "Highlight note",
            createdAtEpochMillis = 50,
            updatedAtEpochMillis = 60,
        )
        val highlightReady = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.BOOK_HIGHLIGHT, BOOK_SCOPE, highlight),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.BOOK_HIGHLIGHT)),
                8,
            ),
        )
        assertEquals("Selected", highlightReady.mutation.patch?.get("selectedText")?.jsonPrimitive?.content)
        assertTrue(highlightReady.mutation.patch?.get("startLocatorJson") is kotlinx.serialization.json.JsonObject)
    }

    @Test
    fun `projects comic progress into the Core history shape`() {
        val command = SyncCommand.SetProgress(
            COMIC_ID,
            ReaderLocator.Manga(
                entityId = COMIC_ID,
                chapterId = "chapter-7",
                pageIndex = 4,
                pageCount = 10,
                progression = 0.5,
            ),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_HISTORY, COMIC_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_HISTORY)),
                lamport = 12,
            ),
        )

        assertEquals("comic.history::$COMIC_ID", ready.mutation.entityId)
        val patch = ready.mutation.patch!!
        assertEquals(COMIC_ID.value, patch["comicId"]?.jsonPrimitive?.content)
        assertEquals("chapter-7", patch["chapterId"]?.jsonPrimitive?.content)
        assertEquals("4", patch["pageIndex"]?.jsonPrimitive?.content)
        assertEquals("10", patch["pageCount"]?.jsonPrimitive?.content)
        assertEquals("0.5", patch["progressPercent"]?.jsonPrimitive?.content)
        assertEquals("1234", patch["readAtMs"]?.jsonPrimitive?.content)
        assertFalse("locator" in patch)
    }

    @Test
    fun `projects comic chapter state with a stable chapter entity`() {
        val command = SyncCommand.SetChapterState(
            entityId = COMIC_ID,
            state = ChapterStatePatch(
                chapterId = "chapter-7",
                read = true,
                bookmarked = false,
                lastPageRead = 9,
                lastReadAtEpochMillis = 1234,
            ),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_CHAPTER_STATE, COMIC_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_CHAPTER_STATE)),
                lamport = 13,
            ),
        )

        assertEquals("comic.chapter_state::${COMIC_ID.value}::chapter-7", ready.mutation.entityId)
        assertEquals(COMIC_ID.value, ready.mutation.patch?.get("comicId")?.jsonPrimitive?.content)
        assertEquals("chapter-7", ready.mutation.patch?.get("chapterId")?.jsonPrimitive?.content)
        assertEquals("true", ready.mutation.patch?.get("read")?.jsonPrimitive?.content)
        assertEquals("false", ready.mutation.patch?.get("bookmarked")?.jsonPrimitive?.content)
        assertEquals("9", ready.mutation.patch?.get("lastPageRead")?.jsonPrimitive?.content)
    }

    @Test
    fun `comic chapter state keyed by the reader router sends the bare comic id`() {
        val command = SyncCommand.SetChapterState(
            entityId = EpigraphEntityId("comic.chapter_state::${COMIC_ID.value}::chapter-7"),
            state = ChapterStatePatch(chapterId = "chapter-7", read = true),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.COMIC_CHAPTER_STATE, COMIC_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.COMIC_CHAPTER_STATE)),
                lamport = 13,
            ),
        )

        assertEquals("comic.chapter_state::${COMIC_ID.value}::chapter-7", ready.mutation.entityId)
        assertEquals(COMIC_ID.value, ready.mutation.patch?.get("comicId")?.jsonPrimitive?.content)
        assertEquals(ready.mutation.entityId, ready.mutation.patch?.get("chapterStateId")?.jsonPrimitive?.content)
    }

    @Test
    fun `projects novel progress with the stable chapter binding and progression`() {
        val command = SyncCommand.SetProgress(
            WORK_ID,
            ReaderLocator.Novel(
                entityId = WORK_ID,
                chapterId = "novel-chapter-7",
                blockIndex = 2,
                textOffset = 140,
                progression = 0.73,
                chapterOrderKey = 7.0,
            ),
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_PROGRESS, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_PROGRESS)),
                lamport = 12,
            ),
        )

        val patch = ready.mutation.patch!!
        assertEquals("novel-chapter-7", patch["chapterId"]?.jsonPrimitive?.content)
        assertEquals("0.73", patch["progressPercent"]?.jsonPrimitive?.content)
        assertEquals(7.0, patch["chapterOrderKey"]?.jsonPrimitive?.content?.toDoubleOrNull())
        assertEquals("block:2:140", patch["locator"]?.jsonPrimitive?.content)
        assertFalse("operation" in patch)
    }

    @Test
    fun `projects novel chapter read state as Core unread without losing catalog fields`() {
        val command = SyncCommand.SetNovelChapterState(
            entityId = EpigraphEntityId("novel-chapter-7"),
            novelId = WORK_ID,
            path = "/novel/chapter-7",
            title = "Chapter 7",
            chapterOrderKey = 7.0,
            releaseTimeEpochMillis = 900,
            unread = false,
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_CHAPTER, NOVEL_SCOPE, command),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_CHAPTER)),
                13,
            ),
        )

        assertEquals("novel-chapter-7", ready.mutation.entityId)
        assertEquals(WORK_ID.value, ready.mutation.patch?.get("novelId")?.jsonPrimitive?.content)
        assertEquals("/novel/chapter-7", ready.mutation.patch?.get("path")?.jsonPrimitive?.content)
        assertEquals("false", ready.mutation.patch?.get("unread")?.jsonPrimitive?.content)
    }

    @Test
    fun `projects deterministic novel bookmark merge and explicit delete`() {
        val bookmarkId = EpigraphEntityId("novel-bookmark:" + "a".repeat(64))
        fun command(bookmarked: Boolean) = SyncCommand.SetNovelChapterBookmark(
            entityId = bookmarkId,
            novelId = WORK_ID,
            locator = ReaderLocator.Novel(
                entityId = WORK_ID,
                chapterId = "novel-chapter-7",
                blockIndex = 2,
                textOffset = 140,
                progression = 0.73,
                chapterOrderKey = 7.0,
            ),
            chapterTitle = "Chapter 7",
            bookmarked = bookmarked,
            savedAtEpochMillis = 1_234,
        )
        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_BOOKMARK, NOVEL_SCOPE, command(true)),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_BOOKMARK)),
                14,
            ),
        )
        assertEquals(CoreMutationOperation.MERGE, ready.mutation.op)
        assertEquals(bookmarkId.value, ready.mutation.entityId)
        assertEquals("novel-chapter-7", ready.mutation.patch?.get("chapterId")?.jsonPrimitive?.content)
        assertEquals("block:2:140", ready.mutation.patch?.get("locator")?.jsonPrimitive?.content)

        val deleted = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_BOOKMARK, NOVEL_SCOPE, command(false)),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_BOOKMARK)),
                15,
            ),
        )
        assertEquals(CoreMutationOperation.DELETE, deleted.mutation.op)
        assertNull(deleted.mutation.patch)
    }

    @Test
    fun `portable novel progress emits only canonical provider identities`() {
        val portableWork = PortableWorkRef.Novel("lnreader.plugin", ProviderOwnedKey("/Novel/KeepCase"))
        val portableChapter = PortableChapterRef.Novel(portableWork, ProviderOwnedKey("/Chapter/KeepCase"))
        val command = SyncCommand.SetProgress(
            WORK_ID,
            ReaderLocator.Novel(
                entityId = WORK_ID,
                chapterId = "local-chapter-7",
                blockIndex = 2,
                textOffset = 140,
                progression = 0.73,
                chapterOrderKey = 7.0,
                portableWork = portableWork,
                portableChapter = portableChapter,
            ),
        )

        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_PROGRESS, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_PROGRESS)).copy(
                    supportsPortableSyncV3 = true,
                ),
                lamport = 12,
            ),
        )

        assertEquals(
            "novel.progress::${PortableIdentityV3.workId(portableWork)}",
            ready.mutation.entityId,
        )
        assertEquals(
            PortableIdentityV3.chapterId(portableChapter),
            ready.mutation.patch?.get("chapterId")?.jsonPrimitive?.content,
        )
        assertEquals(
            "lnreader.plugin",
            ready.mutation.patch?.get("portableWorkRef")?.jsonObject?.get("pluginId")?.jsonPrimitive?.content,
        )
    }

    @Test
    fun `novel history carries the desktop chapter id and round-trips through the replica`() {
        val portableWork = PortableWorkRef.Novel("mahoureader", ProviderOwnedKey("/series/352/Keep Case(1)"))
        val portableChapter = PortableChapterRef.Novel(portableWork, ProviderOwnedKey("/series/352/cap-279!"))
        val entryId = "novel.history::${PortableIdentityV3.workId(portableWork)}::" +
            PortableIdentityV3.chapterId(portableChapter)
        val command = SyncCommand.AppendHistory(
            entityId = WORK_ID,
            entryId = entryId,
            locator = ReaderLocator.Novel(
                entityId = WORK_ID,
                chapterId = "local-chapter-279",
                blockIndex = 4,
                textOffset = 30,
                progression = 0.12,
                portableWork = portableWork,
                portableChapter = portableChapter,
            ),
            visitedAtEpochMillis = 1_790_000_000_000,
            chapterTitle = "Capítulo 279",
        )

        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_HISTORY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_HISTORY)),
                lamport = 13,
            ),
        )

        val patch = requireNotNull(ready.mutation.patch)
        assertEquals(entryId, ready.mutation.entityId)
        assertEquals(PortableIdentityV3.workId(portableWork), patch["novelId"]?.jsonPrimitive?.content)
        assertEquals(
            "chapter:novel:mahoureader:%2Fseries%2F352%2FKeep%20Case(1):%2Fseries%2F352%2Fcap-279!",
            patch["chapterId"]?.jsonPrimitive?.content,
        )
        assertEquals("Capítulo 279", patch["chapterTitle"]?.jsonPrimitive?.content)
        assertEquals(1_790_000_000_000, patch["readAtMs"]?.jsonPrimitive?.content?.toLong())
        assertEquals(
            PortableIdentityV3.workId(portableWork) to "/series/352/cap-279!",
            epigraph.sync.core.replica.novelHistoryChapter(patch),
        )
    }

    @Test
    fun `blocks repository command because local v2 lacks required Core timestamps`() {
        val command = SyncCommand.UpsertRepository(
            REPOSITORY_ID,
            RepositoryDescriptor(
                ecosystem = "lnreader",
                displayName = "Official",
                canonicalUrl = "https://example.org/repository.json",
                enabled = true,
            ),
        )
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_REPOSITORY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_REPOSITORY)),
                lamport = 4,
            ),
        )

        assertEquals(CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION, blocked.reason)
    }

    @Test
    fun `blocks incomplete merge rather than sending domain command as patch`() {
        val command = SyncCommand.SetLibraryMembership(WORK_ID, true)
        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record = record(EpigraphCoreEntityType.NOVEL_ENTRY, NOVEL_SCOPE, command),
                authenticatedDeviceId = DEVICE_ID,
                capabilities = capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                lamport = 1,
            ),
        )

        assertEquals(CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION, blocked.reason)
    }

    @Test
    fun `blocks malformed local JSON and invalid scope without throwing`() {
        val malformed = CoreOutboxRecord(
            deviceId = DEVICE_ID,
            clientMutationId = MUTATION_ID,
            scopeId = NOVEL_SCOPE,
            entityType = EpigraphCoreEntityType.NOVEL_ENTRY,
            entityId = WORK_ID.value,
            operation = "delete_entity",
            payloadJson = "{not-json",
            createdAtEpochMillis = 10,
        )
        val malformedResult = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                malformed,
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.MALFORMED_LOCAL_PAYLOAD, malformedResult.reason)

        val command = SyncCommand.DeleteEntity(WORK_ID)
        val invalidScope = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_ENTRY, BOOK_SCOPE, command),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.INVALID_SCOPE, invalidScope.reason)
    }

    @Test
    fun `blocks novel and comic profile scopes with an empty profile id`() {
        val novelCommand = SyncCommand.DeleteEntity(WORK_ID)
        val novelResult = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_ENTRY, "novels:profile:", novelCommand),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.INVALID_SCOPE, novelResult.reason)

        val comicCommand = SyncCommand.DeleteEntity(WORK_ID)
        val comicResult = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.COMIC_HISTORY, "comics:profile:", comicCommand),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.COMIC_HISTORY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.INVALID_SCOPE, comicResult.reason)
    }

    @Test
    fun `blocks malformed scope namespaces and exacts books global scope`() {
        val command = SyncCommand.DeleteEntity(WORK_ID)
        val malformedNovel = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.NOVEL_ENTRY, "novels:main", command),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.INVALID_SCOPE, malformedNovel.reason)

        val malformedBook = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(
                record(EpigraphCoreEntityType.BOOK_ENTRY, "books:profile:main", command),
                DEVICE_ID,
                capabilities(setOf(EpigraphCoreEntityType.BOOK_ENTRY)),
                1,
            ),
        )
        assertEquals(CoreOutboxBlockReason.INVALID_SCOPE, malformedBook.reason)
    }

    @Test
    fun `projects full state tracker patch only when the core advertises tracking`() {
        val trackingId = EpigraphEntityId("novel.tracking::novel:abc::novelupdates")
        val command = SyncCommand.PatchTracking(trackingId, "novelupdates", trackingFields())
        val record = record(EpigraphCoreEntityType.NOVEL_TRACKING, NOVEL_SCOPE, command)

        val blocked = assertInstanceOf(
            CoreOutboxAdaptation.Blocked::class.java,
            adapter.adapt(record, DEVICE_ID, capabilities(setOf(EpigraphCoreEntityType.NOVEL_ENTRY)), 1),
        )
        assertEquals(CoreOutboxBlockReason.ENTITY_CAPABILITY_NOT_ADVERTISED, blocked.reason)

        val ready = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(record, DEVICE_ID, capabilities(setOf(EpigraphCoreEntityType.NOVEL_TRACKING)), 2),
        )
        val patch = ready.mutation.patch!!
        assertEquals(trackingId.value, ready.mutation.entityId)
        assertEquals(CoreMutationOperation.MERGE, ready.mutation.op)
        assertEquals("novel:abc", patch["novelId"]?.jsonPrimitive?.content)
        assertEquals("novelupdates", patch["trackerKey"]?.jsonPrimitive?.content)
        assertEquals("4242", patch["remoteId"]?.jsonPrimitive?.content)
        assertEquals("null", patch["libraryId"].toString())
        assertEquals("12.5", patch["progress"]?.jsonPrimitive?.content)
        assertEquals("1234", patch["updatedAtMs"]?.jsonPrimitive?.content)
        val serialized = patch.toString()
        listOf("token", "password", "Bearer", "fields", "operation").forEach {
            assertFalse(serialized.contains(it, ignoreCase = true), it)
        }
    }

    @Test
    fun `tracker patches and tombstones fail closed on partial or mismatched records`() {
        val caps = capabilities(setOf(EpigraphCoreEntityType.COMIC_TRACKING, EpigraphCoreEntityType.NOVEL_TRACKING))
        val partial = SyncCommand.PatchTracking(
            EpigraphEntityId("novel.tracking::novel:abc::anilist"),
            "anilist",
            trackingFields().filterNot { it.field == TrackingField.SCORE },
        )
        val wrongTracker = SyncCommand.PatchTracking(
            EpigraphEntityId("novel.tracking::novel:abc::anilist"),
            "kitsu",
            trackingFields(),
        )
        val legacyComic = SyncCommand.PatchTracking(
            EpigraphEntityId("comic.tracking::suwayomi:core:manga:1::anilist"),
            "anilist",
            trackingFields(),
        )
        listOf(
            record(EpigraphCoreEntityType.NOVEL_TRACKING, NOVEL_SCOPE, partial),
            record(EpigraphCoreEntityType.NOVEL_TRACKING, NOVEL_SCOPE, wrongTracker),
            record(EpigraphCoreEntityType.COMIC_TRACKING, COMIC_SCOPE, legacyComic),
        ).forEach { record ->
            val blocked = assertInstanceOf(
                CoreOutboxAdaptation.Blocked::class.java,
                adapter.adapt(record, DEVICE_ID, caps, 1),
            )
            assertEquals(CoreOutboxBlockReason.UNSAFE_OR_INCOMPLETE_PROJECTION, blocked.reason)
        }

        val tombstone = assertInstanceOf(
            CoreOutboxAdaptation.Ready::class.java,
            adapter.adapt(
                record(
                    EpigraphCoreEntityType.COMIC_TRACKING,
                    COMIC_SCOPE,
                    SyncCommand.DeleteEntity(EpigraphEntityId("comic.tracking::comic:xyz::anilist")),
                ),
                DEVICE_ID,
                caps,
                1,
            ),
        )
        assertEquals(CoreMutationOperation.DELETE, tombstone.mutation.op)
        assertNull(tombstone.mutation.patch)
    }

    private fun trackingFields() = listOf(
        TrackingFieldPatch(TrackingField.REMOTE_ID, "4242"),
        TrackingFieldPatch(TrackingField.LIBRARY_ID, null),
        TrackingFieldPatch(TrackingField.TITLE, "Shadow Slave"),
        TrackingFieldPatch(TrackingField.REMOTE_URL, "https://tracker.example/4242"),
        TrackingFieldPatch(TrackingField.STATUS, "1"),
        TrackingFieldPatch(TrackingField.PROGRESS, "12.5"),
        TrackingFieldPatch(TrackingField.TOTAL_CHAPTERS, "100"),
        TrackingFieldPatch(TrackingField.SCORE, "8.0"),
        TrackingFieldPatch(TrackingField.STARTED_AT, "1700000000000"),
        TrackingFieldPatch(TrackingField.FINISHED_AT, "0"),
    )

    private fun record(
        entityType: String,
        scopeId: String,
        command: SyncCommand,
    ): CoreOutboxRecord {
        val envelope = SyncCommandEnvelope(
            protocolVersion = EpigraphSyncProtocol.CURRENT_VERSION,
            deviceId = DeviceId(DEVICE_ID),
            clientMutationId = ClientMutationId(MUTATION_ID),
            scopeId = SyncScopeId(scopeId),
            entityType = SyncEntityType(entityType),
            command = command,
        )
        return CoreOutboxRecord(
            deviceId = DEVICE_ID,
            clientMutationId = MUTATION_ID,
            scopeId = scopeId,
            entityType = entityType,
            entityId = command.entityId.value,
            operation = command.operationWireName(),
            payloadJson = json.encodeToString(envelope),
            createdAtEpochMillis = 1234,
        )
    }

    private fun capabilities(entityTypes: Set<String>) = CoreCapabilities(
        serverProtocolVersion = 1,
        minClientVersion = "0.1.0",
        supportedScopes = listOf("books:global", "novels:profile:<paired-profile>"),
        supportsSseReplay = true,
        supportsManualIpFallback = true,
        supportsOwnerTransfer = true,
        supportsSnapshot = true,
        supportsAssets = true,
        supportsNovelChapterAssets = true,
        supportsNovelPluginSync = true,
        supportsSuwayomiProxy = true,
        supportsSuwayomiWebsocketProxy = true,
        suwayomiProxyPathTemplate = "/v1/suwayomi/{path}",
        snapshotSchemaVersion = 2,
        snapshotEntityTypes = entityTypes,
        tlsCertSha256 = "a".repeat(64),
        mdnsServiceName = "_epigraph-syncd._tcp.local.",
        currentServerVersion = 1,
        minReplayableServerVersion = 0,
    )

    private companion object {
        const val DEVICE_ID = "android-phone"
        const val MUTATION_ID = "mutation-1"
        const val BOOK_SCOPE = "books:global"
        const val NOVEL_SCOPE = "novels:profile:main"
        const val COMIC_SCOPE = "comics:profile:main"
        val WORK_ID = EpigraphEntityId("novel-work-1")
        const val BOOK_HASH = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const val COVER_HASH = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        val BOOK_ID = EpigraphEntityId("epub:sha256:$BOOK_HASH")
        val COMIC_ID = EpigraphEntityId("suwayomi:core:manga:comic-1")
        val CATEGORY_ID = EpigraphEntityId("novel-category-1")
        val REPOSITORY_ID = EpigraphEntityId("novel-repository-1")
    }
}
