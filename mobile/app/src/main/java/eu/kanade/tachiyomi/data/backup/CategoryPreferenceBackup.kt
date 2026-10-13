package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import eu.kanade.tachiyomi.data.preference.PreferenceKeys
import yokai.domain.category.CategoryLibrary

/**
 * App preferences that name categories by database id. Ids differ on every device, so restore
 * turns each backup id into the category's name ([BackupCategory.id]) and the name into this
 * device's id, as Mihon does. Backups without category ids (J2K, Tachiyomi 0.x, older Epigraph)
 * cannot say which category an id meant: J2K writes the raw ids back, which only holds on a device
 * whose categories kept the same ids, and Mihon drops them. Here those settings are left as they
 * are on this device instead of pointing at whichever category happens to have that id.
 */
object CategoryPreferenceBackup {
    /** The settings restore reports when it could not tell their categories. */
    enum class Setting { AUTOMATIC_DOWNLOADS, LIBRARY_UPDATES, DEFAULT_CATEGORY }

    class Remapped(val preferences: List<BackupPreference>, val unresolved: Set<Setting>)

    /** The category every manga without one is in; the same id in every fork. */
    private const val DEFAULT_ID = "0"

    private const val DOWNLOAD_NEW_CATEGORIES = "download_new_categories"

    private val SET_KEYS = mapOf(
        "download_new_categories" to Setting.AUTOMATIC_DOWNLOADS,
        "download_new_categories_exclude" to Setting.AUTOMATIC_DOWNLOADS,
        "remove_exclude_categories" to Setting.AUTOMATIC_DOWNLOADS,
        "library_update_categories" to Setting.LIBRARY_UPDATES,
        "library_update_categories_exclude" to Setting.LIBRARY_UPDATES,
        "library_update_smart_update_categories_exclude" to Setting.LIBRARY_UPDATES,
        // Layout only: dropped quietly when unknown.
        "collapsed_categories" to null,
        "epigraph_books_collapsed_categories" to null,
    )

    private val INT_KEYS = mapOf(
        PreferenceKeys.defaultCategory to Setting.DEFAULT_CATEGORY,
        PreferenceKeys.lastUsedCategory to null,
    )

    /**
     * [preferences] with their category ids moved to this device's ids. [deviceCategoryId] finds
     * a restored category by library and name.
     */
    fun remap(
        preferences: List<BackupPreference>,
        backupCategories: List<BackupCategory>,
        deviceCategoryId: (CategoryLibrary, String) -> Int?,
    ): Remapped {
        val ids = deviceIds(backupCategories, deviceCategoryId)
        // Download categories only matter when the backup downloaded new chapters automatically.
        val downloadNew = preferences.firstOrNull { it.key == PreferenceKeys.downloadNew }?.value
        val downloadsOn = (downloadNew as? BooleanPreferenceValue)?.value != false
        val unresolved = mutableSetOf<Setting>()
        val unresolvedKeys = mutableSetOf<String>()

        val remapped = preferences.mapNotNull { preference ->
            val (key, value) = preference
            when {
                key in SET_KEYS && value is StringSetPreferenceValue -> {
                    val mapped = value.value.map { ids[it] }
                    if (mapped.all { it != null }) {
                        preference.copy(value = StringSetPreferenceValue(mapped.filterNotNull().toSet()))
                    } else {
                        if (downloadsOn || !key.startsWith(DOWNLOAD_NEW_CATEGORIES)) {
                            SET_KEYS[key]?.let(unresolved::add)
                        }
                        unresolvedKeys += key
                        null
                    }
                }
                key in INT_KEYS && value is IntPreferenceValue -> {
                    // Zero and below are "default", "always ask" and "last used", not categories.
                    if (value.value <= 0) return@mapNotNull preference
                    val mapped = ids[value.value.toString()]?.toInt()
                    if (mapped != null) {
                        preference.copy(value = IntPreferenceValue(mapped))
                    } else {
                        INT_KEYS[key]?.let(unresolved::add)
                        null
                    }
                }
                else -> preference
            }
        }

        // An empty category list downloads every new chapter in the library: automatic downloads
        // stay as they are on this device until the user picks the categories again.
        val downloadsUnresolved = unresolvedKeys.any { it.startsWith(DOWNLOAD_NEW_CATEGORIES) }
        val result = if (downloadsUnresolved) {
            remapped.filterNot { it.key == PreferenceKeys.downloadNew }
        } else {
            remapped
        }
        return Remapped(result, unresolved)
    }

    /**
     * Backup category id to this device's id, as strings like the preferences store them. Empty
     * when the backup has no usable ids: every category needs its own, or the ids are something
     * else (Tachiyomi 1.x wrote an update interval in the same field).
     */
    private fun deviceIds(
        backupCategories: List<BackupCategory>,
        deviceCategoryId: (CategoryLibrary, String) -> Int?,
    ): Map<String, String> {
        val ids = mutableMapOf(DEFAULT_ID to DEFAULT_ID)
        val usable = backupCategories.isNotEmpty() &&
            backupCategories.all { it.id > 0 } &&
            backupCategories.distinctBy { it.id }.size == backupCategories.size
        if (!usable) return ids
        backupCategories.forEach { category ->
            val library = if (category.library == CategoryLibrary.BOOKS.name) CategoryLibrary.BOOKS else CategoryLibrary.COMICS
            deviceCategoryId(library, category.name)?.let { ids[category.id.toString()] = it.toString() }
        }
        return ids
    }
}
