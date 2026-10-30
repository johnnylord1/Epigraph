package epigraph.sync

import epigraph.contract.SyncScopeId
import java.net.URLDecoder

/**
 * Resolves the profile scope embedded in a catalog-backed comic identity.
 *
 * Catalog rows are owned by a specific Suwayomi profile. Keeping the profile in the local
 * identity lets writes avoid falling back to the historical `main` scope after a non-default
 * profile was paired. Legacy/local identities still use the caller-provided fallback until they
 * receive a real Suwayomi binding.
 */
internal fun suwayomiComicScopeForEntity(
    entityId: String,
    fallback: SyncScopeId,
): SyncScopeId {
    val profileId = suwayomiProfileIdForEntity(entityId) ?: return fallback
    if (suwayomiMangaIdForEntity(entityId) == null) return fallback
    return SyncScopeId("comics:profile:$profileId")
}

internal fun suwayomiMangaIdForEntity(entityId: String): Long? =
    suwayomiNumericIdForEntity(entityId, ":manga:")

internal fun suwayomiChapterIdForEntity(entityId: String): Long? =
    suwayomiNumericIdForEntity(entityId, ":chapter:")

internal fun suwayomiCategoryIdForEntity(entityId: String): Long? =
    suwayomiNumericIdForEntity(entityId, ":category:")

internal fun suwayomiProfileIdForEntity(entityId: String): String? {
    val profileAndRemote = when {
        entityId.startsWith(LEGACY_PROFILE_PREFIX) -> entityId.removePrefix(LEGACY_PROFILE_PREFIX)
        entityId.startsWith(SERVER_PREFIX) -> {
            val serverAndProfile = entityId.removePrefix(SERVER_PREFIX)
            val profileMarker = serverAndProfile.indexOf(PROFILE_MARKER)
            if (profileMarker <= 0) return null
            val serverId = serverAndProfile.substring(0, profileMarker)
            if (!serverId.isCanonicalIdentitySegment()) return null
            serverAndProfile.substring(profileMarker + PROFILE_MARKER.length)
        }
        else -> return null
    }
    val remoteMarker = REMOTE_MARKERS
        .map { marker -> profileAndRemote.lastIndexOf(marker) }
        .filter { it > 0 }
        .maxOrNull()
        ?: return null
    return profileAndRemote.substring(0, remoteMarker).takeIf { it.isCanonicalIdentitySegment() }
}

/**
 * True when [entityId] names a Suwayomi server other than [currentServerId]. A desktop gets a new
 * server id when it is reinstalled, and local identities keep the old one until the catalog sync
 * rebinds them by name; the Core refuses such ids, so they are never published. Unknown servers
 * (null) and legacy ids without a server match.
 */
internal fun isOtherSuwayomiServer(entityId: String, currentServerId: String?): Boolean {
    if (currentServerId == null || !entityId.startsWith(SERVER_PREFIX)) return false
    val profileMarker = entityId.indexOf(PROFILE_MARKER, SERVER_PREFIX.length)
    if (profileMarker <= SERVER_PREFIX.length) return false
    return entityId.substring(SERVER_PREFIX.length, profileMarker) != currentServerId
}

/**
 * Scoped Suwayomi manga id of a Core-served manga row, read from its
 * `aethon-core://suwayomi/<server>/<profile>/manga/<id>` url (or the legacy form without a server).
 * Null for any other url.
 */
internal fun suwayomiMangaEntityIdForCoreUrl(url: String): String? {
    if (!url.startsWith(CORE_URL_PREFIX) || url.any { it == '?' || it == '#' }) return null
    val segments = url.removePrefix(CORE_URL_PREFIX).split('/')
    if (segments.size !in 3..4 || segments[segments.size - 2] != "manga") return null
    val mangaId = segments.last().toLongOrNull()?.takeIf { it > 0 } ?: return null
    val scope = segments.dropLast(2).map { segment ->
        runCatching { URLDecoder.decode(segment, Charsets.UTF_8.name()) }.getOrNull()
            ?.takeIf { it.isCanonicalIdentitySegment() && ':' !in it }
            ?: return null
    }
    return if (scope.size == 2) {
        "$SERVER_PREFIX${scope[0]}$PROFILE_MARKER${scope[1]}:manga:$mangaId"
    } else {
        "$LEGACY_PROFILE_PREFIX${scope[0]}:manga:$mangaId"
    }
}

private fun suwayomiNumericIdForEntity(entityId: String, marker: String): Long? {
    val markerIndex = entityId.lastIndexOf(marker)
    if (markerIndex < 0) return null
    return entityId.substring(markerIndex + marker.length).toLongOrNull()?.takeIf { it > 0 }
}

private fun String.isCanonicalIdentitySegment(): Boolean =
    isNotBlank() && none(Char::isISOControl)

private const val LEGACY_PROFILE_PREFIX = "suwayomi:profile:"
private const val SERVER_PREFIX = "suwayomi:server:"
private const val PROFILE_MARKER = ":profile:"
private const val CORE_URL_PREFIX = "aethon-core://suwayomi/"
private val REMOTE_MARKERS = listOf(":manga:", ":chapter:", ":category:")
