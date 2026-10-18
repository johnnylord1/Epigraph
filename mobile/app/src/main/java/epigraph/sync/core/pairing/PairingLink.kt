package epigraph.sync.core.pairing

import okio.ByteString.Companion.decodeBase64

/**
 * The desktop's pairing QR holds a link so the phone's own camera can open it: the page at
 * [PAGE_URL] hands the bundle from its fragment (never sent to a server) to the app as
 * `epigraph://pair?b=`. Older desktops put the bundle JSON straight into the QR.
 */
object PairingLink {
    const val PAGE_URL = "https://johnnylord1.github.io/Epigraph/pair/"
    const val APP_SCHEME = "epigraph"
    const val APP_HOST = "pair"
    private const val APP_PREFIX = "$APP_SCHEME://$APP_HOST?b="

    /** The bundle JSON inside [scanned], or [scanned] unchanged when it is not a pairing link. */
    fun bundleJson(scanned: String): String {
        val text = scanned.trim()
        val data = when {
            text.startsWith(PAGE_URL) -> text.substring(PAGE_URL.length).removePrefix("index.html")
                .takeIf { it.startsWith("#") }?.substring(1)
            text.startsWith(APP_PREFIX) -> text.substring(APP_PREFIX.length).substringBefore('&')
            else -> null
        } ?: return scanned
        return data.decodeBase64()?.utf8()?.takeIf { it.trimStart().startsWith("{") } ?: scanned
    }
}
