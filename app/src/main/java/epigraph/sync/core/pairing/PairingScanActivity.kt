package epigraph.sync.core.pairing

import android.os.Bundle
import com.journeyapps.barcodescanner.CaptureActivity
import com.journeyapps.barcodescanner.DecoratedBarcodeView
import com.journeyapps.barcodescanner.camera.CameraSettings

/**
 * The pairing QR scanner. Unlike the library's own activity it follows the phone's orientation
 * (see the manifest) instead of forcing landscape, which rotated the screen behind it, and it
 * focuses continuously: the default AUTO mode refocuses only every couple of seconds, so a QR held
 * close to the camera stayed blurred.
 */
class PairingScanActivity : CaptureActivity() {
    private var scannerView: DecoratedBarcodeView? = null

    override fun initializeContent(): DecoratedBarcodeView =
        super.initializeContent().also { scannerView = it }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // super.onCreate replaces the camera settings from the intent; the camera opens in onResume.
        scannerView?.barcodeView?.cameraSettings?.focusMode = CameraSettings.FocusMode.CONTINUOUS
    }
}
