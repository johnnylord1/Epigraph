package yokai.domain.extension.repo.service

import kotlinx.serialization.Serializable
import yokai.domain.extension.repo.model.ExtensionRepo

@Serializable
data class ExtensionRepoMetaDto(
    val meta: ExtensionRepoDto,
)

@Serializable
data class ExtensionRepoDto(
    val name: String,
    // Newer repositories omit shortName from repo.json. Nullable fields without a
    // default are still required by kotlinx.serialization, which made valid repos
    // fail with MissingFieldException before the catalog was ever requested.
    val shortName: String? = null,
    val website: String,
    val signingKeyFingerprint: String,
)

fun ExtensionRepoMetaDto.toExtensionRepo(baseUrl: String): ExtensionRepo {
    return ExtensionRepo(
        baseUrl = baseUrl,
        name = meta.name,
        shortName = meta.shortName,
        website = meta.website,
        signingKeyFingerprint = meta.signingKeyFingerprint,
    )
}
