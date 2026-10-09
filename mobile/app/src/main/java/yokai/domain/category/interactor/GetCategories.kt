package yokai.domain.category.interactor

import eu.kanade.tachiyomi.domain.manga.models.Manga
import yokai.domain.category.CategoryLibrary
import yokai.domain.category.CategoryRepository

class GetCategories(
    private val categoryRepository: CategoryRepository,
) {
    suspend fun await() = categoryRepository.getAll()
    suspend fun awaitByMangaId(mangaId: Long?) = mangaId?.let { categoryRepository.getAllByMangaId(it) }.orEmpty()
    fun subscribe() = categoryRepository.getAllAsFlow()
    suspend fun await(library: CategoryLibrary) = categoryRepository.getAll(library)
    fun subscribe(library: CategoryLibrary) = categoryRepository.getAllAsFlow(library)

    /** The folders [manga] can be filed in: those of its own library only. */
    suspend fun awaitFor(manga: Manga) = await(CategoryLibrary.of(manga))
    suspend fun awaitFor(mangas: Collection<Manga>) = await(CategoryLibrary.of(mangas))
}
