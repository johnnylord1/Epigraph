package eu.kanade.tachiyomi.data.backup.models

import eu.kanade.tachiyomi.source.Source
import epigraph.novel.source.TextSource
import eu.kanade.tachiyomi.source.isNovelSource
import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoNumber

@Serializable
data class BrokenBackupSource(
    @ProtoNumber(0) var name: String = "",
    @ProtoNumber(1) var sourceId: Long,
)

@Serializable
data class BackupSource(
    @ProtoNumber(1) var name: String = "",
    @ProtoNumber(2) var sourceId: Long,
    // Lets a restore keep novels out of the comic library before their plugin is installed.
    @ProtoNumber(3) var isNovel: Boolean = false,
) {
    companion object {
        fun copyFrom(source: Source): BackupSource {
            return BackupSource(
                name = source.name,
                sourceId = source.id,
                isNovel = source is TextSource || source.isNovelSource(),
            )
        }
    }
}
