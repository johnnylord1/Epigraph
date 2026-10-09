package eu.kanade.tachiyomi.data.backup.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoNumber

/**
 * Local publication metadata in an Epigraph backup.
 *
 * The private EPUB/PDF bytes are not part of this record. A backup made with book files stores
 * them beside the payload in the backup container, named by [sha256], and a restore imports a
 * missing file only when its bytes match that hash. Otherwise the restore recreates the library
 * entry and reader state as a missing-file record, which the user can relink to a verified import.
 */
@Serializable
data class BackupLocalBook(
    @ProtoNumber(1) val bookId: String,
    @ProtoNumber(2) val contentType: String,
    @ProtoNumber(3) val sha256: String,
    @ProtoNumber(4) val displayName: String,
    @ProtoNumber(5) val author: String? = null,
    @ProtoNumber(6) val description: String? = null,
    @ProtoNumber(7) val mimeType: String,
    @ProtoNumber(8) val byteSize: Long,
    @ProtoNumber(9) val importedAt: Long,
    @ProtoNumber(10) val updatedAt: Long,
    @ProtoNumber(11) val progressLocatorJson: String? = null,
    @ProtoNumber(12) val bookmarks: List<BackupLocalBookBookmark> = emptyList(),
    @ProtoNumber(13) val highlights: List<BackupLocalBookHighlight> = emptyList(),
    @ProtoNumber(14) val categoryNames: List<String> = emptyList(),
    @ProtoNumber(15) val chapterCount: Int? = null,
    @ProtoNumber(16) val pageCount: Int? = null,
)

@Serializable
data class BackupLocalBookBookmark(
    @ProtoNumber(1) val bookmarkId: String,
    @ProtoNumber(2) val locatorJson: String,
    @ProtoNumber(3) val label: String? = null,
    @ProtoNumber(4) val note: String? = null,
    @ProtoNumber(5) val createdAt: Long,
    @ProtoNumber(6) val updatedAt: Long,
)

@Serializable
data class BackupLocalBookHighlight(
    @ProtoNumber(1) val highlightId: String,
    @ProtoNumber(2) val startLocatorJson: String,
    @ProtoNumber(3) val endLocatorJson: String,
    @ProtoNumber(4) val selectedText: String,
    @ProtoNumber(5) val colorArgb: Long,
    @ProtoNumber(6) val note: String? = null,
    @ProtoNumber(7) val createdAt: Long,
    @ProtoNumber(8) val updatedAt: Long,
)
