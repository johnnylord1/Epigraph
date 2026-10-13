package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import eu.kanade.tachiyomi.data.preference.PreferenceKeys
import yokai.domain.category.CategoryLibrary

/**
 * App preferences that name categories by database id. Ids differ on every device, so restore
 * turns each backup id into the category's name ([BackupCategory.id]) and the name into this
 * device's id, as Mihon does.
 *
 * J2K and Tachiyomi 0.x backups carry no category ids. Restoring one of them in that app on a new
 * device inserts the categories in backup order, so they get ids 1, 2, 3… and the preferences'
 * ids are read against that numbering; restore here reads them the same way. Older Epigraph
 * backups have no ids either and never had that numbering: their category settings, like any id
 * that names no category, are left as they are on this device instead of pointing at whichever
 * category happens to have that id here.
 */
object CategoryPreferenceBackup {
    /** The settings restore reports when it could not tell their categories. */
    enum class Setting { AUTOMATIC_DOWNLOADS, LIBRARY_UPDATES, DEFAULT_CATEGORY }

    class Remapped(val preferences: List<BackupPreference>, val unresolved: Set<Setting>)

    /** The category every manga without one is in; the same id in every fork. */
    private const val DEFAULT_ID = "0"

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
        idsInBackupOrder: Boolean,
        deviceCategoryId: (CategoryLibrary, String) -> Int?,
    ): Remapped {
        val ids = deviceIds(backupCategories, idsInBackupOrder, deviceCategoryId)
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
                        SET_KEYS[key]?.let(unresolved::add)
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
        val downloadsUnresolved = unresolvedKeys.any { it.startsWith("download_new_categories") }
        val result = if (downloadsUnresolved) {
            remapped.filterNot { it.key == PreferenceKeys.downloadNew }
        } else {
            remapped
        }
        return Remapped(result, unresolved)
    }

    /**
     * Backup category id to this device's id, as strings like the preferences store them. The
     * backup's own ids count only when every category has a different one (Tachiyomi 1.x wrote an
     * update interval in the same field); otherwise, with [idsInBackupOrder], the categories are
     * numbered from 1 in backup order.
     */
    private fun deviceIds(
        backupCategories: List<BackupCategory>,
        idsInBackupOrder: Boolean,
        deviceCategoryId: (CategoryLibrary, String) -> Int?,
    ): Map<String, String> {
        val ids = mutableMapOf(DEFAULT_ID to DEFAULT_ID)
        val ownIds = backupCategories.all { it.id > 0 } &&
            backupCategories.distinctBy { it.id }.size == backupCategories.size
        val backupIds = when {
            backupCategories.isEmpty() -> return ids
            ownIds -> backupCategories.map { it.id }
            idsInBackupOrder -> backupCategories.indices.map { it + 1L }
            else -> return ids
        }
        backupCategories.forEachIndexed { index, category ->
            val library = if (category.library == CategoryLibrary.BOOKS.name) CategoryLibrary.BOOKS else CategoryLibrary.COMICS
            deviceCategoryId(library, category.name)?.let { ids[backupIds[index].toString()] = it.toString() }
        }
        return ids
    }
}
