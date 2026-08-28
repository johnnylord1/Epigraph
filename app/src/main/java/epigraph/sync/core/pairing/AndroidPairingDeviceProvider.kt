package epigraph.sync.core.pairing

import android.content.Context
import android.os.Build
import eu.kanade.tachiyomi.BuildConfig
import java.util.UUID

/** Stable per-install identity sent in syncd pairing claims. It is not a hardware identifier. */
class AndroidPairingDeviceProvider(
    context: Context,
    private val idFactory: () -> String = { UUID.randomUUID().toString() },
) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun current(): PairingDevice = PairingDevice(
        id = loadOrCreateId(),
        name = canonicalDeviceName(Build.MANUFACTURER, Build.MODEL),
        clientVersion = BuildConfig.VERSION_NAME,
        protocolVersion = 1,
    )

    @Synchronized
    private fun loadOrCreateId(): String {
        preferences.getString(DEVICE_ID_KEY, null)
            ?.takeIf(::isCanonicalDeviceId)
            ?.let { return it }

        val created = idFactory().trim().lowercase()
        check(isCanonicalDeviceId(created)) { "Device ID factory returned an invalid value" }
        check(preferences.edit().putString(DEVICE_ID_KEY, created).commit()) {
            "Epigraph device identity could not be persisted"
        }
        return created
    }

    internal companion object {
        const val PREFERENCES_NAME = "aethon_core_device_v1"
        const val DEVICE_ID_KEY = "device_id"
        private val DEVICE_ID = Regex("[a-z0-9](?:[a-z0-9._-]{0,254}[a-z0-9])?")

        fun isCanonicalDeviceId(value: String): Boolean = DEVICE_ID.matches(value)

        fun canonicalDeviceName(manufacturer: String?, model: String?): String {
            val parts = listOfNotNull(
                manufacturer?.sanitizeDeviceLabel(),
                model?.sanitizeDeviceLabel(),
            ).filter(String::isNotBlank)
            val distinct = parts.distinctBy(String::lowercase)
            return distinct.joinToString(" ")
                .ifBlank { "Android device" }
                .take(MAX_DEVICE_NAME_LENGTH)
                .trim()
        }

        private fun String.sanitizeDeviceLabel(): String = asSequence()
            .map { if (it.isISOControl()) ' ' else it }
            .joinToString("")
            .trim()
            .replace(WHITESPACE, " ")

        private val WHITESPACE = Regex("\\s+")
        private const val MAX_DEVICE_NAME_LENGTH = 256
    }
}
