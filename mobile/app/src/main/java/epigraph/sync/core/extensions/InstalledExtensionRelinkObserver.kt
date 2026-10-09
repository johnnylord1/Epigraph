package epigraph.sync.core.extensions

import co.touchlab.kermit.Logger
import epigraph.sync.core.events.CoreBackgroundSyncReason
import epigraph.sync.core.events.CoreBackgroundSyncScheduler
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.source.CatalogueSource
import eu.kanade.tachiyomi.source.SourceManager
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.withContext

/** Retries cached Core bindings whenever the official extension registry changes. */
class InstalledExtensionRelinkObserver internal constructor(
    private val installedExtensions: Flow<List<Extension.Installed>>,
    private val catalogueSources: Flow<List<CatalogueSource>>,
    private val relink: suspend () -> CoreSourceRelinkResult,
    private val dispatcher: CoroutineDispatcher,
    private val wakePortableSync: () -> Unit = {},
) {
    constructor(
        extensions: ExtensionManager,
        sources: SourceManager,
        reconciliation: ExtensionReconciliationCoordinator,
        scheduler: CoreBackgroundSyncScheduler,
    ) : this(
        installedExtensions = extensions.installedExtensionsFlow,
        catalogueSources = sources.catalogueSources,
        relink = reconciliation::relinkFromCachedInventories,
        dispatcher = Dispatchers.IO,
        wakePortableSync = { scheduler.enqueue(CoreBackgroundSyncReason.OUTBOX_PENDING) },
    )

    @OptIn(FlowPreview::class)
    fun start(scope: CoroutineScope): Job = combine(
        installedExtensions,
        catalogueSources,
    ) { installed, registered ->
        InstalledRegistryIdentity(
            extensions = installed.map { extension ->
                InstalledExtensionIdentity(
                    packageName = extension.pkgName,
                    versionCode = extension.versionCode,
                    sourceIds = extension.sources.map { it.id }.sorted(),
                )
            }.sortedBy { it.packageName },
            registeredSourceIds = registered.map { it.id }.sorted(),
        )
    }
        .distinctUntilChanged()
        // "Install all" lands a dozen extensions within seconds; each one relinked the library and
        // woke a full Core sync, saturating the device until the batch was done. Settle first.
        .debounce(SETTLE_MS)
        .onEach {
            try {
                withContext(dispatcher) {
                    relink()
                }
                wakePortableSync()
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                Logger.w { "Cached Core source relink deferred" }
            }
        }
        .launchIn(scope)

    private companion object {
        const val SETTLE_MS = 1_500L
    }
}

private data class InstalledExtensionIdentity(
    val packageName: String,
    val versionCode: Long,
    val sourceIds: List<Long>,
)

private data class InstalledRegistryIdentity(
    val extensions: List<InstalledExtensionIdentity>,
    val registeredSourceIds: List<Long>,
)
