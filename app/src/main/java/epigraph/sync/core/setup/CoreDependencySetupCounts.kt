package epigraph.sync.core.setup

import epigraph.sync.core.extensions.ComicRepositoryRow
import epigraph.sync.core.extensions.ExtensionParityReport
import epigraph.sync.core.extensions.ExtensionParityStatus
import epigraph.sync.core.novels.LnReaderDependencyInventory
import epigraph.sync.core.novels.LnReaderPluginParityStatus
import epigraph.sync.core.novels.LnReaderRepositoryParityStatus

data class CoreDependencySetupCounts(val repositoriesToAdd: Int, val extensionsToInstall: Int) {
    val hasPending: Boolean get() = repositoriesToAdd > 0 || extensionsToInstall > 0
}

fun coreDependencySetupCounts(
    comicRepositories: List<ComicRepositoryRow>,
    comicReport: ExtensionParityReport?,
    novels: LnReaderDependencyInventory?,
): CoreDependencySetupCounts {
    val repositoriesToAdd = comicRepositories.count { !it.added } +
        (novels?.repositories?.count { it.status == LnReaderRepositoryParityStatus.APPROVAL_REQUIRED } ?: 0)

    val extensionsToInstall = (comicReport?.items?.count {
        it.status == ExtensionParityStatus.MISSING_AVAILABLE ||
            it.status == ExtensionParityStatus.INSTALLED_UPDATE_AVAILABLE ||
            it.status == ExtensionParityStatus.REPOSITORY_APPROVAL_REQUIRED ||
            it.status == ExtensionParityStatus.UNTRUSTED_OR_BLOCKED
    } ?: 0) +
        (novels?.plugins?.count {
            it.status == LnReaderPluginParityStatus.MISSING_AVAILABLE ||
                it.status == LnReaderPluginParityStatus.UPDATE_AVAILABLE ||
                it.status == LnReaderPluginParityStatus.MISSING_UNAVAILABLE
        } ?: 0)

    return CoreDependencySetupCounts(repositoriesToAdd, extensionsToInstall)
}
