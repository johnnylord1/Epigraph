package epigraph.novel.repo.interactor

import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.model.NovelRepo
import kotlinx.coroutines.flow.Flow

class GetNovelRepo(
    private val repository: NovelRepoRepository,
) {
    fun subscribeAll(): Flow<List<NovelRepo>> = repository.subscribeAll()

    suspend fun getAll(): List<NovelRepo> = repository.getAll()
}
