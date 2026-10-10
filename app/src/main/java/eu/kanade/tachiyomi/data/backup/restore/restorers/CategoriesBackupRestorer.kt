package eu.kanade.tachiyomi.data.backup.restore.restorers

import yokai.util.koin.get
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import yokai.data.DatabaseHandler
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories

class CategoriesBackupRestorer(
    private val getCategories: GetCategories = get(),
    private val handler: DatabaseHandler = get(),
) {
    suspend fun restoreCategories(backupCategories: List<BackupCategory>, onComplete: () -> Unit) {
        // Get categories from file and from db
        handler.await(true) {
            // Iterate over them
            backupCategories.forEach { backupCategory ->
                val category = backupCategory.getCategoryImpl()
                // Comics and Books & novels folders are separate: a name only matches in its library.
                val library = if (backupCategory.library == CategoryLibrary.BOOKS.name) {
                    CategoryLibrary.BOOKS
                } else {
                    CategoryLibrary.COMICS
                }
                // Used to know if the category is already in the db
                var found = false
                for (dbCategory in getCategories.await(library)) {
                    // If the category is already in the db, assign the id to the file's category
                    // and do nothing
                    if (category.name == dbCategory.name) {
                        category.id = dbCategory.id
                        found = true
                        break
                    }
                }
                // If the category isn't in the db, remove the id and insert a new category
                // Store the inserted id in the category
                if (!found) {
                    // Let the db assign the id
                    category.id = null
                    categoriesQueries.insert(
                        name = category.name,
                        mangaOrder = category.mangaOrderToString(),
                        sort = category.order.toLong(),
                        flags = category.flags.toLong(),
                    )
                    category.id = categoriesQueries.selectLastInsertedRowId().executeAsOneOrNull()?.toInt()
                    if (library == CategoryLibrary.BOOKS) {
                        category.id?.let { aethon_syncQueries.upsertCategoryScope(it.toLong(), "NOVEL") }
                    }
                }
            }
        }

        onComplete()
    }
}
