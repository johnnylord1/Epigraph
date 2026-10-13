package eu.kanade.tachiyomi.data.backup.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoNumber

/** A novel plugin repository index to add during a restore, from an Epigraph or LNReader backup. */
@Serializable
data class BackupNovelRepository(
    @ProtoNumber(1) val url: String,
    @ProtoNumber(2) val name: String = "",
)
