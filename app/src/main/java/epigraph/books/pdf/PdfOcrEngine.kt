package epigraph.books.pdf

import android.graphics.Bitmap
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** On-device OCR used only for PDF pages without a native text layer. */
class PdfOcrEngine {

    suspend fun recognize(bitmap: Bitmap): String = suspendCancellableCoroutine { continuation ->
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        val task = runCatching { recognizer.process(InputImage.fromBitmap(bitmap, 0)) }
            .getOrElse { error ->
                recognizer.close()
                continuation.resumeWithException(error)
                return@suspendCancellableCoroutine
            }
        task.addOnSuccessListener { result ->
            recognizer.close()
            if (continuation.isActive) continuation.resume(result.text.orEmpty())
        }.addOnFailureListener { error ->
            recognizer.close()
            if (continuation.isActive) continuation.resumeWithException(error)
        }
        continuation.invokeOnCancellation { recognizer.close() }
    }
}
