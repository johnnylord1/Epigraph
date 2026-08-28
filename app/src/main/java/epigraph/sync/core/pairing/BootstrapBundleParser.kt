package epigraph.sync.core.pairing

import java.net.IDN
import java.net.Inet6Address
import java.net.InetAddress
import java.net.URI
import kotlinx.serialization.SerializationException
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

enum class PairingBundleFailure {
    TOO_LARGE,
    MALFORMED_JSON,
    DUPLICATE_FIELD,
    FIELD_SET_MISMATCH,
    EMPTY_FIELD,
    INVALID_SESSION_ID,
    INVALID_PAIRING_CODE,
    INVALID_PROFILE_ID,
    INVALID_EXPIRY,
    INVALID_FINGERPRINT,
    INVALID_ENDPOINT,
    NON_LAN_ENDPOINT,
}

class PairingBundleValidationException(
    val failure: PairingBundleFailure,
) : IllegalArgumentException(failure.name)

data class ValidatedBootstrapBundle(
    val bundle: SyncdBootstrapBundle,
    val endpoint: SyncdEndpoint,
)

class BootstrapBundleParser(
    private val clock: PairingClock = PairingClock.SYSTEM,
) {
    fun parse(raw: String): ValidatedBootstrapBundle {
        if (raw.toByteArray(Charsets.UTF_8).size > MAX_BUNDLE_BYTES) {
            fail(PairingBundleFailure.TOO_LARGE)
        }

        val topLevelKeys = try {
            topLevelObjectKeys(raw)
        } catch (_: IllegalArgumentException) {
            fail(PairingBundleFailure.MALFORMED_JSON)
        }
        if (topLevelKeys.size != topLevelKeys.toSet().size) {
            fail(PairingBundleFailure.DUPLICATE_FIELD)
        }

        val element = try {
            STRICT_JSON.parseToJsonElement(raw)
        } catch (_: SerializationException) {
            fail(PairingBundleFailure.MALFORMED_JSON)
        } catch (_: IllegalArgumentException) {
            fail(PairingBundleFailure.MALFORMED_JSON)
        }
        val jsonObject = element as? JsonObject ?: fail(PairingBundleFailure.MALFORMED_JSON)
        if (jsonObject.keys !in ALLOWED_FIELD_SETS
        ) {
            fail(PairingBundleFailure.FIELD_SET_MISMATCH)
        }

        val bundle = try {
            STRICT_JSON.decodeFromString<SyncdBootstrapBundle>(raw)
        } catch (_: SerializationException) {
            fail(PairingBundleFailure.MALFORMED_JSON)
        }
        validateFields(bundle)
        val normalizedOrigin = normalizeLanHttpsOrigin(bundle.syncdBaseUrl)
        bundle.claimUrl?.let { claimUrl ->
            validateClaimUrl(claimUrl, normalizedOrigin)
        }
        return ValidatedBootstrapBundle(
            bundle = bundle.copy(
                pairingSessionId = bundle.pairingSessionId.trim(),
                pairingCode = bundle.pairingCode.trim(),
                syncdBaseUrl = normalizedOrigin,
                serverId = bundle.serverId.trim(),
                profileId = bundle.profileId.trim(),
                tlsCertSha256 = bundle.tlsCertSha256.trim().lowercase(),
                mdnsServiceName = bundle.mdnsServiceName?.trim(),
                claimUrl = bundle.claimUrl?.trim(),
            ),
            endpoint = SyncdEndpoint(normalizedOrigin),
        )
    }

    private fun validateFields(bundle: SyncdBootstrapBundle) {
        if (
            bundle.pairingSessionId.isBlank() ||
            bundle.pairingCode.isBlank() ||
            bundle.syncdBaseUrl.isBlank() ||
            bundle.profileId.isBlank() ||
            bundle.serverId.isBlank() ||
            bundle.tlsCertSha256.isBlank()
        ) {
            fail(PairingBundleFailure.EMPTY_FIELD)
        }
        if (!SESSION_ID.matches(bundle.pairingSessionId.trim())) {
            fail(PairingBundleFailure.INVALID_SESSION_ID)
        }
        if (!PAIRING_CODE.matches(bundle.pairingCode.trim())) {
            fail(PairingBundleFailure.INVALID_PAIRING_CODE)
        }
        if (!PROFILE_ID.matches(bundle.profileId.trim())) {
            fail(PairingBundleFailure.INVALID_PROFILE_ID)
        }
        if (bundle.serverId != "legacy_unbound" && !SERVER_ID.matches(bundle.serverId.trim())) {
            fail(PairingBundleFailure.INVALID_SESSION_ID)
        }
        if (bundle.expiresAtMs <= clock.nowMs()) {
            fail(PairingBundleFailure.INVALID_EXPIRY)
        }
        if (!SHA_256.matches(bundle.tlsCertSha256.trim())) {
            fail(PairingBundleFailure.INVALID_FINGERPRINT)
        }
    }

    companion object {
        private const val MAX_BUNDLE_BYTES = 16 * 1024
        private val REQUIRED_FIELDS = setOf(
            "pairingSessionId",
            "pairingCode",
            "syncdBaseUrl",
            "profileId",
            "expiresAtMs",
            "tlsCertSha256",
        )
        private val REQUIRED_FIELDS_WITH_CLAIM_URL = REQUIRED_FIELDS + "claimUrl"
        private val V2_FIELDS = REQUIRED_FIELDS_WITH_CLAIM_URL +
            setOf("schemaVersion", "serverId", "mdnsServiceName")
        private val ALLOWED_FIELD_SETS = setOf(
            REQUIRED_FIELDS,
            REQUIRED_FIELDS_WITH_CLAIM_URL,
            V2_FIELDS,
        )
        private val SESSION_ID = Regex("bootstrap-[0-9a-fA-F-]{32,48}")
        private val PAIRING_CODE = Regex("[0-9A-F]{12}")
        private val PROFILE_ID = Regex("[A-Za-z0-9][A-Za-z0-9._-]{0,127}")
        private val SERVER_ID = Regex("[A-Za-z0-9][A-Za-z0-9._:-]{0,255}")
        private val SHA_256 = Regex("[0-9a-fA-F]{64}")
        private val HOST_LABEL = Regex("[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
        private val STRICT_JSON = Json {
            ignoreUnknownKeys = false
            isLenient = false
            coerceInputValues = false
            explicitNulls = true
        }

        fun normalizeLanHttpsOrigin(raw: String): String {
            val trimmed = raw.trim()
            if (trimmed.any { it == '\\' || it.code < 0x20 }) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (!uri.scheme.equals("https", ignoreCase = true)) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (uri.userInfo != null || uri.query != null || uri.fragment != null) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (uri.rawPath != null && uri.rawPath != "" && uri.rawPath != "/") {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (uri.port !in 1..65535) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }

            val rawHost = uri.host?.removePrefix("[")?.removeSuffix("]")
                ?: fail(PairingBundleFailure.INVALID_ENDPOINT)
            if (rawHost.contains('%')) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            val normalizedHost = if (rawHost.contains(':')) {
                normalizePrivateIpv6(rawHost)
            } else {
                normalizeLanHost(rawHost)
            }
            val renderedHost = if (normalizedHost.contains(':')) "[$normalizedHost]" else normalizedHost
            return "https://$renderedHost:${uri.port}"
        }

        private fun normalizeLanHost(rawHost: String): String {
            val asciiHost = try {
                IDN.toASCII(rawHost.removeSuffix("."), IDN.USE_STD3_ASCII_RULES).lowercase()
            } catch (_: IllegalArgumentException) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (asciiHost == "localhost") {
                fail(PairingBundleFailure.NON_LAN_ENDPOINT)
            }
            val octets = asciiHost.split('.').map { it.toIntOrNull() }
            if (octets.size == 4 && octets.all { it != null && it in 0..255 }) {
                val values = octets.map { it!! }
                val private = values[0] == 10 ||
                    (values[0] == 172 && values[1] in 16..31) ||
                    (values[0] == 192 && values[1] == 168) ||
                    (values[0] == 169 && values[1] == 254)
                if (!private) fail(PairingBundleFailure.NON_LAN_ENDPOINT)
                return values.joinToString(".")
            }
            val labels = asciiHost.split('.')
            if (labels.any { !HOST_LABEL.matches(it) }) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            val isLanName = labels.size == 1 ||
                asciiHost.endsWith(".local") ||
                asciiHost.endsWith(".lan") ||
                asciiHost.endsWith(".home.arpa")
            if (!isLanName) fail(PairingBundleFailure.NON_LAN_ENDPOINT)
            return asciiHost
        }

        /**
         * The Core currently includes claimUrl in the bootstrap payload. It is
         * metadata, not an authority: the endpoint must stay on the pinned LAN
         * origin and use the one fixed claim route. We still derive the actual
         * request URL from [SyncdEndpoint] so a malicious claimUrl cannot steer
         * the client to another host or path.
         */
        private fun validateClaimUrl(rawClaimUrl: String, expectedOrigin: String) {
            val trimmed = rawClaimUrl.trim()
            if (trimmed.isEmpty() || trimmed.any { it == '\\' || it.code < 0x20 }) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            val uri = try {
                URI(trimmed)
            } catch (_: Exception) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            if (!uri.scheme.equals("https", ignoreCase = true) ||
                uri.userInfo != null ||
                uri.query != null ||
                uri.fragment != null ||
                uri.rawPath != "/v1/pairing/claim" ||
                uri.port !in 1..65535
            ) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
            val host = uri.host?.removePrefix("[")?.removeSuffix("]")
                ?: fail(PairingBundleFailure.INVALID_ENDPOINT)
            val origin = if (host.contains(':')) {
                "https://[$host]:${uri.port}"
            } else {
                "https://$host:${uri.port}"
            }
            if (normalizeLanHttpsOrigin(origin) != expectedOrigin) {
                fail(PairingBundleFailure.INVALID_ENDPOINT)
            }
        }

        private fun normalizePrivateIpv6(rawHost: String): String {
            val address = try {
                InetAddress.getByName(rawHost) as? Inet6Address
            } catch (_: Exception) {
                null
            } ?: fail(PairingBundleFailure.INVALID_ENDPOINT)
            val first = address.address[0].toInt() and 0xff
            val uniqueLocal = first and 0xfe == 0xfc
            if (address.isLoopbackAddress || address.isAnyLocalAddress ||
                (!uniqueLocal && !address.isLinkLocalAddress && !address.isSiteLocalAddress)
            ) {
                fail(PairingBundleFailure.NON_LAN_ENDPOINT)
            }
            return address.hostAddress?.substringBefore('%')?.lowercase()
                ?: fail(PairingBundleFailure.INVALID_ENDPOINT)
        }

        private fun topLevelObjectKeys(raw: String): List<String> {
            val keys = mutableListOf<String>()
            var depth = 0
            var inString = false
            var escaped = false
            var expectingKey = false
            var stringStart = -1
            var index = 0
            while (index < raw.length) {
                val char = raw[index]
                if (inString) {
                    if (escaped) {
                        escaped = false
                    } else if (char == '\\') {
                        escaped = true
                    } else if (char == '"') {
                        inString = false
                        if (depth == 1 && expectingKey) {
                            var cursor = index + 1
                            while (cursor < raw.length && raw[cursor].isWhitespace()) cursor++
                            if (cursor >= raw.length || raw[cursor] != ':') {
                                throw IllegalArgumentException("invalid object key")
                            }
                            keys += STRICT_JSON.decodeFromString<String>(raw.substring(stringStart, index + 1))
                            expectingKey = false
                        }
                    }
                    index++
                    continue
                }
                when (char) {
                    '"' -> {
                        inString = true
                        stringStart = index
                    }
                    '{' -> {
                        depth++
                        if (depth == 1) expectingKey = true
                    }
                    '[' -> depth++
                    '}', ']' -> depth--
                    ',' -> if (depth == 1) expectingKey = true
                }
                index++
            }
            if (inString || depth != 0) throw IllegalArgumentException("unterminated JSON")
            return keys
        }

        private fun fail(failure: PairingBundleFailure): Nothing =
            throw PairingBundleValidationException(failure)
    }
}
