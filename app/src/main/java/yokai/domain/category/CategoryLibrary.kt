package yokai.domain.category

import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.data.database.models.isNovel
import eu.kanade.tachiyomi.source.SourceManager

/** The library a folder belongs to: Comics and Books & novels never share folders. */
enum class CategoryLibrary {
    COMICS,
    BOOKS,
    ;

    companion object {
        fun of(manga: Manga, sourceManager: SourceManager? = null): CategoryLibrary =
            if (runCatching { manga.isNovel(sourceManager) }.getOrDefault(false)) BOOKS else COMICS

        fun of(mangas: Collection<Manga>, sourceManager: SourceManager? = null): CategoryLibrary =
            if (mangas.isNotEmpty() && mangas.all { of(it, sourceManager) == BOOKS }) BOOKS else COMICS
    }
}
