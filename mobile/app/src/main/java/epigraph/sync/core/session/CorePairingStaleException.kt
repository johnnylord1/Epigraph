package epigraph.sync.core.session

/**
 * The paired Core identity rotated: the served certificate no longer matches the pinned
 * fingerprint or the issued token was revoked. Retrying cannot succeed; the device must pair
 * again.
 */
class CorePairingStaleException(message: String) : Exception(message)
