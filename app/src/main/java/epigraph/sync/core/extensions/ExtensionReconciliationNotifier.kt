package epigraph.sync.core.extensions

import android.Manifest
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import eu.kanade.tachiyomi.R
import eu.kanade.tachiyomi.data.notification.Notifications
import yokai.i18n.MR
import yokai.util.lang.getString

class ExtensionReconciliationNotifier(
    private val context: Context,
) {
    fun show(report: ExtensionParityReport): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        val reviewIntent = PendingIntent.getActivity(
            context,
            REVIEW_REQUEST_CODE,
            ExtensionReconciliationActivity.intent(context),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, Notifications.CHANNEL_UPDATES_TO_EXTS)
            .setSmallIcon(R.drawable.ic_extension_update_24dp)
            .setContentTitle(context.getString(MR.strings.epigraph_core_extensions_title))
            .setContentText(summary(report))
            .setStyle(NotificationCompat.BigTextStyle().bigText(summary(report)))
            .setContentIntent(reviewIntent)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .addAction(
                0,
                context.getString(MR.strings.epigraph_core_extensions_review),
                reviewIntent,
            )
        if (report.installableCount > 0) {
            val installAllIntent = PendingIntent.getActivity(
                context,
                INSTALL_ALL_REQUEST_CODE,
                ExtensionReconciliationActivity.intent(context, installAll = true),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            builder.addAction(
                0,
                context.getString(MR.strings.epigraph_core_extensions_download_all),
                installAllIntent,
            )
        }
        return runCatching {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, builder.build())
            true
        }.getOrDefault(false)
    }

    fun dismiss() {
        NotificationManagerCompat.from(context).cancel(NOTIFICATION_ID)
    }

    private fun summary(report: ExtensionParityReport): String = context.getString(
        MR.strings.epigraph_core_extensions_summary,
        report.installedCount,
        report.availableToInstallCount,
        report.unavailableCount,
    )

    private companion object {
        const val NOTIFICATION_ID = -405
        const val REVIEW_REQUEST_CODE = 72_301
        const val INSTALL_ALL_REQUEST_CODE = 72_302
    }
}
