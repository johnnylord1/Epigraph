package epigraph.sync.portable

import epigraph.contract.ComicDependency
import epigraph.contract.DecimalSourceId
import epigraph.contract.ExtensionStoreReference
import epigraph.contract.NovelDependency
import epigraph.contract.PortableChapterRef
import epigraph.contract.PortableResolution
import epigraph.contract.PortableResolutionReason
import epigraph.contract.PortableResolutionState
import epigraph.contract.PortableWorkRef
import epigraph.contract.ProviderOwnedKey
import epigraph.contract.RepositoryReference
import kotlinx.serialization.json.Json
import yokai.data.Database

data class PortableWorkBindingRecord(
    val portableId: String,
    val ref: PortableWorkRef,
    val dependencyKey: String? = null,
    val localReference: String?,
    val resolution: PortableResolution,
    val titleHint: String?,
    val providerLabelHint: String?,
    val attemptCount: Long,
    val updatedAt: Long,
)

data class PortableChapterBindingRecord(
    val portableChapterId: String,
    val portableWorkId: String,
    val ref: PortableChapterRef,
    val localReference: String?,
    val resolution: PortableResolution,
    val attemptCount: Long,
    val updatedAt: Long,
)

interface PortableBindingStore {
    fun upsertWork(record: PortableWorkBindingRecord)

    fun work(portableId: String): PortableWorkBindingRecord?

    fun work(ref: PortableWorkRef): PortableWorkBindingRecord?

    fun workByLocalReference(localReference: String): PortableWorkBindingRecord?

    fun markManifestMembership(serverId: String, profileId: String, portableId: String, observedAt: Long)

    fun pendingWorks(serverId: String, profileId: String, limit: Long): List<PortableWorkBindingRecord>

    fun pendingChapters(serverId: String, profileId: String, limit: Long): List<PortableChapterBindingRecord>

    fun upsertChapter(record: PortableChapterBindingRecord)

    fun chapter(portableChapterId: String): PortableChapterBindingRecord?

    fun chapterByLocalReference(localReference: String): PortableChapterBindingRecord?

    fun chapters(portableWorkId: String): List<PortableChapterBindingRecord>
}

data class PortableComicDependencyRecord(
    val serverId: String,
    val profileId: String,
    val dependency: ComicDependency,
    val trustState: String,
    val resolution: PortableResolution,
    val updatedAt: Long,
)

data class PortableNovelDependencyRecord(
    val serverId: String,
    val profileId: String,
    val dependency: NovelDependency,
    val trustState: String,
    val resolution: PortableResolution,
    val updatedAt: Long,
)

interface PortableDependencyStore {
    fun upsertComic(record: PortableComicDependencyRecord)

    fun comics(serverId: String, profileId: String): List<PortableComicDependencyRecord>

    fun upsertNovel(record: PortableNovelDependencyRecord)

    fun novels(serverId: String, profileId: String): List<PortableNovelDependencyRecord>
}

class SqlDelightPortableDependencyStore(
    private val database: Database,
    private val json: Json = Json,
) : PortableDependencyStore {
    override fun upsertComic(record: PortableComicDependencyRecord) {
        requireDependencyRecord(record.serverId, record.profileId, record.trustState, record.resolution, record.updatedAt)
        val store = record.dependency.extensionStore
        database.aethon_syncQueries.upsertComicDependencyV3(
            serverId = record.serverId,
            profileId = record.profileId,
            packageName = record.dependency.pkgName,
            requiredSourceIdsJson = json.encodeToString(
                record.dependency.requiredSourceIds.map(DecimalSourceId::value).sorted(),
            ),
            observedVersionCode = record.dependency.observedVersionCode,
            extensionStoreIndexUrl = store?.storeIndexUrl,
            observedManifestSha256 = store?.observedManifestSha256,
            displayNameHint = store?.displayNameHint,
            trustState = record.trustState,
            resolutionState = record.resolution.state.name,
            resolutionReason = record.resolution.reason?.name,
            updatedAt = record.updatedAt,
        )
    }

    override fun comics(serverId: String, profileId: String): List<PortableComicDependencyRecord> {
        requireScope(serverId, profileId)
        return database.aethon_syncQueries.selectComicDependenciesV3(serverId, profileId)
            .executeAsList()
            .map { row ->
                PortableComicDependencyRecord(
                    serverId = row.server_id,
                    profileId = row.profile_id,
                    dependency = ComicDependency(
                        pkgName = row.package_name,
                        requiredSourceIds = json.decodeFromString<List<String>>(row.required_source_ids_json)
                            .map(::DecimalSourceId)
                            .toSet(),
                        observedVersionCode = row.observed_version_code,
                        extensionStore = row.extension_store_index_url?.let {
                            ExtensionStoreReference(
                                storeIndexUrl = it,
                                observedManifestSha256 = row.observed_manifest_sha256,
                                displayNameHint = row.display_name_hint,
                            )
                        },
                    ),
                    trustState = row.trust_state,
                    resolution = resolution(row.resolution_state, row.resolution_reason),
                    updatedAt = row.updated_at,
                )
            }
    }

    override fun upsertNovel(record: PortableNovelDependencyRecord) {
        requireDependencyRecord(record.serverId, record.profileId, record.trustState, record.resolution, record.updatedAt)
        val repository = record.dependency.repository
        database.aethon_syncQueries.upsertNovelDependencyV3(
            serverId = record.serverId,
            profileId = record.profileId,
            pluginId = record.dependency.pluginId,
            observedVersion = record.dependency.observedVersion,
            repositoryIndexUrl = repository?.indexUrl,
            observedManifestSha256 = repository?.observedManifestSha256,
            observedArtifactSha256 = record.dependency.observedArtifactSha256,
            displayNameHint = repository?.displayNameHint,
            trustState = record.trustState,
            resolutionState = record.resolution.state.name,
            resolutionReason = record.resolution.reason?.name,
            updatedAt = record.updatedAt,
        )
    }

    override fun novels(serverId: String, profileId: String): List<PortableNovelDependencyRecord> {
        requireScope(serverId, profileId)
        return database.aethon_syncQueries.selectNovelDependenciesV3(serverId, profileId)
            .executeAsList()
            .map { row ->
                PortableNovelDependencyRecord(
                    serverId = row.server_id,
                    profileId = row.profile_id,
                    dependency = NovelDependency(
                        pluginId = row.plugin_id,
                        observedVersion = row.observed_version,
                        repository = row.repository_index_url?.let {
                            RepositoryReference(
                                indexUrl = it,
                                observedManifestSha256 = row.observed_manifest_sha256,
                                displayNameHint = row.display_name_hint,
                            )
                        },
                        observedArtifactSha256 = row.observed_artifact_sha256,
                    ),
                    trustState = row.trust_state,
                    resolution = resolution(row.resolution_state, row.resolution_reason),
                    updatedAt = row.updated_at,
                )
            }
    }

    private fun resolution(state: String, reason: String?) = PortableResolution(
        state = PortableResolutionState.valueOf(state),
        reason = reason?.let(PortableResolutionReason::valueOf),
    )

    private fun requireDependencyRecord(
        serverId: String,
        profileId: String,
        trustState: String,
        resolution: PortableResolution,
        updatedAt: Long,
    ) {
        requireScope(serverId, profileId)
        require(trustState in TRUST_STATES) { "portable dependency trust state is invalid" }
        require(updatedAt >= 0) { "portable dependency timestamp must not be negative" }
        require(resolution.state !in setOf(PortableResolutionState.BOUND, PortableResolutionState.LEGACY_UNBOUND)) {
            "dependency resolution cannot use an entity binding state"
        }
    }

    private fun requireScope(serverId: String, profileId: String) {
        require(serverId.isNotBlank() && serverId == serverId.trim()) { "server ID must be canonical" }
        require(profileId.isNotBlank() && profileId == profileId.trim()) { "profile ID must be canonical" }
    }

    private companion object {
        val TRUST_STATES = setOf("TRUSTED", "APPROVAL_REQUIRED", "REJECTED")
    }
}

class SqlDelightPortableBindingStore(
    private val database: Database,
) : PortableBindingStore {
    override fun upsertWork(record: PortableWorkBindingRecord) {
        requireRecord(record.portableId, record.localReference, record.resolution, record.attemptCount, record.updatedAt)
        val comic = record.ref as? PortableWorkRef.Comic
        val novel = record.ref as? PortableWorkRef.Novel
        database.aethon_syncQueries.upsertPortableWorkBinding(
            portableId = record.portableId,
            ecosystem = record.ref.ecosystem.name,
            sourceId = comic?.sourceId?.value,
            pluginId = novel?.pluginId,
            providerKey = comic?.mangaKey?.value ?: requireNotNull(novel).novelKey.value,
            dependencyKey = record.dependencyKey,
            localReference = record.localReference,
            resolutionState = record.resolution.state.name,
            resolutionReason = record.resolution.reason?.name,
            titleHint = record.titleHint?.validatedHint("title hint"),
            providerLabelHint = record.providerLabelHint?.validatedHint("provider label hint"),
            attemptCount = record.attemptCount,
            updatedAt = record.updatedAt,
        )
    }

    override fun work(portableId: String): PortableWorkBindingRecord? {
        requireIdentifier(portableId, "portable ID")
        return database.aethon_syncQueries.selectPortableWorkBinding(portableId)
            .executeAsOneOrNull()
            ?.let(::mapWork)
    }

    override fun work(ref: PortableWorkRef): PortableWorkBindingRecord? = when (ref) {
        is PortableWorkRef.Comic -> database.aethon_syncQueries
            .selectPortableWorkBindingByComicRef(ref.sourceId.value, ref.mangaKey.value)
            .executeAsOneOrNull()
            ?.let(::mapWork)
        is PortableWorkRef.Novel -> database.aethon_syncQueries
            .selectPortableWorkBindingByNovelRef(ref.pluginId, ref.novelKey.value)
            .executeAsOneOrNull()
            ?.let(::mapWork)
    }

    override fun markManifestMembership(serverId: String, profileId: String, portableId: String, observedAt: Long) {
        requireIdentifier(serverId, "server ID")
        requireIdentifier(profileId, "profile ID")
        requireIdentifier(portableId, "portable ID")
        require(observedAt >= 0)
        database.aethon_syncQueries.upsertPortableManifestWork(serverId, profileId, portableId, observedAt)
    }

    override fun pendingWorks(
        serverId: String,
        profileId: String,
        limit: Long,
    ): List<PortableWorkBindingRecord> {
        require(limit in 1..MAX_BATCH_SIZE) { "portable work batch limit is out of range" }
        return database.aethon_syncQueries
            .selectPendingPortableWorkIdsForManifest(serverId, profileId, limit)
            .executeAsList()
            .mapNotNull { portableId -> work(portableId) }
    }

    override fun pendingChapters(
        serverId: String,
        profileId: String,
        limit: Long,
    ): List<PortableChapterBindingRecord> {
        require(limit in 1..MAX_BATCH_SIZE) { "portable chapter batch limit is out of range" }
        return database.aethon_syncQueries
            .selectPendingPortableChapterIdsForManifest(serverId, profileId, limit)
            .executeAsList()
            .mapNotNull { portableChapterId -> chapter(portableChapterId) }
    }

    override fun workByLocalReference(localReference: String): PortableWorkBindingRecord? {
        requireIdentifier(localReference, "local reference")
        return database.aethon_syncQueries.selectPortableWorkBindingByLocalReference(localReference)
            .executeAsOneOrNull()
            ?.let(::mapWork)
    }

    override fun upsertChapter(record: PortableChapterBindingRecord) {
        requireIdentifier(record.portableChapterId, "portable chapter ID")
        requireIdentifier(record.portableWorkId, "portable work ID")
        requireRecord(
            record.portableChapterId,
            record.localReference,
            record.resolution,
            record.attemptCount,
            record.updatedAt,
        )
        val chapterKey = when (val ref = record.ref) {
            is PortableChapterRef.Comic -> ref.chapterKey.value
            is PortableChapterRef.Novel -> ref.chapterKey.value
        }
        database.aethon_syncQueries.upsertPortableChapterBinding(
            portableChapterId = record.portableChapterId,
            portableWorkId = record.portableWorkId,
            providerKey = chapterKey,
            localReference = record.localReference,
            resolutionState = record.resolution.state.name,
            resolutionReason = record.resolution.reason?.name,
            attemptCount = record.attemptCount,
            updatedAt = record.updatedAt,
        )
    }

    override fun chapter(portableChapterId: String): PortableChapterBindingRecord? {
        requireIdentifier(portableChapterId, "portable chapter ID")
        return database.aethon_syncQueries.selectPortableChapterBinding(portableChapterId)
            .executeAsOneOrNull()
            ?.let(::mapChapter)
    }

    override fun chapterByLocalReference(localReference: String): PortableChapterBindingRecord? {
        requireIdentifier(localReference, "local reference")
        return database.aethon_syncQueries.selectPortableChapterBindingByLocalReference(localReference)
            .executeAsOneOrNull()
            ?.let(::mapChapter)
    }

    override fun chapters(portableWorkId: String): List<PortableChapterBindingRecord> {
        requireIdentifier(portableWorkId, "portable work ID")
        val work = work(portableWorkId) ?: return emptyList()
        return database.aethon_syncQueries.selectPortableChaptersForWork(portableWorkId)
            .executeAsList()
            .map { row -> mapChapter(row, work.ref) }
    }

    private fun mapWork(row: tachiyomi.data.Aethon_portable_work_binding): PortableWorkBindingRecord {
        val ref = when (row.ecosystem) {
            "SUWAYOMI" -> PortableWorkRef.Comic(
                sourceId = DecimalSourceId(requireNotNull(row.source_id)),
                mangaKey = ProviderOwnedKey(row.provider_key),
            )
            "LNREADER" -> PortableWorkRef.Novel(
                pluginId = requireNotNull(row.plugin_id),
                novelKey = ProviderOwnedKey(row.provider_key),
            )
            else -> error("Unsupported portable ecosystem: ${row.ecosystem}")
        }
        return PortableWorkBindingRecord(
            portableId = row.portable_id,
            ref = ref,
            dependencyKey = row.dependency_key,
            localReference = row.local_reference,
            resolution = resolution(row.resolution_state, row.resolution_reason),
            titleHint = row.title_hint,
            providerLabelHint = row.provider_label_hint,
            attemptCount = row.attempt_count,
            updatedAt = row.updated_at,
        )
    }

    private fun mapChapter(
        row: tachiyomi.data.Aethon_portable_chapter_binding,
        knownWork: PortableWorkRef? = null,
    ): PortableChapterBindingRecord {
        val work = knownWork ?: requireNotNull(work(row.portable_work_id)).ref
        val ref = when (work) {
            is PortableWorkRef.Comic -> PortableChapterRef.Comic(work, ProviderOwnedKey(row.provider_key))
            is PortableWorkRef.Novel -> PortableChapterRef.Novel(work, ProviderOwnedKey(row.provider_key))
        }
        return PortableChapterBindingRecord(
            portableChapterId = row.portable_chapter_id,
            portableWorkId = row.portable_work_id,
            ref = ref,
            localReference = row.local_reference,
            resolution = resolution(row.resolution_state, row.resolution_reason),
            attemptCount = row.attempt_count,
            updatedAt = row.updated_at,
        )
    }

    private fun resolution(state: String, reason: String?) = PortableResolution(
        state = PortableResolutionState.valueOf(state),
        reason = reason?.let(PortableResolutionReason::valueOf),
    )

    private fun requireRecord(
        id: String,
        localReference: String?,
        resolution: PortableResolution,
        attemptCount: Long,
        updatedAt: Long,
    ) {
        requireIdentifier(id, "portable ID")
        localReference?.let { requireIdentifier(it, "local reference") }
        require(attemptCount >= 0) { "attempt count must not be negative" }
        require(updatedAt >= 0) { "updatedAt must not be negative" }
        require(resolution.state != PortableResolutionState.BOUND || localReference != null) {
            "bound records require a local reference"
        }
        require(resolution.state != PortableResolutionState.READY) {
            "work and chapter bindings cannot use the dependency-ready state"
        }
    }

    private fun requireIdentifier(value: String, label: String) {
        require(value.isNotBlank() && value == value.trim()) { "$label must be non-blank and canonical" }
        require(value.length <= MAX_IDENTIFIER_LENGTH) { "$label is too long" }
        require(value.none(Char::isISOControl)) { "$label must not contain control characters" }
    }

    private fun String.validatedHint(label: String): String = also {
        require(isNotBlank() && this == trim()) { "$label must be non-blank and canonical" }
        require(length <= MAX_HINT_LENGTH) { "$label is too long" }
        require(none(Char::isISOControl)) { "$label must not contain control characters" }
    }

    private companion object {
        const val MAX_IDENTIFIER_LENGTH = 512
        const val MAX_HINT_LENGTH = 512
        const val MAX_BATCH_SIZE = 1_000L
    }
}
