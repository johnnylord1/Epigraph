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
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.flowOf
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
    private val registryLoaded: Flow<Boolean> = flowOf(true),
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
        registryLoaded = extensions.isInitialized,
    )

    @OptIn(FlowPreview::class)
    fun start(scope: CoroutineScope): Job {
        var startupRegistry = true
        return combine(
            installedExtensions,
            catalogueSources,
            registryLoaded,
        ) { installed, registered, loaded ->
            if (!loaded) return@combine null
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
            .filterNotNull()
            .distinctUntilChanged()
            // "Install all" lands a dozen extensions within seconds; each one relinked the library and
            // woke a full Core sync, saturating the device until the batch was done. Settle first.
            .debounce(SETTLE_MS)
            .onEach {
                // The registry loaded at process start is read by the sync that start already runs, so
                // waking another full sync for it is needed only when the relink changed a binding.
                val startup = startupRegistry
                startupRegistry = false
                try {
                    val result = withContext(dispatcher) {
                        relink()
                    }
                    if (!startup || result.moved > 0) wakePortableSync()
                } catch (cancelled: CancellationException) {
                    throw cancelled
                } catch (_: Throwable) {
                    Logger.w { "Cached Core source relink deferred" }
                }
            }
            .launchIn(scope)
    }

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
