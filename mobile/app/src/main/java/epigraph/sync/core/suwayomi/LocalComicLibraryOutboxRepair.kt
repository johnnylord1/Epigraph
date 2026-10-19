package epigraph.sync.core.suwayomi

import co.touchlab.kermit.Logger
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.novel.source.NovelSource
import epigraph.sync.EpigraphLibraryMutationRouter
import epigraph.sync.EpigraphMutationOrigin
import epigraph.sync.EpigraphSyncScopeProvider
import epigraph.sync.LibraryMembershipMutation
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.online.HttpSource
import kotlinx.coroutines.CancellationException
import yokai.data.DatabaseHandler

/**
 * Publishes comic favorites that were added on this phone before it paired with a Core.
 *
 * Both devices are sources of the library: favorite changes made before pairing stay local because
 * there is no scope to address them, so this pass sends each extension-backed favorite that still
 * has no identity once the phone is paired. It is idempotent: the router provisions the identity,
 * portable binding and category assignments in one transaction, so a published row is skipped on
 * the next run. Local files and sources whose extension is not installed have no portable identity
 * and stay local.
 */
class LocalComicLibraryOutboxRepair(
    private val database: DatabaseHandler,
    private val sources: SourceManager,
    private val router: EpigraphLibraryMutationRouter,
    private val scopes: EpigraphSyncScopeProvider,
) {
    suspend fun repair(): Int {
        runCatching { scopes.current() }.getOrElse { return 0 }

        val candidates = database.await {
            mangasQueries.findFavorites().executeAsList().mapNotNull { manga ->
                val identified = sequenceOf("MANGA", "NOVEL").any { contentType ->
                    aethon_syncQueries
                        .selectIdentityByLocalReference(contentType, manga._id.toString())
                        .executeAsOneOrNull() != null
                }
                if (identified) return@mapNotNull null
                val categoryIds = categoriesQueries.findAllByMangaId(manga._id)
                    .executeAsList()
                    .mapTo(linkedSetOf()) { it._id }
                Candidate(manga._id, manga.source, manga.url, categoryIds)
            }
        }

        var emitted = 0
        candidates.forEach { candidate ->
            // Extension sources register asynchronously on a cold start.
            val source = sources.awaitExtensionSource(candidate.sourceId)
            if (source !is HttpSource || source is NovelSource) return@forEach
            try {
                val result = router.setMembership(
                    mutation = LibraryMembershipMutation(
                        localMangaId = candidate.mangaId,
                        inLibrary = true,
                        categoryIds = candidate.categoryIds,
                        origin = EpigraphMutationOrigin.LOCAL_USER,
                        portableWorkRef = PortableWorkRef.Comic(
                            sourceId = DecimalSourceId(source.id.toString()),
                            mangaKey = ProviderOwnedKey(candidate.providerKey),
                        ),
                    ),
                    createdAtEpochMillis = System.currentTimeMillis(),
                )
                emitted += result.emittedCommandCount
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (failure: Throwable) {
                Logger.w(failure) {
                    "Unable to publish local comic library entry for manga=${candidate.mangaId}"
                }
            }
        }
        return emitted
    }

    private data class Candidate(
        val mangaId: Long,
        val sourceId: Long,
        val providerKey: String,
        val categoryIds: Set<Long>,
    )
}
