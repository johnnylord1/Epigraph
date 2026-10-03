package epigraph.books.importing

import android.content.ContentResolver
import android.net.Uri
import java.io.FileNotFoundException
import java.io.InputStream

/** Thin, ephemeral SAF adapter. It does not take persistable permission or expose its Uri in results. */
class AndroidSafBookImportSource(
    private val contentResolver: ContentResolver,
    private val uri: Uri,
    override val displayName: String,
) : LocalBookStreamSource {
    override fun openStream(): InputStream = contentResolver.openInputStream(uri)
        ?: throw FileNotFoundException("The selected document provider returned no stream")
}
