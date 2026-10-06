package eu.kanade.tachiyomi.source.model

import java.io.Serializable
import kotlinx.serialization.json.JsonObject

interface SChapter : Serializable {

    var url: String

    var name: String

    var date_upload: Long

    var chapter_number: Float

    var scanlator: String?

    var chapterLocked: Boolean

    // lib 1.6: opaque per-source payload carried between the extension and the
    // source-api (e.g. Asura Scans stores the mangaSlug needed to rebuild the
    // chapter page URL). Persisted in the chapters table like mihon does.
    // Non-null to match mihonapi — extensions index it directly (chapter.memo["key"]).
    var memo: JsonObject

    var read: Boolean
        get() = false
        set(_) {}

    var last_page_read: Int
        get() = 0
        set(_) {}

    // Epoch milliseconds of the last read on the source side; 0 when unknown.
    var last_read_at: Long
        get() = 0
        set(_) {}

    fun copyFrom(other: SChapter) {
        name = other.name
        url = other.url
        date_upload = other.date_upload
        chapter_number = other.chapter_number
        scanlator = other.scanlator
        chapterLocked = other.chapterLocked
        memo = other.memo
    }

    companion object {
        fun create(): SChapter {
            return SChapterImpl()
        }
    }
}
