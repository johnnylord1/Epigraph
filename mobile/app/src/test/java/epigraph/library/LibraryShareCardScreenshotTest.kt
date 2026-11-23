package epigraph.library

import android.app.Application
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Shader
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.ConscryptMode
import org.robolectric.annotation.GraphicsMode

/**
 * Draws the share card with the real fonts and mark. With `-Proborazzi.record=true` the cards
 * are also written to app/build/outputs/roborazzi for a visual check against the desktop card.
 */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@ConscryptMode(ConscryptMode.Mode.OFF)
@Config(sdk = [35], application = Application::class)
class LibraryShareCardScreenshotTest {
    private val context: Application = RuntimeEnvironment.getApplication()

    @Test
    fun `draws a small selection at the minimum image width`() {
        val card = render(3, withCovers = true)
        // 3 columns: 3 * 200 + 2 * 24 + 2 * 40 = 728 units, drawn at 960 / 728.
        assertEquals(960, card.width)
        record(card, "library_share_card_3")
    }

    @Test
    fun `draws the overflow cell and placeholders for a large selection`() {
        val card = render(57, withCovers = false)
        assertTrue(card.width >= 960)
        record(card, "library_share_card_57")
    }

    private fun render(count: Int, withCovers: Boolean): Bitmap {
        val titles = listOf("Solo Leveling", "The Beginning After the End", "Frieren: Beyond Journey's End", "Oshi no Ko")
        val works = (0 until count).map { index ->
            LibraryShareCardWork(titles[index % titles.size], if (withCovers) cover(index) else null)
        }
        return LibraryShareCard.render(context, works, "$count works") { "+$it more" }
    }

    private fun cover(index: Int): Bitmap {
        val bitmap = Bitmap.createBitmap(240, 360, Bitmap.Config.ARGB_8888)
        val colors = listOf(0xFF3A2D6B.toInt(), 0xFF6B2D4F.toInt(), 0xFF2D5B6B.toInt())
        val paint = Paint().apply {
            shader = LinearGradient(0f, 0f, 240f, 360f, colors[index % colors.size], 0xFF101018.toInt(), Shader.TileMode.CLAMP)
        }
        Canvas(bitmap).drawRect(0f, 0f, 240f, 360f, paint)
        return bitmap
    }

    private fun record(card: Bitmap, name: String) {
        if (System.getProperty("roborazzi.test.record") != "true") return
        val directory = File("build/outputs/roborazzi").apply { mkdirs() }
        File(directory, "$name.png").outputStream().use { card.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
