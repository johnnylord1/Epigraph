package eu.kanade.tachiyomi.data.backup.create.creators

import yokai.util.koin.get
import eu.kanade.tachiyomi.data.backup.create.BackupOptions
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.interactor.GetCategories

class CategoriesBackupCreator(
    private val getCategories: GetCategories = get(),
) {
    /**
     * Backup the categories of library
     *
     * @return list of [BackupCategory] to be backed up
     */
    suspend operator fun invoke(): List<BackupCategory> {
        val books = getCategories.await(CategoryLibrary.BOOKS).mapNotNullTo(HashSet()) { it.id }
        return getCategories.await()
            .map { category ->
                BackupCategory.copyFrom(category).apply {
                    if (category.id in books) library = CategoryLibrary.BOOKS.name
                }
            }
    }
}
