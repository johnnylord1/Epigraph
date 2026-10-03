package yokai.util.coil

import android.graphics.Bitmap
import coil3.size.Size
import coil3.transform.Transformation

/**
 * Drops the bottom [fraction] of the image. Runs on Coil's decode dispatcher, so a caller never
 * has to crop a (hardware) result bitmap on the main thread.
 */
class CropBottomTransformation(private val fraction: Float) : Transformation() {

    override val cacheKey: String = "${CropBottomTransformation::class.java.name}-$fraction"

    override suspend fun transform(input: Bitmap, size: Size): Bitmap {
        val cut = (input.height * fraction).toInt()
        if (cut <= 0 || cut >= input.height) return input
        return Bitmap.createBitmap(input, 0, 0, input.width, input.height - cut)
    }
}
