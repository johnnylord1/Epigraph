package epigraph.novel.repo.interactor

import epigraph.novel.repo.NovelRepoRepository

class DeleteNovelRepo(
    private val repository: NovelRepoRepository,
) {
    suspend fun await(baseUrl: String) {
        repository.delete(baseUrl)
    }
}
