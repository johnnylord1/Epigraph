package epigraph.sync.core.events

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.suwayomi.SuwayomiProjectionStatusSource
import epigraph.sync.core.work.CoreCatalogStage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged

/**
 * Wakes the sync worker when the desktop Core announces a catalog revision the phone has not
 * applied. Library, category and extension changes made on the desktop change those revisions but
 * send nothing on the event feed, which carries progress; without this check they waited for the
 * periodic worker or the next app start.
 *
 * It asks only while the app is visible, right when it becomes visible and then every [intervalMs].
 * `/v1/sync/status` is a cached read on the Core, and the worker itself skips the stages whose
 * revision did not change.
 */
class CoreCatalogRevisionWatcher(
    private val foreground: Flow<Boolean>,
    private val status: SuwayomiProjectionStatusSource,
    /** The revision the stage last applied for this pairing, or null when none is recorded. */
    private val applied: (CoreCredentialSession, CoreCatalogStage) -> String?,
    private val wake: () -> Unit,
    private val intervalMs: Long = DEFAULT_INTERVAL_MS,
) {
    suspend fun watch(credentials: CoreCredentialSession, capabilities: CoreCapabilities) {
        if (!EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) return
        val scopeId = "comics:profile:${credentials.profileId}"
        // One wake per announced revision: a stage that cannot record what it applied (local
        // work still in flight) must not wake the worker on every check.
        var woken: Pair<String?, String?>? = null
        foreground.distinctUntilChanged().collectLatest { visible ->
            if (!visible) return@collectLatest
            while (true) {
                val announced = announced(credentials, scopeId)
                if (announced != null) {
                    val (library, extensions) = announced
                    val behind = (library != null && applied(credentials, CoreCatalogStage.CATALOG) != library) ||
                        (extensions != null && applied(credentials, CoreCatalogStage.EXTENSIONS) != extensions)
                    if (!behind) {
                        woken = null
                    } else if (announced != woken) {
                        woken = announced
                        wake()
                    }
                }
                delay(intervalMs)
            }
        }
    }

    /** Null while the Core is unreachable or announces no revision (it is projecting a change). */
    private suspend fun announced(credentials: CoreCredentialSession, scopeId: String): Pair<String?, String?>? {
        val result = try {
            status.status(credentials, scopeId)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Throwable) {
            return null
        }
        val value = (result as? CoreHttpResult.Success)?.value ?: return null
        if (value.comicLibraryRevision == null && value.comicExtensionsRevision == null) return null
        return value.comicLibraryRevision to value.comicExtensionsRevision
    }

    companion object {
        const val DEFAULT_INTERVAL_MS = 20_000L
    }
}
