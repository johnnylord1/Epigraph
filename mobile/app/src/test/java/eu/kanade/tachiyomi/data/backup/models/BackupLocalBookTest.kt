package eu.kanade.tachiyomi.data.backup.models

import epigraph.books.local.LocalBookRestoreEntry
import epigraph.contract.EpigraphEntityId
import epigraph.contract.ContentType
import epigraph.contract.ReaderLocator
import kotlinx.serialization.protobuf.ProtoBuf
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class BackupLocalBookTest {
    private val sha256 = "a".repeat(64)
    private val bookId = "epub:sha256:$sha256"
    private val locator = ReaderLocator.Epub(EpigraphEntityId(bookId), "aethon-spine:0", 0.5)

    @Test
    fun `local book metadata round trips through the existing backup envelope`() {
        val source = Backup(
            backupManga = emptyList(),
            backupLocalBooks = listOf(
                BackupLocalBook(
                    bookId = bookId,
                    contentType = ContentType.EPUB.name,
                    sha256 = sha256,
                    displayName = "Offline book",
                    mimeType = "application/epub+zip",
                    byteSize = 42,
                    importedAt = 10,
                    updatedAt = 11,
                    progressLocatorJson = "{\"type\":\"epub\"}",
                    categoryNames = listOf("Reading"),
                ),
            ),
        )

        val restored = ProtoBuf.decodeFromByteArray(
            Backup.serializer(),
            ProtoBuf.encodeToByteArray(Backup.serializer(), source),
        )

        assertEquals(source.backupLocalBooks, restored.backupLocalBooks)
        assertFalse(restored.backupLocalBooks.single().toString().contains("privatePath"))
    }

    @Test
    fun `restore entry rejects a locator from another book`() {
        assertThrows(IllegalArgumentException::class.java) {
            LocalBookRestoreEntry(
                bookId = bookId,
                contentType = ContentType.EPUB,
                sha256 = sha256,
                displayName = "Offline book",
                author = null,
                description = null,
                mimeType = "application/epub+zip",
                byteSize = 42,
                importedAt = 10,
                updatedAt = 11,
                progress = locator.copy(entityId = EpigraphEntityId("epub:sha256:${"b".repeat(64)}")),
                bookmarks = emptyList(),
                highlights = emptyList(),
                categoryIds = emptyList(),
            )
        }
    }
}
