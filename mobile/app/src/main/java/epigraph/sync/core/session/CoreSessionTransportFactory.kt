package epigraph.sync.core.session

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.assets.CoreAssetHttpClient
import epigraph.sync.core.assets.OkHttpCoreAssetHttpClient
import epigraph.sync.core.events.OkHttpCoreEventStream
import epigraph.sync.core.http.EpigraphCoreHttpClient
import epigraph.sync.core.pairing.transport.EpigraphCoreTlsClientFactory
import epigraph.sync.core.suwayomi.SuwayomiCoreProxyClient
import okhttp3.HttpUrl.Companion.toHttpUrl

data class CoreSessionTransports(
    val http: EpigraphCoreHttpClient,
    val assets: CoreAssetHttpClient,
    val events: OkHttpCoreEventStream,
    val suwayomi: SuwayomiCoreProxyClient,
)

/**
 * Creates every Core transport from the same persisted leaf-DER fingerprint.
 *
 * The access token is deliberately absent from this object; callers borrow it from
 * [CoreCredentialSession] only for an individual request or event-stream lifetime.
 */
class CoreSessionTransportFactory(
    private val tlsClients: EpigraphCoreTlsClientFactory,
    private val clientVersion: String,
) {
    fun create(
        credentials: CoreCredentialSession,
        endpointOrigin: String = credentials.lastKnownEndpoint,
    ): CoreSessionTransports {
        val origin = endpointOrigin.toHttpUrl()
        require(origin.isHttps && origin.encodedPath == "/" && origin.query == null && origin.fragment == null) {
            "Stored Epigraph Core endpoint is not an HTTPS origin"
        }
        val client = tlsClients.create(credentials.tlsCertSha256)
        val http = EpigraphCoreHttpClient(client, origin, clientVersion)
        return CoreSessionTransports(
            http = http,
            assets = OkHttpCoreAssetHttpClient(client, origin),
            events = OkHttpCoreEventStream(client, origin, clientVersion),
            suwayomi = SuwayomiCoreProxyClient(http),
        )
    }
}
