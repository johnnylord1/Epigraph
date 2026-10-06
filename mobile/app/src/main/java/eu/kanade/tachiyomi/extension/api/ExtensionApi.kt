package eu.kanade.tachiyomi.extension.api

import yokai.util.koin.get
import android.content.Context
import co.touchlab.kermit.Logger
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.extension.model.LoadResult
import eu.kanade.tachiyomi.extension.util.ExtensionLoader
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.network.awaitSuccess
import eu.kanade.tachiyomi.util.system.withIOContext
import exh.source.BlacklistedSources
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import yokai.util.koin.injectLazy
import yokai.domain.extension.repo.interactor.GetExtensionRepo
import yokai.domain.extension.repo.interactor.UpdateExtensionRepo
import yokai.domain.extension.repo.model.ExtensionRepo

internal class ExtensionApi {

    private val networkService: NetworkHelper by injectLazy()
    private val getExtensionRepo: GetExtensionRepo by injectLazy()
    private val updateExtensionRepo: UpdateExtensionRepo by injectLazy()
    private val json: Json by injectLazy()

    suspend fun findExtensions(): List<Extension.Available> {
        return findExtensionsWithStatus().extensions
    }

    suspend fun findExtensionsWithStatus(): ExtensionDiscoveryResult {
        return withIOContext {
            val repositories = getExtensionRepo.getAll()
            if (repositories.isEmpty()) {
                return@withIOContext ExtensionDiscoveryResult(emptyList(), catalogReachable = true)
            }
            val results = repositories
                .map { async { getExtensions(it) } }
                .awaitAll()
            ExtensionDiscoveryResult(
                // A mirror may serve a package its upstream also has: keep the newest build,
                // like the desktop does, so both install the same source ids.
                extensions = results.mapNotNull { it.getOrNull() }.flatten()
                    .groupBy { it.pkgName }
                    .map { (_, builds) -> builds.maxWith(compareBy({ it.libVersion }, { it.versionCode })) },
                catalogReachable = results.any { it.isSuccess },
            )
        }
    }

    private suspend fun getExtensions(
        repo: ExtensionRepo,
    ): Result<List<Extension.Available>> {
        val repoBaseUrl = repo.baseUrl
        return try {
            // Older repositories expose a compact array at index.min.json. Keiyoushi and
            // newer Mihon-compatible repositories keep that endpoint only as a tiny migration
            // catalog and publish the real catalog in the v2-shaped index.json. Try the legacy
            // endpoint first for custom repositories, then fall back to the modern schema.
            val legacy = try {
                fetchBody("$repoBaseUrl/index.min.json")
                    .let { json.decodeFromString<List<ExtensionJsonObject>>(it) }
            } catch (_: Throwable) {
                null
            }

            if (legacy != null && legacy.size >= MIN_FULL_CATALOG_SIZE) {
                return Result.success(legacy.toExtensions(repoBaseUrl))
            }

            val modernBody = try {
                fetchBody("$repoBaseUrl/index.json")
            } catch (_: Throwable) {
                null
            }
            val modern = modernBody?.let { body ->
                runCatching {
                    json.decodeFromString<ExtensionIndexJson>(body)
                        .toExtensions(repoBaseUrl)
                }.getOrNull()
                    ?: runCatching {
                        json.decodeFromString<List<ExtensionJsonObject>>(body)
                            .toExtensions(repoBaseUrl)
                    }.getOrNull()
            }

            Result.success(
                when {
                    !modern.isNullOrEmpty() -> modern
                    !legacy.isNullOrEmpty() -> legacy.toExtensions(repoBaseUrl)
                    else -> error("The extension repository returned no compatible catalog")
                },
            )
        } catch (error: Throwable) {
            Logger.e(error) { "Failed to get extensions from $repoBaseUrl" }
            Result.failure(error)
        }
    }

    private suspend fun fetchBody(url: String): String {
        return networkService.client
            .newCall(GET(url))
            .awaitSuccess()
            .use { response -> response.body.string() }
    }

    suspend fun checkForUpdates(context: Context, prefetchedExtensions: List<Extension.Available>? = null): List<Extension.Available> {
        return withIOContext {
            val extensions = prefetchedExtensions ?: findExtensions()

            // Update extension repo details
            updateExtensionRepo.awaitAll()

            val extensionManager: ExtensionManager = get()
            val installedExtensions = extensionManager.installedExtensionsFlow.value.ifEmpty {
                ExtensionLoader.loadExtensionAsync(context)
                    .filterIsInstance<LoadResult.Success>()
                    .map { it.extension }
            }

            val extensionsWithUpdate = mutableListOf<Extension.Available>()
            for (installedExt in installedExtensions) {
                val pkgName = installedExt.pkgName
                val availableExt = extensions.find { it.pkgName == pkgName } ?: continue
                val hasUpdatedVer = availableExt.versionCode > installedExt.versionCode
                val hasUpdatedLib = availableExt.libVersion > installedExt.libVersion
                val hasUpdate = hasUpdatedVer || hasUpdatedLib
                if (hasUpdate) {
                    extensionsWithUpdate.add(availableExt)
                }
            }

            extensionsWithUpdate
        }
    }

    private fun List<ExtensionJsonObject>.toExtensions(repoUrl: String): List<Extension.Available> {
        return this
            .filter {
                val libVersion = it.extractLibVersion()
                libVersion in ExtensionLoader.SUPPORTED_LIB_VERSIONS
            }
            // Drop EXH-blacklisted extensions (e.g. eHentai) at the API layer so they never
            // appear as installable in Browse, never count toward update badges, and never
            // get installed only to be no-op'd inside SourceManager.toInternalSource().
            .filterNot { it.pkg in BlacklistedSources.BLACKLISTED_EXTENSIONS }
            .map {
                Extension.Available(
                    name = it.name.substringAfter("Tachiyomi: "),
                    pkgName = it.pkg,
                    versionName = it.version,
                    versionCode = it.code,
                    libVersion = it.extractLibVersion(),
                    lang = it.lang,
                    isNsfw = it.nsfw == 1,
                    sources = it.sources ?: emptyList(),
                    apkName = it.apk,
                    iconUrl = "$repoUrl/icon/${it.pkg}.png",
                    repoUrl = repoUrl,
                    isNovel = it.isNovel,
                )
            }
    }

    fun getApkUrl(extension: ExtensionManager.ExtensionInfo): String {
        return if (extension.apkName.startsWith("https://") || extension.apkName.startsWith("http://")) {
            extension.apkName
        } else {
            "${extension.repoUrl}/apk/${extension.apkName}"
        }
    }

    private fun ExtensionJsonObject.extractLibVersion(): Double {
        return version.substringBeforeLast('.').toDouble()
    }
}

internal data class ExtensionDiscoveryResult(
    val extensions: List<Extension.Available>,
    val catalogReachable: Boolean,
)

@Serializable
private data class ExtensionJsonObject(
    val name: String,
    val pkg: String,
    val apk: String,
    val lang: String,
    val code: Long,
    val version: String,
    val nsfw: Int,
    val hasReadme: Int = 0,
    val hasChangelog: Int = 0,
    val sources: List<Extension.AvailableSource>?,
    val isNovel: Boolean = false,
)

@Serializable
internal data class ExtensionIndexJson(
    val extensionList: ExtensionListJson? = null,
)

@Serializable
internal data class ExtensionListJson(
    val extensions: List<ModernExtensionJsonObject> = emptyList(),
)

@Serializable
internal data class ModernExtensionJsonObject(
    val name: String,
    val packageName: String,
    val resources: ModernExtensionResources,
    val extensionLib: String,
    val versionCode: JsonElement,
    val versionName: String,
    val contentWarning: String? = null,
    val sources: List<ModernExtensionSource> = emptyList(),
)

@Serializable
internal data class ModernExtensionResources(
    val apkUrl: String = "",
    val iconUrl: String = "",
)

@Serializable
internal data class ModernExtensionSource(
    val id: JsonElement,
    val name: String,
    val language: String,
    val homeUrl: String,
)

internal fun ExtensionIndexJson.toExtensions(repoUrl: String): List<Extension.Available> {
    return extensionList?.extensions.orEmpty().mapNotNull { extension ->
        val libVersion = extension.extensionLib.toDoubleOrNull() ?: return@mapNotNull null
        val versionCode = extension.versionCode.decimalLongOrNull() ?: return@mapNotNull null
        if (libVersion !in ExtensionLoader.SUPPORTED_LIB_VERSIONS) {
            return@mapNotNull null
        }
        if (extension.packageName in BlacklistedSources.BLACKLISTED_EXTENSIONS) {
            return@mapNotNull null
        }
        if (extension.resources.apkUrl.isBlank() || extension.resources.iconUrl.isBlank()) {
            return@mapNotNull null
        }

        val sources = extension.sources.mapNotNull { source ->
            val sourceId = source.id.decimalLongOrNull() ?: return@mapNotNull null
            Extension.AvailableSource(
                name = source.name,
                id = sourceId,
                lang = source.language,
                baseUrl = source.homeUrl,
            )
        }
        Extension.Available(
            name = extension.name.substringAfter("Tachiyomi: "),
            pkgName = extension.packageName,
            versionName = extension.versionName,
            versionCode = versionCode,
            libVersion = libVersion,
            lang = sources.firstOrNull()?.lang ?: "other",
            isNsfw = extension.contentWarning == "CONTENT_WARNING_NSFW",
            sources = sources,
            apkName = extension.resources.apkUrl,
            iconUrl = extension.resources.iconUrl,
            repoUrl = repoUrl,
        )
    }
}

private fun JsonElement.decimalLongOrNull(): Long? {
    val primitive = this as? JsonPrimitive ?: return null
    return primitive.content
        .takeIf { it.isNotBlank() && it == it.trim() }
        ?.toLongOrNull()
}

private const val MIN_FULL_CATALOG_SIZE = 10
