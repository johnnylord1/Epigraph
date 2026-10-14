package eu.kanade.tachiyomi.extension

import yokai.util.koin.get
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import co.touchlab.kermit.Logger
import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.plugin.model.NovelPluginIndex
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.library.LibraryUpdateJob
import eu.kanade.tachiyomi.data.notification.NotificationReceiver
import eu.kanade.tachiyomi.data.notification.Notifications
import eu.kanade.tachiyomi.data.preference.PreferencesHelper
import eu.kanade.tachiyomi.data.updater.AppDownloadInstallJob
import eu.kanade.tachiyomi.extension.api.ExtensionApi
import eu.kanade.tachiyomi.extension.model.Extension
import eu.kanade.tachiyomi.extension.util.ExtensionLoader
import eu.kanade.tachiyomi.util.system.connectivityManager
import eu.kanade.tachiyomi.util.system.jobIsRunning
import eu.kanade.tachiyomi.util.system.localeContext
import eu.kanade.tachiyomi.util.system.notification
import eu.kanade.tachiyomi.util.system.toInt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import rikka.shizuku.Shizuku
import yokai.util.koin.injectLazy
import yokai.domain.base.BasePreferences
import yokai.domain.base.BasePreferences.ExtensionInstaller
import yokai.i18n.MR
import yokai.util.lang.getString
import java.util.concurrent.*

class ExtensionUpdateJob(private val context: Context, workerParams: WorkerParameters) :
    CoroutineWorker(context, workerParams) {

    override suspend fun doWork(): Result = coroutineScope {
        val pendingUpdates = try {
            ExtensionApi().checkForUpdates(context)
        } catch (e: Exception) {
            return@coroutineScope Result.failure()
        }

        val novelUpdates = findNovelPluginUpdates()

        if (pendingUpdates.isEmpty()) {
            val preferences: PreferencesHelper by injectLazy()
            preferences.extensionUpdatesCount().set(0)
        }
        if (pendingUpdates.isNotEmpty() || novelUpdates.isNotEmpty()) {
            createUpdateNotification(pendingUpdates, novelUpdates)
        }

        Result.success()
    }

    /** Installed novel plugins whose repository lists a newer version. */
    private suspend fun findNovelPluginUpdates(): List<NovelPluginIndex> {
        return try {
            val manager = get<NovelPluginManager>()
            manager.ensureInstalledPluginsLoaded()
            if (manager.installedPluginsFlow.value.isEmpty()) return emptyList()
            manager.refreshAvailablePlugins()
            manager.availablePluginsFlow.value.filter { plugin ->
                val installed = manager.getInstalledVersion(plugin.id) ?: return@filter false
                NovelPluginManager.isVersionNewer(plugin.version, installed)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Logger.e(e) { "ExtensionUpdateJob: novel plugin update check failed" }
            emptyList()
        }
    }

    /**
     * Updates [plugins] in place under the same "Auto-update extensions" rule as the comics
     * extensions, and leaves in the list the ones still waiting for the user.
     */
    private suspend fun autoUpdateNovelPlugins(plugins: MutableList<NovelPluginIndex>, preferences: PreferencesHelper) {
        if (plugins.isEmpty() || !inputData.getBoolean(RUN_AUTO, true)) return
        val mode = preferences.autoUpdateExtensions().get()
        if (mode == AppDownloadInstallJob.NEVER) return
        when {
            LibraryUpdateJob.isRunning(context) -> LibraryUpdateJob.runExtensionUpdatesAfterJob()
            mode != AppDownloadInstallJob.ALWAYS && context.connectivityManager.isActiveNetworkMetered ->
                runJobAgain(context, NetworkType.UNMETERED)
            else -> {
                val manager = get<NovelPluginManager>()
                val updated = plugins.filter { plugin ->
                    try {
                        manager.installPlugin(plugin)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        Logger.e(e) { "ExtensionUpdateJob: novel plugin ${plugin.id} update failed" }
                        false
                    }
                }
                plugins.removeAll(updated)
            }
        }
    }

    private suspend fun createUpdateNotification(
        extensionsList: List<Extension.Available>,
        novelPluginList: List<NovelPluginIndex>,
    ) {
        val extensions = extensionsList.toMutableList()
        val novelPlugins = novelPluginList.toMutableList()
        val basePreferences: BasePreferences by injectLazy()
        val preferences: PreferencesHelper by injectLazy()
        // The count drives the comics Extensions badge, which ExtensionManager also writes.
        preferences.extensionUpdatesCount().set(extensions.size)
        autoUpdateNovelPlugins(novelPlugins, preferences)
        val extensionsInstalledByApp by lazy {
            if (basePreferences.extensionInstaller().get() == ExtensionInstaller.SHIZUKU) {
                if (Shizuku.pingBinder() && Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
                    extensions
                } else {
                    emptyList()
                }
            } else {
                val extManager = get<ExtensionManager>()
                val isOnA12 = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
                extensions.filter {
                    (isOnA12 && extManager.isInstalledByApp(it)) ||
                        ExtensionLoader.isExtensionPrivate(context, it.pkgName)
                }
            }
        }
        if (extensions.isNotEmpty() &&
            ExtensionManager.canAutoInstallUpdates(true) &&
            inputData.getBoolean(RUN_AUTO, true) &&
            preferences.autoUpdateExtensions().get() != AppDownloadInstallJob.NEVER &&
            !ExtensionInstallerJob.isRunning(context) &&
            extensionsInstalledByApp.isNotEmpty()
        ) {
            val cm = context.connectivityManager
            val libraryServiceRunning = LibraryUpdateJob.isRunning(context)
            if (
                (
                    preferences.autoUpdateExtensions().get() == AppDownloadInstallJob.ALWAYS ||
                        !cm.isActiveNetworkMetered
                    ) && !libraryServiceRunning
            ) {
                // Re-run this job if not all the extensions can be auto updated
                val showUpdates = (extensionsInstalledByApp.size != extensions.size).toInt()
                ExtensionInstallerJob.start(context, extensionsInstalledByApp, showUpdates)
                if (extensionsInstalledByApp.size == extensions.size) {
                    extensions.clear()
                } else {
                    extensions.removeAll(extensionsInstalledByApp)
                }
            } else if (!libraryServiceRunning) {
                runJobAgain(context, NetworkType.UNMETERED)
            } else {
                LibraryUpdateJob.runExtensionUpdatesAfterJob()
            }
        }
        if (extensions.isEmpty() && novelPlugins.isEmpty()) return
        val updateCount = extensions.size + novelPlugins.size
        NotificationManagerCompat.from(context).apply {
            if (ActivityCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                return@apply
            }
            notify(
                Notifications.ID_UPDATES_TO_EXTS,
                context.notification(Notifications.CHANNEL_UPDATES_TO_EXTS) {
                    val context = context.localeContext
                    setContentTitle(
                        context.getString(
                            MR.plurals.extension_updates_available,
                            updateCount,
                            updateCount,
                        ),
                    )
                    val extNames = (extensions.map { it.name } + novelPlugins.map { it.name }).joinToString(", ")
                    setContentText(extNames)
                    setStyle(NotificationCompat.BigTextStyle().bigText(extNames))
                    setSmallIcon(R.drawable.ic_extension_update_24dp)
                    color = ContextCompat.getColor(context, R.color.secondaryTachiyomi)
                    setContentIntent(
                        NotificationReceiver.openExtensionsPendingActivity(
                            context,
                        ),
                    )
                    // "Update all" installs comics extensions only, so it is offered when they are all there is.
                    if (ExtensionManager.canAutoInstallUpdates(true) &&
                        extensions.isNotEmpty() &&
                        extensions.size == extensionsList.size &&
                        novelPlugins.isEmpty()
                    ) {
                        val pendingIntent =
                            NotificationReceiver.startExtensionUpdatePendingJob(context, extensions)
                        addAction(
                            R.drawable.ic_file_download_24dp,
                            context.getString(MR.strings.update_all),
                            pendingIntent,
                        )
                    }
                    setAutoCancel(true)
                },
            )
        }
    }

    companion object {
        private const val TAG = "ExtensionUpdate"
        private const val AUTO_TAG = "AutoExtensionUpdate"
        private const val RUN_AUTO = "run_auto"

        fun runJobAgain(context: Context, networkType: NetworkType, runAutoInstaller: Boolean = true) {
            val constraints = Constraints.Builder()
                .setRequiredNetworkType(networkType)
                .build()

            val data = Data.Builder()
            data.putBoolean(RUN_AUTO, runAutoInstaller)

            val request = OneTimeWorkRequestBuilder<ExtensionUpdateJob>()
                .setConstraints(constraints)
                .addTag(AUTO_TAG)
                .setInputData(data.build())
                .build()

            WorkManager.getInstance(context)
                .enqueueUniqueWork(AUTO_TAG, ExistingWorkPolicy.REPLACE, request)
        }

        fun setupTask(context: Context, forceAutoUpdateJob: Boolean? = null) {
            val preferences = get<PreferencesHelper>()
            val autoUpdateJob = forceAutoUpdateJob ?: preferences.automaticExtUpdates().get()
            WorkManager.getInstance(context).jobIsRunning(TAG)
            if (autoUpdateJob) {
                val constraints = Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.CONNECTED)
                    .build()

                val request = PeriodicWorkRequestBuilder<ExtensionUpdateJob>(
                    12,
                    TimeUnit.HOURS,
                    1,
                    TimeUnit.HOURS,
                )
                    .addTag(TAG)
                    .setConstraints(constraints)
                    .build()

                WorkManager.getInstance(context).enqueueUniquePeriodicWork(TAG, ExistingPeriodicWorkPolicy.UPDATE, request)
            } else {
                WorkManager.getInstance(context).cancelAllWorkByTag(TAG)
            }
        }
    }
}
