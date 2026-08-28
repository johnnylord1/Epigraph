package epigraph.sync.core.assets

import epigraph.books.local.BookCoverAssetInspector
import epigraph.books.local.BookCoverFormat
import epigraph.sync.core.credentials.CoreCredentialStore
import epigraph.sync.core.protocol.EpigraphCoreWireProtocol
import epigraph.sync.core.session.CoreEndpointResolver
import epigraph.sync.core.session.CoreSessionTransportFactory
import eu.kanade.tachiyomi.BuildConfig
import java.io.File
import yokai.data.DatabaseHandler

data class BookAssetDrainReport(
    val attempted: Int,
    val succeeded: Int,
    val retryScheduled: Int,
    val blocked: Int,
)

/** Coordinates immutable Book assets; Core HTTP and SQL remain behind narrow typed ports. */
class BookAssetCoordinator(
    private val database: DatabaseHandler,
    private val credentials: CoreCredentialStore,
    private val endpoints: CoreEndpointResolver,
    private val transports: CoreSessionTransportFactory,
    private val coverStorageDirectory: File,
    private val maxAssetBytes: Long = DEFAULT_MAX_ASSET_BYTES,
) {
    suspend fun drainPendingTransfers(
        client: CoreAssetHttpClient,
        session: epigraph.sync.core.credentials.CoreCredentialSession,
        nowEpochMillis: Long,
    ): BookAssetDrainReport {
        val uploads = drainPendingUploads(client, session, nowEpochMillis)
        return uploads + drainPendingCoverDownloads(client, session, nowEpochMillis)
    }

    suspend fun drainPendingUploads(
        client: CoreAssetHttpClient,
        session: epigraph.sync.core.credentials.CoreCredentialSession,
        nowEpochMillis: Long,
        limit: Long = 4,
    ): BookAssetDrainReport {
        require(nowEpochMillis >= 0 && limit > 0)
        val pending = database.await {
            aethon_syncQueries.selectPendingAssetUploads(limit).executeAsList()
        }
        if (pending.isEmpty()) return BookAssetDrainReport(0, 0, 0, 0)

        var succeeded = 0
        var retry = 0
        var blocked = 0
        val materializer = CoreAssetFileMaterializer(client, maxAssetBytes)
        session.withAccessTokenString { token ->
            val assetSession = CoreAssetSession(
                bearerToken = token,
                clientVersion = BuildConfig.VERSION_NAME,
                protocolVersion = EpigraphCoreWireProtocol.CURRENT_VERSION,
            )
            for (row in pending) {
                val source = File(row.local_uri)
                if (!source.isFile) {
                    updateState(
                        sha256 = row.sha256,
                        contentType = row.content_type,
                        byteSize = row.byte_size,
                        mimeType = row.mime_type,
                        localUri = null,
                        remoteAvailable = false,
                        state = "ERROR",
                        nowEpochMillis = nowEpochMillis,
                    )
                    blocked += 1
                    continue
                }
                try {
                    materializer.upload(
                        assetId = CoreAssetId.parse(row.sha256),
                        scopeId = BOOK_SCOPE,
                        session = assetSession,
                        source = source,
                    )
                    updateState(
                        sha256 = row.sha256,
                        contentType = row.content_type,
                        byteSize = row.byte_size,
                        mimeType = row.mime_type,
                        localUri = source.absolutePath,
                        remoteAvailable = true,
                        state = "AVAILABLE",
                        nowEpochMillis = nowEpochMillis,
                    )
                    succeeded += 1
                } catch (failure: CoreAssetTransferException) {
                    if (failure.failure.isTransient()) {
                        retry += 1
                        break
                    }
                    updateState(
                        sha256 = row.sha256,
                        contentType = row.content_type,
                        byteSize = row.byte_size,
                        mimeType = row.mime_type,
                        localUri = source.absolutePath,
                        remoteAvailable = false,
                        state = "ERROR",
                        nowEpochMillis = nowEpochMillis,
                    )
                    blocked += 1
                }
            }
        }
        return BookAssetDrainReport(pending.size, succeeded, retry, blocked)
    }

    private suspend fun drainPendingCoverDownloads(
        client: CoreAssetHttpClient,
        session: epigraph.sync.core.credentials.CoreCredentialSession,
        nowEpochMillis: Long,
        limit: Long = 4,
    ): BookAssetDrainReport {
        val pending = database.await {
            aethon_syncQueries.selectPendingBookCoverDownloads(limit).executeAsList()
        }
        if (pending.isEmpty()) return BookAssetDrainReport(0, 0, 0, 0)

        var succeeded = 0
        var retry = 0
        var blocked = 0
        val materializer = CoreAssetFileMaterializer(client, BookCoverAssetInspector.MAX_COVER_ASSET_BYTES)
        session.withAccessTokenString { token ->
            val assetSession = CoreAssetSession(
                bearerToken = token,
                clientVersion = BuildConfig.VERSION_NAME,
                protocolVersion = EpigraphCoreWireProtocol.CURRENT_VERSION,
            )
            for (row in pending) {
                val extension = row.mime_type.coverFileExtensionOrNull()
                if (extension == null || row.byte_size !in 1..BookCoverAssetInspector.MAX_COVER_ASSET_BYTES) {
                    markCoverFailure(row, nowEpochMillis)
                    blocked += 1
                    continue
                }
                val destination = File(coverStorageDirectory, "${row.sha256}.$extension")
                try {
                    val result = materializer.download(
                        assetId = CoreAssetId.parse(row.sha256),
                        expectedSize = row.byte_size,
                        scopeId = BOOK_SCOPE,
                        session = assetSession,
                        destination = destination,
                        validator = CoreAssetFileValidator { file ->
                            BookCoverFormat.matches(file, row.mime_type)
                        },
                    )
                    database.await(inTransaction = true) {
                        aethon_syncQueries.updateAssetDownloadState(
                            localUri = result.file.absolutePath,
                            state = "AVAILABLE",
                            updatedAt = nowEpochMillis,
                            sha256 = row.sha256,
                            contentType = row.content_type,
                            byteSize = row.byte_size,
                            mimeType = row.mime_type,
                        )
                        local_booksQueries.publishCoverPath(
                            coverPath = result.file.absolutePath,
                            bookId = row.book_id,
                            coverAssetSha256 = row.sha256,
                            coverAssetByteSize = row.byte_size,
                            coverAssetMimeType = row.mime_type,
                        )
                    }
                    succeeded += 1
                } catch (failure: CoreAssetTransferException) {
                    if (failure.failure.isTransient()) {
                        retry += 1
                        break
                    }
                    markCoverFailure(row, nowEpochMillis)
                    blocked += 1
                }
            }
        }
        return BookAssetDrainReport(pending.size, succeeded, retry, blocked)
    }

    suspend fun ensurePublicationAvailable(bookId: String): File {
        require(bookId.isNotBlank())
        val book = database.await { local_booksQueries.findById(bookId).executeAsOneOrNull() }
            ?: error("Unknown local book")
        val destination = File(book.private_path)
        if (destination.isFile) return destination

        val manifest = database.await { aethon_syncQueries.selectAssetManifest(book.sha256).executeAsOneOrNull() }
            ?: error("The synchronized book has no asset manifest")
        check(manifest.remote_available) { "The book file has not reached Epigraph Core yet" }
        val credential = credentials.load() ?: error("Pair this device before downloading the book")
        credential.use { session ->
            check(BOOK_SCOPE in session.scopes) { "The paired session cannot access Books" }
            val endpoint = endpoints.resolve(session)
            val transport = transports.create(session, endpoint.origin)
            val materializer = CoreAssetFileMaterializer(transport.assets, maxAssetBytes)
            val result = session.withAccessTokenString { token ->
                materializer.download(
                    assetId = CoreAssetId.parse(manifest.sha256),
                    expectedSize = manifest.byte_size,
                    scopeId = BOOK_SCOPE,
                    session = CoreAssetSession(
                        bearerToken = token,
                        clientVersion = BuildConfig.VERSION_NAME,
                        protocolVersion = EpigraphCoreWireProtocol.CURRENT_VERSION,
                    ),
                    destination = destination,
                )
            }
            updateState(
                sha256 = manifest.sha256,
                contentType = manifest.content_type,
                byteSize = manifest.byte_size,
                mimeType = manifest.mime_type,
                localUri = result.file.absolutePath,
                remoteAvailable = true,
                state = "AVAILABLE",
                nowEpochMillis = System.currentTimeMillis(),
            )
            return result.file
        }
    }

    private suspend fun updateState(
        sha256: String,
        contentType: String,
        byteSize: Long,
        mimeType: String,
        localUri: String?,
        remoteAvailable: Boolean,
        state: String,
        nowEpochMillis: Long,
    ) {
        database.await {
            aethon_syncQueries.updateAssetMaterialization(
                localUri = localUri,
                remoteAvailable = remoteAvailable,
                state = state,
                updatedAt = nowEpochMillis,
                sha256 = sha256,
                contentType = contentType,
                byteSize = byteSize,
                mimeType = mimeType,
            )
        }
    }

    private suspend fun markCoverFailure(
        row: tachiyomi.data.SelectPendingBookCoverDownloads,
        nowEpochMillis: Long,
    ) {
        database.await {
            aethon_syncQueries.updateAssetDownloadState(
                localUri = null,
                state = "ERROR",
                updatedAt = nowEpochMillis,
                sha256 = row.sha256,
                contentType = row.content_type,
                byteSize = row.byte_size,
                mimeType = row.mime_type,
            )
        }
    }

    private fun CoreAssetFailure.isTransient(): Boolean = when (this) {
        CoreAssetFailure.NETWORK,
        CoreAssetFailure.UNAUTHORIZED,
        CoreAssetFailure.INCOMPATIBLE_CORE,
        -> true
        else -> false
    }

    private companion object {
        const val BOOK_SCOPE = "books:global"
        const val DEFAULT_MAX_ASSET_BYTES = 2L * 1024L * 1024L * 1024L
    }
}

private operator fun BookAssetDrainReport.plus(other: BookAssetDrainReport) = BookAssetDrainReport(
    attempted = attempted + other.attempted,
    succeeded = succeeded + other.succeeded,
    retryScheduled = retryScheduled + other.retryScheduled,
    blocked = blocked + other.blocked,
)

private fun String.coverFileExtensionOrNull(): String? = when (this) {
    BookCoverFormat.JPEG -> "jpg"
    BookCoverFormat.PNG -> "png"
    BookCoverFormat.WEBP -> "webp"
    else -> null
}
