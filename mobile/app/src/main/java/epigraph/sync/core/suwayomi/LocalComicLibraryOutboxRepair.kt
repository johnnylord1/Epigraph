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
            // Read once for the whole library: one lookup per favorite took most of a sync on a
            // large library. The sets mirror isEntityKnownToCore for comic entries.
            val known by lazy {
                val entityType = EpigraphCoreEntityType.COMIC_ENTRY
                val held = aethon_syncQueries.selectCoreHeldEntityIds(scopeId, entityType).executeAsList().toHashSet()
                val inFlight = aethon_syncQueries.selectInFlightEntityIds(scopeId, entityType).executeAsList()
                    .mapNotNullTo(HashSet()) { it }
                val aliases = aethon_syncQueries.selectEntityAliases().executeAsList()
                    .associate { it.alias_entity_id to it.canonical_entity_id }
                KnownEntities(held, inFlight, aliases)
            }
            aethon_syncQueries.selectComicLibraryRepairRows().executeAsList().mapNotNull { row ->
                val identityEntityId = row.manga_entity_id?.takeIf { row.identity_count == 1L }
                // The catalog sync stores the desktop's entries under the Suwayomi work identity,
                // so an entry the desktop holds is known by either id and is never sent back.
                val republish = identityEntityId != null && replicaCovered &&
                    row.binding_ecosystem == "SUWAYOMI" &&
                    sequenceOf(row.binding_portable_id!!, identityEntityId).distinct().none(known::contains)
                if (row.identity_count > 0 && !republish) return@mapNotNull null
                Candidate(row.manga_id, row.source, row.url, republish)
            }
        }

        // Extension sources register asynchronously on a cold start.
        val publishable = candidates.mapNotNull { candidate ->
            val source = sources.awaitExtensionSource(candidate.sourceId)
            if (source !is HttpSource || source is NovelSource) null else candidate to source
        }
        if (publishable.isEmpty()) {
            return 0
        }
        val categoryIds = database.await {
            publishable.associate { (candidate, _) ->
                candidate.mangaId to categoriesQueries.findAllByMangaId(candidate.mangaId)
                    .executeAsList()
                    .mapTo(linkedSetOf()) { it._id }
            }
        }
        var emitted = 0
        publishable.forEach { (candidate, source) ->
            try {
                val result = router.setMembership(
                    mutation = LibraryMembershipMutation(
                        localMangaId = candidate.mangaId,
                        inLibrary = true,
                        categoryIds = categoryIds.getValue(candidate.mangaId),
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
        val republish: Boolean,
    )

    private class KnownEntities(
        private val held: Set<String>,
        private val inFlight: Set<String>,
        private val aliases: Map<String, String>,
    ) {
        fun contains(entityId: String): Boolean =
            entityId in held || aliases[entityId] in held || entityId in inFlight
    }
}
