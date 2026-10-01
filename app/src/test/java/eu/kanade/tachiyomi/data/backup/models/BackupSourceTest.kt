package eu.kanade.tachiyomi.data.backup.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoBuf
import kotlinx.serialization.protobuf.ProtoNumber
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test

class BackupSourceTest {

    // The shape BackupSource had before it recorded whether a source serves novels.
    @Serializable
    private data class LegacyBackupSource(
        @ProtoNumber(1) val name: String = "",
        @ProtoNumber(2) val sourceId: Long,
    )

    @Test
    fun `novel flag round trips through the backup envelope`() {
        val source = Backup(
            backupManga = emptyList(),
            backupSources = listOf(
                BackupSource(name = "Royal Road", sourceId = 7L, isNovel = true),
                BackupSource(name = "MangaDex", sourceId = 8L),
            ),
        )

        val restored = ProtoBuf.decodeFromByteArray(
            Backup.serializer(),
            ProtoBuf.encodeToByteArray(Backup.serializer(), source),
        )

        assertEquals(source.backupSources, restored.backupSources)
    }

    @Test
    fun `sources from older backups read as comic sources`() {
        val bytes = ProtoBuf.encodeToByteArray(
            LegacyBackupSource.serializer(),
            LegacyBackupSource(name = "MangaDex", sourceId = 8L),
        )

        val restored = ProtoBuf.decodeFromByteArray(BackupSource.serializer(), bytes)

        assertEquals(8L, restored.sourceId)
        assertFalse(restored.isNovel)
    }

    @Test
    fun `older readers ignore the novel flag`() {
        val bytes = ProtoBuf.encodeToByteArray(
            BackupSource.serializer(),
            BackupSource(name = "Royal Road", sourceId = 7L, isNovel = true),
        )

        val legacy = ProtoBuf.decodeFromByteArray(LegacyBackupSource.serializer(), bytes)

        assertEquals(LegacyBackupSource(name = "Royal Road", sourceId = 7L), legacy)
    }
}
