package eu.kanade.tachiyomi.core.storage

import android.content.Context
import android.os.Environment
import androidx.core.net.toUri
import eu.kanade.tachiyomi.BuildConfig
import yokai.i18n.MR
import yokai.util.lang.getString
import java.io.File

class AndroidStorageFolderProvider(
    private val context: Context,
) : FolderProvider {

    override fun directory(): File {
        return File(
            Environment.getExternalStorageDirectory().absolutePath + File.separator +
                folderName(context.getString(MR.strings.app_normalized_name), BuildConfig.APPLICATION_ID),
        )
    }

    companion object {
        private const val RELEASE_APPLICATION_ID = "app.epigraph.mobile"

        /**
         * Only the release keeps the plain folder. Debug, local, beta and nightly installs default to
         * `Epigraph-<variant>`, so a test build never shares downloads, backups or local books with it.
         */
        fun folderName(baseName: String, applicationId: String): String {
            val variant = applicationId.removePrefix(RELEASE_APPLICATION_ID).removePrefix(".")
            return if (variant.isEmpty() || variant == applicationId) baseName else "$baseName-$variant"
        }
    }

    override fun path(): String {
        return directory().toUri().toString()
    }
}
