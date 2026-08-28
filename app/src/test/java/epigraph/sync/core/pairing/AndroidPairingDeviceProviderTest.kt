package epigraph.sync.core.pairing

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class AndroidPairingDeviceProviderTest {
    @Test
    fun `device name is canonical and bounded`() {
        val name = AndroidPairingDeviceProvider.canonicalDeviceName(
            "  Epigraph\nDevices  ",
            "  Pocket\u0000 Reader  ",
        )

        assertEquals("Epigraph Devices Pocket Reader", name)
        assertEquals(256, AndroidPairingDeviceProvider.canonicalDeviceName("x".repeat(300), null).length)
    }

    @Test
    fun `duplicate manufacturer and model are not repeated`() {
        assertEquals(
            "Pixel",
            AndroidPairingDeviceProvider.canonicalDeviceName("Pixel", "pixel"),
        )
    }

    @Test
    fun `device id grammar excludes claim injection characters`() {
        assertTrue(AndroidPairingDeviceProvider.isCanonicalDeviceId("c4ae3d16-711c-4e5d-b31f-154334206452"))
        assertFalse(AndroidPairingDeviceProvider.isCanonicalDeviceId("device id"))
        assertFalse(AndroidPairingDeviceProvider.isCanonicalDeviceId("device\nheader"))
        assertFalse(AndroidPairingDeviceProvider.isCanonicalDeviceId("-device"))
    }
}
