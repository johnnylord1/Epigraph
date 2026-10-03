package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.core.preference.Preference
import eu.kanade.tachiyomi.data.backup.create.BackupOptions
import eu.kanade.tachiyomi.util.BackupUtil
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.zip.GZIPOutputStream
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows

class BackupSecretPolicyTest {

    @Test
    fun `credentials are secret whatever their prefix`() {
        listOf(
            Preference.privateKey("track_token_1"),
            Preference.privateKey("pref_tracker_auth_expired_2"),
            "translation_openai_api_key",
            "APIKEY",
            "password",
            "eh_sessionCookie",
            "client_secret",
            "Authorization",
        ).forEach { assertTrue(BackupSecretPolicy.isSecret(it), it) }
    }

    @Test
    fun `ordinary settings stay in the backup`() {
        listOf(
            "library_sorting_mode",
            "pref_theme",
            "translation_target_language",
            "reader_theme",
            "backup_interval",
        ).forEach { assertFalse(BackupSecretPolicy.isSecret(it), it) }
    }

    @Test
    fun `legacy option arrays with the private flag still decode`() {
        val legacy = BackupOptions().asBooleanArray() + true
        assertEquals(BackupOptions(), BackupOptions.fromBooleanArray(legacy))
        assertEquals(BackupOptions(), BackupOptions.fromBooleanArray(BooleanArray(0)))
    }

    @Test
    fun `decompression stops at the byte budget`() {
        val compressed = ByteArrayOutputStream().also { bytes ->
            GZIPOutputStream(bytes).use { it.write(ByteArray(64 * 1024)) }
        }.toByteArray()
        val error = assertThrows<IllegalArgumentException> {
            java.util.zip.GZIPInputStream(ByteArrayInputStream(compressed)).use {
                BackupUtil.readAtMost(it, 1024, "too large")
            }
        }
        assertEquals("too large", error.message)
    }
}
