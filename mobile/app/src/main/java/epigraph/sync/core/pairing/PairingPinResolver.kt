package epigraph.sync.core.pairing

import java.net.URI
import kotlinx.serialization.json.Json

/**
 * A desktop Core announced on the LAN (`_epigraph-sync._tcp.` / legacy `_aethon-sync._tcp.`).
 *
 * [tlsCertSha256] comes from the `tls_sha256` TXT record and is the pin for every request made
 * before a bootstrap bundle exists. [origins] are normalized LAN HTTPS origins in preference order.
 */
data class DiscoveredCoreHost(
    val instanceName: String,
    val serverId: String,
    val tlsCertSha256: String,
    val origins: List<String>,
) {
    /** Four digits the desktop shows next to its PIN; lets the user pick the right computer. */
    val verificationCode: String get() = pairingVerificationCode(tlsCertSha256)

    companion object {
        private val SHA_256 = Regex("[0-9a-fA-F]{64}")
        private val SERVER_ID = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,255}")

        /**
         * Builds a host from one resolved DNS-SD record. Returns null when the TXT data cannot pin a
         * connection (missing server id or fingerprint) or no LAN origin is usable.
         */
        fun fromResolvedService(
            instanceName: String,
            txt: Map<String, ByteArray?>,
            resolvedHost: String?,
            port: Int,
        ): DiscoveredCoreHost? {
            val serverId = txt["sid"]?.toString(Charsets.UTF_8)?.trim()
                ?.takeIf(SERVER_ID::matches) ?: return null
            val fingerprint = txt["tls_sha256"]?.toString(Charsets.UTF_8)?.trim()
                ?.takeIf(SHA_256::matches)?.lowercase() ?: return null
            val resolvedOrigin = resolvedHost
                ?.substringBefore('%')
                ?.takeIf { it.isNotBlank() && port in 1..65535 }
                ?.let { host -> if (host.contains(':')) "[$host]" else host }
                ?.let { host -> normalizedOrNull("https://$host:$port") }
            val advertisedOrigin = txt["origin"]?.toString(Charsets.UTF_8)?.let(::normalizedOrNull)
            val origins = listOfNotNull(resolvedOrigin, advertisedOrigin).distinct()
            if (origins.isEmpty()) return null
            return DiscoveredCoreHost(
                instanceName = instanceName.trim().take(MAX_INSTANCE_NAME_CHARS),
                serverId = serverId,
                tlsCertSha256 = fingerprint,
                origins = origins,
            )
        }

        /**
         * The desktop registers the same server under the current and the legacy service type; one
         * server id with one fingerprint is one host. A conflicting fingerprint is kept separate so
         * the user sees both and the verification code tells them apart.
         */
        fun merge(hosts: List<DiscoveredCoreHost>): List<DiscoveredCoreHost> =
            hosts.groupBy { it.serverId to it.tlsCertSha256 }
                .values
                .map { group ->
                    group.first().copy(origins = group.flatMap { it.origins }.distinct())
                }
                .sortedBy { it.instanceName.lowercase() }

        /**
         * Builds a host from the public discovery descriptor served at an address the user typed.
         * [presentedTlsCertSha256] is the leaf the probe connection actually saw; the descriptor
         * must name that same certificate, so the PIN request is pinned to the answering server.
         */
        fun fromDescriptor(
            origin: String,
            serverId: String,
            descriptorTlsCertSha256: String,
            presentedTlsCertSha256: String,
            advertisedOrigin: String?,
        ): DiscoveredCoreHost? {
            val normalizedOrigin = normalizedOrNull(origin) ?: return null
            val id = serverId.trim().takeIf(SERVER_ID::matches) ?: return null
            val fingerprint = presentedTlsCertSha256.trim().takeIf(SHA_256::matches)?.lowercase()
                ?: return null
            if (!descriptorTlsCertSha256.trim().equals(fingerprint, ignoreCase = true)) return null
            return DiscoveredCoreHost(
                instanceName = normalizedOrigin.removePrefix("https://"),
                serverId = id,
                tlsCertSha256 = fingerprint,
                origins = listOfNotNull(normalizedOrigin, advertisedOrigin?.let(::normalizedOrNull))
                    .distinct(),
            )
        }

        private fun normalizedOrNull(raw: String): String? = try {
            BootstrapBundleParser.normalizeLanHttpsOrigin(raw)
        } catch (_: PairingBundleValidationException) {
            null
        }

        private const val MAX_INSTANCE_NAME_CHARS = 128
    }
}

/** Browses the LAN for desktop Cores that can be paired by PIN. */
fun interface CoreHostDiscovery {
    suspend fun discover(): List<DiscoveredCoreHost>
}

/**
 * Reaches a desktop Core at an address the user typed, for networks where DNS-SD does not cross
 * (a phone and a computer behind different routers). Returns null when nothing usable answers.
 */
fun interface CoreHostProbe {
    suspend fun probe(origin: String): DiscoveredCoreHost?
}

/** Turns "192.168.1.10" or "192.168.1.10:4787" into the LAN HTTPS origin of a desktop Core. */
object CoreHostAddress {
    /** Port of the installed desktop Core; development builds use another one, typed explicitly. */
    const val DEFAULT_PORT = 4777

    fun toOrigin(raw: String): String? {
        val trimmed = raw.trim().removeSuffix("/")
        if (trimmed.isEmpty() || trimmed.any(Char::isWhitespace)) return null
        val withScheme = if (trimmed.contains("://")) trimmed else "https://$trimmed"
        val uri = runCatching { URI(withScheme) }.getOrNull() ?: return null
        if (uri.host == null) return null
        val withPort = if (uri.port == -1) {
            "${uri.scheme}://${uri.rawAuthority}:$DEFAULT_PORT"
        } else {
            withScheme
        }
        return try {
            BootstrapBundleParser.normalizeLanHttpsOrigin(withPort)
        } catch (_: PairingBundleValidationException) {
            null
        }
    }
}

/**
 * Turns the PIN typed on the phone into the same bootstrap bundle the desktop QR carries.
 *
 * Mirrors the desktop `syncd_resolve_pairing_pin`: the request is pinned to the advertised
 * fingerprint, each advertised origin is tried in order on network failures only, and the returned
 * payload must name that same certificate. The bundle then goes through the regular
 * [BootstrapBundleParser] and claim flow, so the desktop still has to approve the device.
 */
class PairingPinResolver(
    private val transport: PairingPinTransport,
) {
    suspend fun resolve(host: DiscoveredCoreHost, rawPin: String): String {
        val pin = PairingPin.normalize(rawPin) ?: throw pinFailure(PairingErrorCode.PIN_INVALID)
        var lastNetworkFailure: PairingTransportException? = null
        for (origin in host.origins) {
            val payload = try {
                transport.resolvePin(SyncdEndpoint(origin), host.tlsCertSha256, pin)
            } catch (failure: PairingTransportException) {
                if (failure.error.code == PairingErrorCode.NETWORK) {
                    lastNetworkFailure = failure
                    continue
                }
                throw failure
            }
            if (!payload.tlsCertSha256.trim().equals(host.tlsCertSha256, ignoreCase = true)) {
                throw pinFailure(PairingErrorCode.TLS_MISMATCH)
            }
            if (payload.serverId.trim() != host.serverId) {
                throw pinFailure(PairingErrorCode.INVALID_RESPONSE)
            }
            return BUNDLE_JSON.encodeToString(SyncdBootstrapBundle.serializer(), payload.toBundle())
        }
        throw lastNetworkFailure ?: pinFailure(PairingErrorCode.HOST_NOT_FOUND)
    }

    private fun pinFailure(code: PairingErrorCode) = PairingTransportException(PairingError(code))

    private companion object {
        // Every key is emitted so the bundle matches the parser's strict v2 (+deviceName) field set.
        val BUNDLE_JSON = Json {
            encodeDefaults = true
            explicitNulls = true
        }
    }
}

internal fun BootstrapPayloadResponse.toBundle() = SyncdBootstrapBundle(
    schemaVersion = schemaVersion,
    serverId = serverId,
    pairingSessionId = pairingSessionId,
    pairingCode = pairingCode,
    syncdBaseUrl = syncdBaseUrl,
    profileId = profileId,
    expiresAtMs = expiresAtMs,
    tlsCertSha256 = tlsCertSha256,
    mdnsServiceName = mdnsServiceName,
    claimUrl = claimUrl,
    deviceName = deviceName,
)
