package epigraph.sync.core.events

import epigraph.sync.core.credentials.CoreCredentialSession
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.protocol.CoreCapabilities
import epigraph.sync.core.protocol.EpigraphCoreCompatibilityEvaluator
import epigraph.sync.core.suwayomi.SuwayomiProjectionStatusSource
import epigraph.sync.core.work.CoreCatalogStage
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Wakes the sync worker when the desktop Core announces a catalog revision the phone has not
 * applied. Library, category and extension changes made on the desktop change those revisions but
 * send nothing on the event feed, which carries progress; without this check they waited for the
 * periodic worker or the next app start.
 *
 * It asks while the app is visible, right when it becomes visible and then every [intervalMs], and
 * at once on [nudge], which the event feed calls when a Core announces a revision change.
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
    private val nudges = Channel<Unit>(Channel.CONFLATED)

    /** Checks now, also while the app is in the background; the Core announced a new revision. */
    fun nudge() {
        nudges.trySend(Unit)
    }

    suspend fun watch(credentials: CoreCredentialSession, capabilities: CoreCapabilities) {
        if (!EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities)) return
        val scopeId = "comics:profile:${credentials.profileId}"
        // One wake per announced revision: a stage that cannot record what it applied (local
        // work still in flight) must not wake the worker on every check.
        var woken: Pair<String?, String?>? = null
        val checking = Mutex()
        suspend fun check() = checking.withLock {
            val announced = announced(credentials, scopeId) ?: return@withLock
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
        coroutineScope {
            launch { for (nudge in nudges) check() }
            foreground.distinctUntilChanged().collectLatest { visible ->
                if (!visible) return@collectLatest
                while (true) {
                    check()
                    delay(intervalMs)
                }
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
