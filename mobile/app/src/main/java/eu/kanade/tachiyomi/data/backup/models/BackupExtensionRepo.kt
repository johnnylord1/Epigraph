package eu.kanade.tachiyomi.data.backup.models

import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoNumber

/**
 * An extension repository a backup used. The field numbers match Mihon's `BackupExtensionRepos`,
 * so the entries Mihon stores in its field 106 decode with this class too.
 *
 * Restore never trusts [signingKeyFingerprint]: it fetches the repository's own `repo.json`, so a
 * backup file cannot make an extension trusted.
 */
@Serializable
data class BackupExtensionRepo(
    @ProtoNumber(1) val baseUrl: String,
    @ProtoNumber(2) val name: String = "",
    @ProtoNumber(3) val shortName: String? = null,
    @ProtoNumber(4) val website: String = "",
    @ProtoNumber(5) val signingKeyFingerprint: String = "",
)
