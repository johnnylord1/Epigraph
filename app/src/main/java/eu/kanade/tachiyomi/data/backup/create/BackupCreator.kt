package eu.kanade.tachiyomi.data.backup.create

import yokai.util.koin.get
import android.content.Context
import android.net.Uri
import co.touchlab.kermit.Logger
import com.hippo.unifile.UniFile
import epigraph.books.local.LocalBookRepository
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.data.backup.BackupContainer
import eu.kanade.tachiyomi.data.backup.BackupFileValidator
import eu.kanade.tachiyomi.data.backup.models.BackupCategory
import eu.kanade.tachiyomi.data.backup.models.BackupLocalBook
import eu.kanade.tachiyomi.data.backup.models.BackupManga
import eu.kanade.tachiyomi.data.backup.models.BackupPreference
import eu.kanade.tachiyomi.data.backup.models.BackupSource
import eu.kanade.tachiyomi.data.backup.models.BackupSourcePreferences
import eu.kanade.tachiyomi.data.backup.create.creators.CategoriesBackupCreator
import eu.kanade.tachiyomi.data.backup.create.creators.MangaBackupCreator
import eu.kanade.tachiyomi.data.backup.create.creators.LocalBookBackupCreator
import eu.kanade.tachiyomi.data.backup.create.creators.PreferenceBackupCreator
import eu.kanade.tachiyomi.data.backup.create.creators.SourcesBackupCreator
import eu.kanade.tachiyomi.data.backup.models.Backup
import eu.kanade.tachiyomi.domain.manga.models.Manga
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import java.util.zip.GZIPOutputStream
import kotlinx.serialization.protobuf.ProtoBuf
import okio.buffer
import okio.gzip
import okio.sink
import yokai.domain.backup.BackupPreferences
import yokai.domain.manga.interactor.GetManga
import yokai.i18n.MR
import yokai.util.lang.getString

private const val PARTIAL_SUFFIX = ".part"

class BackupCreator(
    val context: Context,
    private val categoriesBackupCreator: CategoriesBackupCreator = CategoriesBackupCreator(),
    private val mangaBackupCreator: MangaBackupCreator = MangaBackupCreator(),
    private val preferenceBackupCreator: PreferenceBackupCreator = PreferenceBackupCreator(),
    private val sourcesBackupCreator: SourcesBackupCreator = SourcesBackupCreator(),
    private val localBookBackupCreator: LocalBookBackupCreator = LocalBookBackupCreator(),
    private val getManga: GetManga = get(),
    private val localBookRepository: LocalBookRepository = get(),
) {

    val parser = ProtoBuf
    private val backupPreferences: BackupPreferences = get()

    /** Library entries written by the last successful [createBackup]; UI only (the moment's count). */
    var lastEntryCount = 0
        private set

    /**
     * Create backup Json file from database
     *
     * @param uri path of Uri
     * @param isAutoBackup backup called from scheduled backup job
     */
    suspend fun createBackup(uri: Uri, options: BackupOptions, isAutoBackup: Boolean): String {
        var file: UniFile? = null
        try {
            val directory = if (isAutoBackup) {
                UniFile.fromUri(context, uri) ?: throw IllegalStateException("Unable to retrieve backup destination")
            } else {
                null
            }
            val finalName = Backup.getBackupFilename()
            file = if (directory != null) {
                // Automatic backups are written under a name the rotation never matches, verified
                // and only then renamed into place, so a crash cannot leave a truncated backup that
                // later replaces a good one. Leftovers from an interrupted run are removed first.
                directory.listFiles { _, filename -> filename.endsWith(PARTIAL_SUFFIX) }
                    .orEmpty()
                    .forEach { it.delete() }
                directory.createFile(finalName + PARTIAL_SUFFIX)
            } else {
                UniFile.fromUri(context, uri)
            } ?: throw IllegalStateException("Unable to retrieve backup destination")

            if (!file.isFile) {
                throw IllegalStateException("Invalid backup destination")
            }

            val readNotFavorites = if (options.readManga) getManga.awaitReadNotFavorites() else emptyList()
            val backupManga = backupMangas(getManga.awaitFavorites() + readNotFavorites, options)
            val backup = Backup(
                backupManga = backupManga,
                backupCategories = backupCategories(options),
                backupSources = backupSources(backupManga),
                backupPreferences = backupAppPreferences(options),
                backupSourcePreferences = backupSourcePreferences(options),
                backupLocalBooks = backupLocalBooks(options),
            )

            val byteArray = parser.encodeToByteArray(Backup.serializer(), backup)
            if (byteArray.isEmpty()) {
                throw IllegalStateException(context.getString(MR.strings.empty_backup_error))
            }

            val bookFiles = if (options.bookFiles) storedBookFiles(backup.backupLocalBooks) else emptyList()
            val output = file.openOutputStream().also {
                // Force overwrite old file
                (it as? FileOutputStream)?.channel?.truncate(0)
            }
            if (bookFiles.isEmpty()) {
                output.sink().gzip().buffer().use { it.write(byteArray) }
            } else {
                // Book files need the unified container; the backup itself stays a gzipped payload.
                val gzipped = ByteArrayOutputStream().also { bytes ->
                    GZIPOutputStream(bytes).use { it.write(byteArray) }
                }.toByteArray()
                output.buffered().use {
                    BackupContainer.write(
                        output = it,
                        gzippedBackup = gzipped,
                        books = bookFiles,
                        sourceFilename = finalName.substringBeforeLast('.') + ".tachibk",
                        appVersion = BuildConfig.VERSION_NAME,
                    )
                }
            }

            // Make sure it's a valid backup file
            BackupFileValidator().validate(context, file.uri)
            lastEntryCount = backup.backupManga.size + backup.backupLocalBooks.size

            if (directory != null) {
                directory.findFile(finalName)?.delete()
                if (!file.renameTo(finalName)) {
                    throw IllegalStateException("Unable to finalize backup file")
                }
                val finalFile = directory.findFile(finalName)
                    ?: throw IllegalStateException("Unable to finalize backup file")
                file = finalFile

                // Rotate only after the new backup is in place; a failed cleanup keeps extra files
                // instead of failing (and deleting) the backup that was just finalized.
                runCatching {
                    val numberOfBackups = backupPreferences.numberOfBackups().get().coerceAtLeast(1)
                    directory.listFiles { _, filename -> Backup.filenameRegex.matches(filename) }
                        .orEmpty()
                        .filter { it.name != finalName }
                        .sortedByDescending { it.name }
                        .drop(numberOfBackups - 1)
                        .forEach { it.delete() }
                }.onFailure { Logger.w(it) { "Unable to rotate old backups" } }

                backupPreferences.lastAutoBackupTimestamp().set(Instant.now().toEpochMilli())
            }

            return file.uri.toString()
        } catch (e: Exception) {
            Logger.e(e) { "Backup failed: ${e.message}" }
            file?.delete()
            throw e
        }
    }

    private suspend fun backupCategories(options: BackupOptions): List<BackupCategory> {
        if (!options.categories) return emptyList()

        return categoriesBackupCreator()
    }

    private suspend fun backupMangas(mangas: List<Manga>, options: BackupOptions): List<BackupManga> {
        if (!options.libraryEntries) return emptyList()

        return mangaBackupCreator(mangas, options)
    }

    private fun backupSources(mangas: List<BackupManga>): List<BackupSource> {
        return sourcesBackupCreator(mangas)
    }

    private fun backupAppPreferences(options: BackupOptions): List<BackupPreference> {
        if (!options.appPrefs) return emptyList()

        return preferenceBackupCreator.createApp()
    }

    private fun backupSourcePreferences(options: BackupOptions): List<BackupSourcePreferences> {
        if (!options.sourcePrefs) return emptyList()

        return preferenceBackupCreator.createSource()
    }

    /** The private files of the backed-up local books that are present on this device. */
    private suspend fun storedBookFiles(books: List<BackupLocalBook>): List<BackupContainer.LocalBookFile> =
        books.mapNotNull { backupBook ->
            val book = localBookRepository.find(backupBook.bookId)?.takeIf { it.isAvailable } ?: return@mapNotNull null
            BackupContainer.LocalBookFile(book.sha256, book.contentType.name, File(book.privatePath))
        }

    private suspend fun backupLocalBooks(options: BackupOptions): List<BackupLocalBook> {
        if (!options.libraryEntries) return emptyList()
        return localBookBackupCreator(options.categories)
    }
}
