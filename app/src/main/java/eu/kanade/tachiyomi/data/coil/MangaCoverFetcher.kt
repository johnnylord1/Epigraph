package eu.kanade.tachiyomi.data.coil

import android.util.Base64
import android.webkit.MimeTypeMap
import androidx.core.net.toUri
import co.touchlab.kermit.Logger
import coil3.ImageLoader
import coil3.decode.DataSource
import coil3.decode.ImageSource
import coil3.disk.DiskCache
import coil3.fetch.FetchResult
import coil3.fetch.Fetcher
import coil3.fetch.SourceFetchResult
import coil3.request.Options
import com.hippo.unifile.UniFile
import epigraph.sync.core.http.CoreHttpResult
import epigraph.sync.core.suwayomi.EpigraphCoreCoverClient
import epigraph.sync.core.suwayomi.EpigraphCoreSource
import epigraph.sync.core.protocol.SuwayomiCoreThumbnailReference
import eu.kanade.tachiyomi.data.cache.CoverCache
import eu.kanade.tachiyomi.domain.manga.models.Manga
import eu.kanade.tachiyomi.network.await
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.source.online.HttpSource
import eu.kanade.tachiyomi.util.manga.MangaCoverMetadata
import epigraph.novel.source.NovelSource
import java.io.File
import java.net.HttpURLConnection
import java.util.Date
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import okhttp3.CacheControl
import okhttp3.Call
import okhttp3.Request
import okhttp3.Response
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import okio.FileSystem
import okio.IOException
import okio.Path.Companion.toOkioPath
import okio.Source
import okio.buffer
import okio.sink
import okio.source
import yokai.util.koin.injectLazy
import yokai.util.koin.get
import yokai.domain.manga.models.MangaCover
import yokai.domain.manga.interactor.GetManga

class MangaCoverFetcher(
    private val mangaId: Long?,
    private val url: String?,
    private val isInLibrary: Boolean,
    private val sourceResolver: suspend () -> HttpSource?,
    private val novelSourceLazy: Lazy<NovelSource?>,
    private val options: Options,
    private val callFactoryLazy: Lazy<Call.Factory>,
    private val diskCacheKeyLazy: Lazy<String>,
    private val coverFileLazy: Lazy<File?>,
    private val customCoverFileLazy: Lazy<File>,
    private val imageLoader: ImageLoader,
    private val coreCoverClientLazy: Lazy<EpigraphCoreCoverClient>,
) : Fetcher {

    private val diskCacheKey: String
        get() = diskCacheKeyLazy.value

    private val fileScope = CoroutineScope(Job() + Dispatchers.IO)

    private var sourceResolved = false
    private var resolvedSource: HttpSource? = null

    /** The title's installed source, waiting for extensions to load on a cold start. */
    private suspend fun source(): HttpSource? {
        if (!sourceResolved) {
            resolvedSource = sourceResolver()
            sourceResolved = true
        }
        return resolvedSource
    }

    override suspend fun fetch(): FetchResult {
        if (options.useCustomCover) {
            val customCoverFile = customCoverFileLazy.value
            if (customCoverFile.exists()) {
                setRatioAndColorsInScope(mangaId, url, isInLibrary, UniFile.fromFile(customCoverFile))
                return fileLoader(customCoverFile)
            }
        }

        if (url == null) error("No cover specified")
        return when (getResourceType(url)) {
            Type.URL -> httpLoader()
            Type.File -> {
                val file = File(url.substringAfter("file://"))
                setRatioAndColorsInScope(mangaId, url, isInLibrary, UniFile.fromFile(file))
                fileLoader(file)
            }
            Type.URI -> {
                setRatioAndColorsInScope(mangaId, url, isInLibrary, UniFile.fromUri(options.context, url.toUri()))
                fileUriLoader(url)
            }
            Type.DATA -> dataUriLoader(url)
            null -> error("Invalid image")
        }
    }

    private fun fileLoader(file: File): FetchResult {
        return SourceFetchResult(
            source = ImageSource(
                file = file.toOkioPath(),
                fileSystem = FileSystem.SYSTEM,
                diskCacheKey = diskCacheKey,
            ),
            mimeType = "image/*",
            dataSource = DataSource.DISK,
        )
    }

    private fun fileUriLoader(uri: String): FetchResult {
        val source = UniFile.fromUri(options.context, uri.toUri())!!
            .openInputStream()
            .source()
            .buffer()
        return SourceFetchResult(
            source = ImageSource(source = source, fileSystem = FileSystem.SYSTEM),
            mimeType = "image/*",
            dataSource = DataSource.DISK,
        )
    }

    // LNReader plugins (and novels synced from the desktop) may embed the cover as a base64 data URI.
    private fun dataUriLoader(uri: String): FetchResult {
        val header = uri.substringBefore(',')
        require(header.endsWith(";base64", ignoreCase = true)) { "Unsupported data URI cover" }
        val bytes = Base64.decode(uri.substringAfter(','), Base64.DEFAULT)
        setRatioAndColorsInScope(mangaId, url, isInLibrary)
        return SourceFetchResult(
            source = ImageSource(source = Buffer().write(bytes), fileSystem = FileSystem.SYSTEM),
            mimeType = header.removePrefix("data:").substringBefore(';').ifBlank { "image/*" },
            dataSource = DataSource.MEMORY,
        )
    }

    private suspend fun httpLoader(): FetchResult {
        val coverFile = coverFileLazy.value
        if (coverFile?.exists() == true && options.diskCachePolicy.readEnabled) {
            if (!isInLibrary) {
                coverFile.setLastModified(Date().time)
            }
            setRatioAndColorsInScope(mangaId, url, isInLibrary, UniFile.fromFile(coverFile))
            return fileLoader(coverFile)
        }

        var snapshot = readFromDiskCache()
        try {
            // Fetch from disk cache
            if (snapshot != null) {
                val snapshotCoverCache = moveSnapshotToCoverCache(snapshot, coverFile)
                if (snapshotCoverCache != null) {
                    // Read from cover cache after added to library
                    setRatioAndColorsInScope(mangaId, url, isInLibrary, UniFile.fromFile(snapshotCoverCache))
                    return fileLoader(snapshotCoverCache)
                }

                // Read from snapshot
                setRatioAndColorsInScope(mangaId, url, isInLibrary)
                return SourceFetchResult(
                    source = snapshot.toImageSource(),
                    mimeType = "image/*",
                    dataSource = DataSource.DISK,
                )
            }

            // Fetch from network
            val response = executeNetworkRequest()
            val responseBody = checkNotNull(response.body) { "Null response source" }
            try {
                // Read from cover cache after library manga cover updated
                val responseCoverCache = writeResponseToCoverCache(response, coverFile)
                setRatioAndColorsInScope(mangaId, url, isInLibrary)
                if (responseCoverCache != null) {
                    return fileLoader(responseCoverCache)
                }

                // Read from disk cache
                snapshot = writeToDiskCache(response)
                if (snapshot != null) {
                    return SourceFetchResult(
                        source = snapshot.toImageSource(),
                        mimeType = "image/*",
                        dataSource = DataSource.NETWORK,
                    )
                }

                // Read from response if cache is unused or unusable
                return SourceFetchResult(
                    source = ImageSource(source = responseBody.source(), fileSystem = FileSystem.SYSTEM),
                    mimeType = "image/*",
                    dataSource = if (response.cacheResponse != null) DataSource.DISK else DataSource.NETWORK,
                )
            } catch (e: Exception) {
                responseBody.close()
                throw e
            }
        } catch (e: Exception) {
            snapshot?.close()
            throw e
        }
    }

    private suspend fun executeNetworkRequest(): Response {
        if (url?.startsWith(SuwayomiCoreThumbnailReference.SCHEME, ignoreCase = true) == true) {
            val result = coreCoverClientLazy.value.fetch(url!!)
            val bytes = when (result) {
                is CoreHttpResult.Success -> result.value
                is CoreHttpResult.Failure -> return installedSourceCover()
                    ?: error("Core cover request failed with ${result.statusCode}")
            }
            return Response.Builder()
                .request(Request.Builder().url(CORE_COVER_RESPONSE_URL).build())
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(bytes.toResponseBody(IMAGE_MEDIA_TYPE))
                .build()
        }
        novelSourceLazy.value?.let { novelSource ->
            val coverUrl = requireNotNull(url)
            val bytes = novelSource.fetchCoverBytes(coverUrl)
            return Response.Builder()
                .request(Request.Builder().url(coverUrl).build())
                .protocol(okhttp3.Protocol.HTTP_1_1)
                .code(200)
                .message("OK")
                .body(bytes.toResponseBody(IMAGE_MEDIA_TYPE))
                .build()
        }
        val source = source()
        val client = source?.client ?: callFactoryLazy.value
        val response = client.newCall(newRequest(source)).await()
        val failure = when {
            !response.isSuccessful && response.code != HttpURLConnection.HTTP_NOT_MODIFIED ->
                "HTTP ${response.code} ${response.message}"
            !response.isImageLike() -> "Not an image: ${response.header("Content-Type")}"
            else -> null
        } ?: return response
        response.close()
        // The stored cover link may be dead (a retired CDN that now redirects to an unrelated
        // page) or expired. Ask the installed source for the current one before giving up.
        if (isInLibrary && options.networkCachePolicy.readEnabled) installedSourceCover()?.let { return it }
        throw IOException(failure)
    }

    /** False for the HTML or JSON pages that dead cover hosts answer with, which must not be cached as covers. */
    private fun Response.isImageLike(): Boolean {
        val type = header("Content-Type")?.substringBefore(';')?.trim()?.lowercase() ?: return true
        return !type.startsWith("text/") && !type.contains("html") && !type.contains("json")
    }

    /**
     * The desktop serves only covers it has cached. When it has none and this title is already
     * relinked to an extension installed on the phone, the phone asks that source for the cover
     * itself (through the extension's own client, Cloudflare handling included).
     */
    private suspend fun installedSourceCover(): Response? {
        val source = source()?.takeUnless { it.id == EpigraphCoreSource.ID } ?: return null
        val manga = mangaId?.let { runCatching { get<GetManga>().awaitById(it) }.getOrNull() } ?: return null
        if (manga.source != source.id) return null
        return runCatching {
            val coverUrl = source.getMangaDetails(manga.copy()).thumbnail_url
                ?.let { if (it.startsWith("//")) "https:$it" else it }
                ?.takeIf { it.startsWith("http", ignoreCase = true) }
                ?: return null
            val request = Request.Builder().url(coverUrl).headers(source.headers).build()
            val response = source.client.newCall(request).await()
            if (response.isSuccessful && response.isImageLike()) response else null.also { response.close() }
        }.onFailure { Logger.w(it) { "Installed source cover fallback failed for manga $mangaId" } }
            .getOrNull()
    }

    private fun newRequest(source: HttpSource?): Request {
        val request = Request.Builder().apply {
            url(url!!)

            val sourceHeaders = source?.headers
            if (sourceHeaders != null)
                headers(sourceHeaders)
        }

        val diskRead = options.diskCachePolicy.readEnabled
        val networkRead = options.networkCachePolicy.readEnabled
        val onlyCache = !networkRead && diskRead
        val forceNetwork = networkRead && !diskRead
        val none = !networkRead && !diskRead
        when {
            onlyCache -> {
                request.cacheControl(CacheControl.FORCE_CACHE)
            }
            forceNetwork -> if (options.diskCachePolicy.writeEnabled) {
                request.cacheControl(CacheControl.FORCE_NETWORK)
            } else {
                request.cacheControl(CACHE_CONTROL_FORCE_NETWORK_NO_CACHE)
            }
            none -> {
                // This causes the request to fail with a 504 Unsatisfiable Request.
                request.cacheControl(CACHE_CONTROL_NO_NETWORK_NO_CACHE)
            }
        }

        return request.build()
    }

    private fun moveSnapshotToCoverCache(snapshot: DiskCache.Snapshot, cacheFile: File?): File? {
        if (cacheFile == null) return null
        return try {
            imageLoader.diskCache?.run {
                fileSystem.source(snapshot.data).use { input ->
                    writeSourceToCoverCache(input, cacheFile)
                }
                remove(diskCacheKey)
            }
            cacheFile.takeIf { it.exists() }
        } catch (e: Exception) {
            Logger.e(e) { "Failed to write snapshot data to cover cache ${cacheFile.name}" }
            null
        }
    }

    private fun writeResponseToCoverCache(response: Response, cacheFile: File?): File? {
        if (cacheFile == null || !options.diskCachePolicy.writeEnabled) return null
        return try {
            response.peekBody(Long.MAX_VALUE).source().use { input ->
                writeSourceToCoverCache(input, cacheFile)
            }
            cacheFile.takeIf { it.exists() }
        } catch (e: Exception) {
            Logger.e(e) { "Failed to write response data to cover cache ${cacheFile.name}" }
            null
        }
    }

    private fun writeSourceToCoverCache(input: Source, cacheFile: File) {
        cacheFile.parentFile?.mkdirs()
        cacheFile.delete()
        try {
            cacheFile.sink().buffer().use { output ->
                output.writeAll(input)
            }
        } catch (e: Exception) {
            cacheFile.delete()
            throw e
        }
    }

    private fun readFromDiskCache(): DiskCache.Snapshot? {
        return if (options.diskCachePolicy.readEnabled) {
            imageLoader.diskCache?.openSnapshot(diskCacheKey)
        } else {
            null
        }
    }

    private fun writeToDiskCache(
        response: Response,
    ): DiskCache.Snapshot? {
        val diskCache = imageLoader.diskCache
        val editor = diskCache?.openEditor(diskCacheKey) ?: return null
        try {
            diskCache.fileSystem.write(editor.data) {
                response.body.source().readAll(this)
            }
            return editor.commitAndOpenSnapshot()
        } catch (e: Exception) {
            try {
                editor.abort()
            } catch (ignored: Exception) {
            }
            throw e
        }
    }

    private fun DiskCache.Snapshot.toImageSource(): ImageSource {
        return ImageSource(
            file = data,
            fileSystem = FileSystem.SYSTEM,
            diskCacheKey = diskCacheKey,
            closeable = this,
        )
    }

    private fun setRatioAndColorsInScope(mangaId: Long?, mangaThumbnailUrl: String?, isInLibrary: Boolean, ogFile: UniFile? = null, force: Boolean = false) {
        // Browse / search consume neither dominantCoverColors nor vibrantCoverColor; MangaDetails
        // recomputes its own vibrant color. Speculatively decoding + Palette-extracting every
        // browsed cover ships the Palette callback to the main looper and stalls cold-entry frames.
        if (!isInLibrary && !force) return
        fileScope.launch {
            MangaCoverMetadata.setRatioAndColors(mangaId, mangaThumbnailUrl, isInLibrary, ogFile, force)
        }
    }

    /** Modified from [MimeTypeMap.getFileExtensionFromUrl] to be more permissive with special characters. */
    private fun MimeTypeMap.getMimeTypeFromUrl(url: String?): String? {
        if (url.isNullOrBlank()) {
            return null
        }

        val extension = url
            .substringBeforeLast('#') // Strip the fragment.
            .substringBeforeLast('?') // Strip the query.
            .substringAfterLast('/') // Get the last path segment.
            .substringAfterLast('.', missingDelimiterValue = "") // Get the file extension.

        return getMimeTypeFromExtension(extension)
    }

    private fun getResourceType(cover: String?): Type? {
        return when {
            cover.isNullOrEmpty() -> null
            cover.startsWith("http", true) ||
                cover.startsWith("Custom-", true) ||
                cover.startsWith(SuwayomiCoreThumbnailReference.SCHEME, true) -> Type.URL
            cover.startsWith("/") || cover.startsWith("file://") -> Type.File
            cover.startsWith("content") -> Type.URI
            cover.startsWith("data:", true) -> Type.DATA
            else -> null
        }
    }

    class MangaFactory(
        private val callFactoryLazy: Lazy<Call.Factory>,
    ) : Fetcher.Factory<Manga> {

        private val coverCache: CoverCache by injectLazy()
        private val sourceManager: SourceManager by injectLazy()

        override fun create(data: Manga, options: Options, imageLoader: ImageLoader): Fetcher {
            return MangaCoverFetcher(
                mangaId = data.id,
                url = data.thumbnail_url,
                isInLibrary = data.favorite,
                sourceResolver = { sourceManager.awaitExtensionSource(data.source) as? HttpSource },
                novelSourceLazy = lazy { sourceManager.get(data.source) as? NovelSource },
                options = options,
                callFactoryLazy = callFactoryLazy,
                diskCacheKeyLazy = lazy { imageLoader.components.key(data, options)!! },
                coverFileLazy = lazy { coverCache.getCoverFile(data.thumbnail_url, !data.favorite) },
                customCoverFileLazy = lazy { coverCache.getCustomCoverFile(data) },
                imageLoader = imageLoader,
                coreCoverClientLazy = lazy { get<EpigraphCoreCoverClient>() },
            )
        }
    }

    class MangaCoverFactory(
        private val callFactoryLazy: Lazy<Call.Factory>,
    ) : Fetcher.Factory<MangaCover> {

        private val coverCache: CoverCache by injectLazy()
        private val sourceManager: SourceManager by injectLazy()

        override fun create(data: MangaCover, options: Options, imageLoader: ImageLoader): Fetcher {
            return MangaCoverFetcher(
                mangaId = data.mangaId,
                url = data.url,
                isInLibrary = data.inLibrary,
                sourceResolver = { sourceManager.awaitExtensionSource(data.sourceId) as? HttpSource },
                novelSourceLazy = lazy { sourceManager.get(data.sourceId) as? NovelSource },
                options = options,
                callFactoryLazy = callFactoryLazy,
                diskCacheKeyLazy = lazy { imageLoader.components.key(data, options)!! },
                coverFileLazy = lazy { coverCache.getCoverFile(data.url, !data.inLibrary) },
                customCoverFileLazy = lazy { coverCache.getCustomCoverFile(data.mangaId) },
                imageLoader = imageLoader,
                coreCoverClientLazy = lazy { get<EpigraphCoreCoverClient>() },
            )
        }
    }

    private enum class Type {
        File, URL, URI, DATA;
    }

    companion object {
        private const val CORE_COVER_RESPONSE_URL = "https://aethon-core.invalid/cover"
        private val IMAGE_MEDIA_TYPE = "image/*".toMediaType()
        private val CACHE_CONTROL_FORCE_NETWORK_NO_CACHE = CacheControl.Builder().noCache().noStore().build()
        private val CACHE_CONTROL_NO_NETWORK_NO_CACHE = CacheControl.Builder().noCache().onlyIfCached().build()
    }
}
