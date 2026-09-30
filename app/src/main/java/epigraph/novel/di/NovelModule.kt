package epigraph.novel.di

import epigraph.novel.plugin.NovelPluginManager
import epigraph.novel.repo.NovelRepoIndexValidatorImpl
import epigraph.novel.repo.NovelRepoRepositoryImpl
import epigraph.novel.repo.NovelRepoRepository
import epigraph.novel.repo.interactor.CreateNovelRepo
import epigraph.novel.repo.interactor.DeleteNovelRepo
import epigraph.novel.repo.interactor.GetNovelRepo
import epigraph.novel.repo.interactor.NovelRepoIndexValidator
import android.app.Application
import org.koin.dsl.module

fun novelModule() = module {
    single<NovelRepoRepository> { NovelRepoRepositoryImpl(get()) }
    single<NovelRepoIndexValidator> { NovelRepoIndexValidatorImpl(get()) }

    factory { GetNovelRepo(get()) }
    factory { CreateNovelRepo(get(), get()) }
    factory { DeleteNovelRepo(get()) }

    single {
        NovelPluginManager(
            context = get<Application>(),
            repoRepository = get(),
            networkHelper = get(),
            preferences = get(),
        )
    }
}
