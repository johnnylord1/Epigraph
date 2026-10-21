package epigraph.sync.core.suwayomi

import co.touchlab.kermit.Logger
import epigraph.contract.DecimalSourceId
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.novel.source.NovelSource
import epigraph.sync.core.protocol.EpigraphCoreEntityType
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
 *
 * A favorite that already has a portable identity is republished once the paired Core's snapshot
 * shows it does not hold the entry (a newly paired or rewound Core).
 */
class LocalComicLibraryOutboxRepair(
    private val database: DatabaseHandler,
    private val sources: SourceManager,
    private val router: EpigraphLibraryMutationRouter,
    private val scopes: EpigraphSyncScopeProvider,
) {
    suspend fun repair(): Int {
        val scopeId = runCatching { scopes.current() }.getOrElse { return 0 }.comics.value

        val candidates = database.await {
            val replicaCovered = aethon_syncQueries.hasCoreReplicaCoverageForScope(scopeId).executeAsOne()
            mangasQueries.findFavorites().executeAsList().mapNotNull { manga ->
                val identities = sequenceOf("MANGA", "NOVEL").mapNotNull { contentType ->
                    aethon_syncQueries
                        .selectIdentityByLocalReference(contentType, manga._id.toString())
                        .executeAsOneOrNull()
                }.toList()
                val republish = identities.singleOrNull()?.content_type == "MANGA" && replicaCovered &&
                    aethon_syncQueries.selectPortableWorkBindingByLocalReference(manga._id.toString())
                        .executeAsOneOrNull()
                        ?.takeIf { it.ecosystem == "SUWAYOMI" }
                        ?.let { binding ->
                            !aethon_syncQueries.isEntityKnownToCore(
                                scopeId,
                                EpigraphCoreEntityType.COMIC_ENTRY,
                                binding.portable_id,
                            ).executeAsOne()
                        } == true
                if (identities.isNotEmpty() && !republish) return@mapNotNull null
                val categoryIds = categoriesQueries.findAllByMangaId(manga._id)
                    .executeAsList()
                    .mapTo(linkedSetOf()) { it._id }
                Candidate(manga._id, manga.source, manga.url, categoryIds, republish)
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
                        ).takeUnless { candidate.republish },
                        republish = candidate.republish,
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
        val republish: Boolean,
    )
}
