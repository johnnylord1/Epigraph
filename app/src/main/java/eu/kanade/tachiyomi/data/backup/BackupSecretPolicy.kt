package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.core.preference.Preference

/**
 * Preference keys that hold credentials and therefore never enter or leave a backup.
 *
 * Keys created with [Preference.privateKey] (tracker tokens, passwords, site cookies) are always
 * secret. Keys written by extensions or by older app code cannot be retrofitted with that prefix,
 * so their names are also matched against common credential markers such as translation API keys
 * or a source's `APIKEY` and `password` settings.
 */
object BackupSecretPolicy {
    fun isSecret(key: String): Boolean {
        if (Preference.isPrivate(key)) return true
        val normalized = key.lowercase().filter(Char::isLetterOrDigit)
        return SECRET_MARKERS.any { it in normalized }
    }

    private val SECRET_MARKERS = listOf(
        "token",
        "cookie",
        "password",
        "passwd",
        "passhash",
        "secret",
        "apikey",
        "credential",
        "sessionid",
        "authorization",
        "bearer",
    )
}
