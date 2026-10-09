package eu.kanade.tachiyomi.data.backup.models

/** A novel plugin repository index to add during a restore, such as one an LNReader backup used. */
data class BackupNovelRepository(val url: String, val name: String)
