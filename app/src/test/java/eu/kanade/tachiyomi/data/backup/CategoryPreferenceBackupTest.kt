package eu.kanade.tachiyomi.data.backup

import eu.kanade.tachiyomi.data.backup.CategoryPreferenceBackup.Setting
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BooleanPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.IntPreferenceValue
import eu.kanade.tachiyomi.data.backup.models.StringSetPreferenceValue
import kotlinx.serialization.Serializable
import kotlinx.serialization.protobuf.ProtoBuf
import kotlinx.serialization.protobuf.ProtoNumber
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import yokai.domain.category.CategoryLibrary

class CategoryPreferenceBackupTest {

    private val device = mapOf(
        CategoryLibrary.COMICS to mapOf("Lendo" to 12, "Dahora" to 13, "Dropado" to 14),
        CategoryLibrary.BOOKS to mapOf("Lendo" to 20),
    )

    private fun remap(preferences: List<BackupPreference>, categories: List<BackupCategory>) =
        CategoryPreferenceBackup.remap(preferences, categories) { library, name -> device[library]?.get(name) }

    private fun List<BackupPreference>.value(key: String) = firstOrNull { it.key == key }?.value

    @Test
    fun `category ids of a backup that has them point to the same categories here`() {
        val categories = listOf(
            BackupCategory(name = "Lendo", order = 0, id = 5),
            BackupCategory(name = "Dahora", order = 1, id = 9),
            BackupCategory(name = "Dropado", order = 2, id = 2),
        )
        val preferences = listOf(
            BackupPreference("download_new", BooleanPreferenceValue(true)),
            BackupPreference("download_new_categories", StringSetPreferenceValue(setOf("9"))),
            BackupPreference("library_update_categories", StringSetPreferenceValue(setOf("0", "5", "9"))),
            BackupPreference("library_update_categories_exclude", StringSetPreferenceValue(setOf("2"))),
            BackupPreference("default_category", IntPreferenceValue(5)),
        )

        val result = remap(preferences, categories)

        assertTrue(result.unresolved.isEmpty())
        assertEquals(BooleanPreferenceValue(true), result.preferences.value("download_new"))
        assertEquals(StringSetPreferenceValue(setOf("13")), result.preferences.value("download_new_categories"))
        assertEquals(
            StringSetPreferenceValue(setOf("0", "12", "13")),
            result.preferences.value("library_update_categories"),
        )
        assertEquals(StringSetPreferenceValue(setOf("14")), result.preferences.value("library_update_categories_exclude"))
        assertEquals(IntPreferenceValue(12), result.preferences.value("default_category"))
    }

    @Test
    fun `a J2K backup without category ids keeps this device's category settings`() {
        // The values of a real J2K backup: its categories carry no ids.
        val categories = listOf(
            BackupCategory(name = "Lendo", order = 0),
            BackupCategory(name = "Dahora", order = 1),
            BackupCategory(name = "Dropado", order = 2),
        )
        val preferences = listOf(
            BackupPreference("download_new", BooleanPreferenceValue(true)),
            BackupPreference("download_new_categories", StringSetPreferenceValue(setOf("2"))),
            BackupPreference("download_new_categories_exclude", StringSetPreferenceValue(emptySet())),
            BackupPreference("library_update_categories", StringSetPreferenceValue(setOf("0", "2", "3"))),
            BackupPreference("collapsed_categories", StringSetPreferenceValue(setOf("2"))),
            BackupPreference("default_category", IntPreferenceValue(3)),
            BackupPreference("last_used_category", IntPreferenceValue(0)),
            BackupPreference("backup_interval", IntPreferenceValue(12)),
        )

        val result = remap(preferences, categories)

        assertEquals(
            setOf(Setting.AUTOMATIC_DOWNLOADS, Setting.LIBRARY_UPDATES, Setting.DEFAULT_CATEGORY),
            result.unresolved,
        )
        // Automatic downloads are not switched on with no category list, which would mean all.
        assertEquals(
            listOf("download_new_categories_exclude", "last_used_category", "backup_interval"),
            result.preferences.map { it.key },
        )
    }

    @Test
    fun `the default category and the special values need no category ids`() {
        val preferences = listOf(
            BackupPreference("download_new", BooleanPreferenceValue(true)),
            BackupPreference("download_new_categories", StringSetPreferenceValue(setOf("0"))),
            BackupPreference("default_category", IntPreferenceValue(-1)),
        )

        val result = remap(preferences, emptyList())

        assertTrue(result.unresolved.isEmpty())
        assertEquals(preferences, result.preferences)
    }

    @Test
    fun `a Books and novels folder maps to the folder of that library`() {
        val categories = listOf(
            BackupCategory(name = "Lendo", order = 0, id = 1),
            BackupCategory(name = "Lendo", order = 0, id = 2, library = CategoryLibrary.BOOKS.name),
        )
        val preferences = listOf(
            BackupPreference("epigraph_books_collapsed_categories", StringSetPreferenceValue(setOf("2"))),
            BackupPreference("collapsed_categories", StringSetPreferenceValue(setOf("1"))),
        )

        val result = remap(preferences, categories)

        assertEquals(StringSetPreferenceValue(setOf("20")), result.preferences.value("epigraph_books_collapsed_categories"))
        assertEquals(StringSetPreferenceValue(setOf("12")), result.preferences.value("collapsed_categories"))
    }

    @Test
    fun `the category id Mihon writes is read`() {
        val bytes = ProtoBuf.encodeToByteArray(MihonCategory.serializer(), MihonCategory("Dahora", 1, 9, 64))

        val category = ProtoBuf.decodeFromByteArray(BackupCategory.serializer(), bytes)

        assertEquals(listOf("Dahora", "1", "9", "64"), listOf(category.name, "${category.order}", "${category.id}", "${category.flags}"))
    }
}

/** Mihon's `BackupCategory`. */
@Serializable
private class MihonCategory(
    @ProtoNumber(1) val name: String,
    @ProtoNumber(2) val order: Long,
    @ProtoNumber(3) val id: Long,
    @ProtoNumber(100) val flags: Long,
)
