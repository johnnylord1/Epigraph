package epigraph.sync.core.novels

import android.content.Context
import epigraph.sync.core.assets.CoreAssetFileMaterializer
import epigraph.sync.core.assets.CoreAssetId
import epigraph.sync.core.assets.CoreAssetSession
import epigraph.sync.core.assets.CoreAssetTransferException
import epigraph.sync.core.assets.CoreAssetFailure
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import hayai.novel.plugin.NovelPluginManager
import hayai.novel.plugin.model.NovelPluginIndex
import java.io.File
import kotlinx.coroutines.CancellationException

fun interface CoreNovelPluginArtifactGateway {
    suspend fun install(
        serverId: String,
        profileId: String,
        requirement: CoreNovelPluginRequirement,
    ): LnReaderPluginInstallResult
}

/**
 * Materializes an immutable LNReader plugin artifact from the paired Core after an explicit user
 * action. The pinned TLS session, scope grant, byte length and SHA-256 are all verified before the
 * existing [NovelPluginManager] performs its QuickJS metadata smoke test and publishes the plugin.
 */
class ManagedCoreNovelPluginArtifactGateway(
    context: Context,
    private val credentials: CoreCredentialStore,
    private val endpoints: CoreEndpointResolver,
    private val transports: CoreSessionTransportFactory,
    private val plugins: NovelPluginManager,
    private val clientVersion: String,
) : CoreNovelPluginArtifactGateway {
    private val cache = File(context.filesDir, "novel_plugins/core_artifacts").also(File::mkdirs)

    override suspend fun install(
        serverId: String,
        profileId: String,
        requirement: CoreNovelPluginRequirement,
    ): LnReaderPluginInstallResult {
        val credential = credentials.load() ?: return LnReaderPluginInstallResult.PluginUnavailable
        return credential.use { session ->
            if (session.serverId != serverId || session.profileId != profileId) {
                return@use LnReaderPluginInstallResult.IdentityMismatch
            }
            val scopeId = "novels:profile:$profileId"
            if (scopeId !in session.scopes) {
                return@use LnReaderPluginInstallResult.IdentityMismatch
            }
            try {
                val endpoint = endpoints.resolve(session)
                val transport = transports.create(session, endpoint.origin)
                val destination = File(cache, "${requirement.artifactSha256}.js")
                val materializer = CoreAssetFileMaterializer(transport.assets, MAX_PLUGIN_BYTES)
                session.withAccessTokenString { token ->
                    materializer.download(
                        assetId = CoreAssetId.parse(requirement.artifactSha256),
                        expectedSize = requirement.artifactByteLength,
                        scopeId = scopeId,
                        session = CoreAssetSession(token, clientVersion, CORE_PROTOCOL_VERSION),
                        destination = destination,
                    )
                }
                val index = NovelPluginIndex(
                    id = requirement.pluginId,
                    name = requirement.name.ifBlank { requirement.pluginId },
                    lang = requirement.lang,
                    version = requirement.version,
                )
                val installed = plugins.installPluginArtifact(
                    plugin = index,
                    bytes = destination.readBytes(),
                    expectedSha256 = requirement.artifactSha256,
                    expectedByteLength = requirement.artifactByteLength,
                )
                if (installed && plugins.installedArtifactMatches(
                        pluginId = requirement.pluginId,
                        expectedVersion = requirement.version,
                        expectedSha256 = requirement.artifactSha256,
                        expectedByteLength = requirement.artifactByteLength,
                    )
                ) {
                    LnReaderPluginInstallResult.Installed
                } else {
                    LnReaderPluginInstallResult.ArtifactRejected
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: CoreAssetTransferException) {
                if (error.failure == CoreAssetFailure.REMOTE_NOT_FOUND) {
                    LnReaderPluginInstallResult.PluginUnavailable
                } else {
                    LnReaderPluginInstallResult.Failed(error.failure.name)
                }
            } catch (error: Exception) {
                LnReaderPluginInstallResult.Failed(error.javaClass.simpleName)
            }
        }
    }

    private companion object {
        const val MAX_PLUGIN_BYTES = 2L * 1024L * 1024L
        const val CORE_PROTOCOL_VERSION = 1
    }
}
