package yokai.core.di

import android.app.Application
import androidx.sqlite.db.SupportSQLiteDatabase
import app.cash.sqldelight.db.SqlDriver
import app.cash.sqldelight.driver.android.AndroidSqliteDriver
import epigraph.books.importing.LocalBookPrivateImporter
import epigraph.books.local.LocalBookImportService
import epigraph.books.local.LocalBookRepository
import epigraph.books.local.LocalBookRepositoryImpl
import epigraph.books.reader.BookStructureInspector
import epigraph.books.pdf.PdfiumPdfReaderAdapter
import epigraph.books.reader.PdfReaderAdapter
import epigraph.books.reader.EpubReaderAdapter
import epigraph.books.reader.ValidatedEpubReaderAdapter
import epigraph.books.reader.BookReaderRouter
import co.touchlab.kermit.Logger
import com.chuckerteam.chucker.api.ChuckerCollector
import com.chuckerteam.chucker.api.ChuckerInterceptor
import eu.kanade.tachiyomi.BuildConfig
import eu.kanade.tachiyomi.core.storage.AndroidStorageFolderProvider
import eu.kanade.tachiyomi.data.cache.ChapterCache
import eu.kanade.tachiyomi.data.cache.CoverCache
import eu.kanade.tachiyomi.data.download.DownloadCache
import eu.kanade.tachiyomi.data.download.DownloadManager
import eu.kanade.tachiyomi.data.download.DownloadProvider
import eu.kanade.tachiyomi.data.library.CustomMangaManager
import eu.kanade.tachiyomi.data.track.TrackManager
import eu.kanade.tachiyomi.data.translation.TranslationCache
import eu.kanade.tachiyomi.data.translation.TranslationEngineManager
import eu.kanade.tachiyomi.data.translation.TranslationService
import eu.kanade.tachiyomi.extension.ExtensionManager
import eu.kanade.tachiyomi.network.JavaScriptEngine
import eu.kanade.tachiyomi.network.NetworkHelper
import eu.kanade.tachiyomi.source.SourceManager
import eu.kanade.tachiyomi.util.chapter.ChapterFilter
import eu.kanade.tachiyomi.util.manga.MangaShortcutManager
import io.requery.android.database.sqlite.RequerySQLiteOpenHelperFactory
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.protobuf.ProtoBuf
import java.io.File
import nl.adaptivity.xmlutil.XmlDeclMode
import nl.adaptivity.xmlutil.core.XmlVersion
import nl.adaptivity.xmlutil.serialization.XML
import org.koin.dsl.module
import tachiyomi.data.Chapters
import tachiyomi.data.Mangas
import yokai.data.AndroidDatabaseHandler
import yokai.data.Database
import yokai.data.DatabaseHandler
import yokai.data.memoColumnAdapter
import yokai.domain.storage.StorageManager

fun appModule(app: Application) = module {
    single { app }

    single<SqlDriver> {
        AndroidSqliteDriver(
            schema = Database.Schema,
            context = app,
            name = "tachiyomi.db",
            // factory = if (BuildConfig.DEBUG && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            //     // Support database inspector in Android Studio
            //     FrameworkSQLiteOpenHelperFactory()
            // } else {
            //     RequerySQLiteOpenHelperFactory()
            // },
            factory = RequerySQLiteOpenHelperFactory(),
            callback = object : AndroidSqliteDriver.Callback(Database.Schema) {
                override fun onOpen(db: SupportSQLiteDatabase) {
                    super.onOpen(db)
                    ensureLocalBookStructureColumns(db)
                    setPragma(db, "foreign_keys = ON")
                    setPragma(db, "journal_mode = WAL")
                    setPragma(db, "synchronous = NORMAL")
                }

                private fun setPragma(db: SupportSQLiteDatabase, pragma: String) {
                    db.query("PRAGMA $pragma").use { cursor ->
                        cursor.moveToFirst()
                    }
                }

                // Not sure if this is still needed, but just in case
                override fun onConfigure(db: SupportSQLiteDatabase) {
                    db.setForeignKeyConstraintsEnabled(true)
                }

                override fun onCreate(db: SupportSQLiteDatabase) {
                    Logger.d { "Creating new database..." }
                    super.onCreate(db)
                }

                override fun onUpgrade(db: SupportSQLiteDatabase, oldVersion: Int, newVersion: Int) {
                    if (oldVersion < newVersion) {
                        Logger.d { "Upgrading database from $oldVersion to $newVersion" }
                        super.onUpgrade(db, oldVersion, newVersion)
                    }
                    // Some development databases were already at v52 when the
                    // structure columns were added to 52.sqm.  The generated
                    // migration cannot express ADD COLUMN IF NOT EXISTS, so
                    // repair that legacy shape after SQLDelight's migrations
                    // have run and before any generated query is executed.
                    ensureLocalBookStructureColumns(db)
                }

                private fun ensureLocalBookStructureColumns(db: SupportSQLiteDatabase) {
                    val columns = buildSet {
                        db.query("PRAGMA table_info(local_books)").use { cursor ->
                            val nameIndex = cursor.getColumnIndex("name")
                            if (nameIndex >= 0) {
                                while (cursor.moveToNext()) add(cursor.getString(nameIndex))
                            }
                        }
                    }
                    if (columns.isEmpty()) return
                    if ("chapter_count" !in columns) {
                        db.execSQL("ALTER TABLE local_books ADD COLUMN chapter_count INTEGER")
                    }
                    if ("page_count" !in columns) {
                        db.execSQL("ALTER TABLE local_books ADD COLUMN page_count INTEGER")
                    }
                }
            },
        )
    }

    single {
        Database(
            driver = get(),
            mangasAdapter = Mangas.Adapter(
                memoAdapter = memoColumnAdapter,
            ),
            chaptersAdapter = Chapters.Adapter(
                memoAdapter = memoColumnAdapter,
            ),
        )
    }
    single<DatabaseHandler> { AndroidDatabaseHandler(get(), get()) }

    single { ChapterCache(app) }

    single { CoverCache(app) }

    single {
        NetworkHelper(
            app,
            get(),
        ) { builder ->
            if (BuildConfig.DEBUG) {
                builder.addInterceptor(
                    ChuckerInterceptor.Builder(app)
                        .collector(ChuckerCollector(app))
                        .maxContentLength(250000L)
                        .redactHeaders(emptySet())
                        .alwaysReadResponseBody(false)
                        .build(),
                )
            }
        }
    }

    single { JavaScriptEngine(app) }

    single { SourceManager(app, get(), get()) }
    single { ExtensionManager(app) }

    single { DownloadProvider(app) }
    single { DownloadManager(app) }
    single { DownloadCache(app) }

    single { CustomMangaManager(app) }

    single { TrackManager(app) }

    single { TranslationCache(app, get()) }
    single { TranslationEngineManager(get()) }
    single { TranslationService(app, get(), get(), get(), get(), get(), get()) }

    single {
        Json {
            ignoreUnknownKeys = true
            explicitNulls = false
        }
    }
    single {
        XML {
            defaultPolicy {
                ignoreUnknownChildren()
            }
            autoPolymorphic = true
            xmlDeclMode = XmlDeclMode.Charset
            indent = 2
            xmlVersion = XmlVersion.XML10
        }
    }
    single<ProtoBuf> {
        ProtoBuf
    }

    single { ChapterFilter() }

    single { MangaShortcutManager() }

    single { AndroidStorageFolderProvider(app) }
    single { StorageManager(app, get()) }

    // Local publications are deliberately independent from the Core/Syncd stack. They are
    // content-addressed in the app-private directory and only become visible after validation.
    single { LocalBookPrivateImporter(File(app.filesDir, "books")) }
    single<LocalBookRepository> {
        LocalBookRepositoryImpl(
            handler = get(),
            mutations = get(),
            privateStorageDirectory = File(app.filesDir, "books"),
            structureInspector = BookStructureInspector(app),
        )
    }
    single { LocalBookImportService(app.contentResolver, get(), get(), get(), get()) }
    single<PdfReaderAdapter> { PdfiumPdfReaderAdapter(app) }
    single<EpubReaderAdapter> { ValidatedEpubReaderAdapter(app) }
    single { BookReaderRouter(get(), get()) }
}

// REF: https://github.com/jobobby04/TachiyomiSY/blob/26cfb4811fef4059fb7e8e03361c141932fec6b5/app/src/main/java/eu/kanade/tachiyomi/di/AppModule.kt#L177C1-L192C2
fun initExpensiveComponents(app: Application) {
    // Asynchronously init expensive components on IO so cold start does not block the main thread.
    CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
        val koin = org.koin.core.context.GlobalContext.get()
        // Remove only abandoned, unpublished book imports. Final content-addressed EPUB/PDF
        // blobs are never touched by this maintenance pass.
        runCatching {
            koin.get<LocalBookPrivateImporter>().cleanupAbandonedParts(
                System.currentTimeMillis() - 24L * 60L * 60L * 1_000L,
            )
        }
        runCatching {
            val report = koin.get<LocalBookRepository>().repairExistingBooks()
            if (report.repaired > 0 || report.unavailable > 0) {
                co.touchlab.kermit.Logger.i {
                    "Local book maintenance: inspected=${report.inspected}, repaired=${report.repaired}, " +
                        "covers=${report.coversMaterialized}, metadata=${report.metadataUpdated}, " +
                        "unavailable=${report.unavailable}"
                }
            }
        }.onFailure { failure ->
            co.touchlab.kermit.Logger.w(failure) { "Local book maintenance failed" }
        }
        koin.get<NetworkHelper>()
        koin.get<SourceManager>()
        koin.get<Database>()
        koin.get<DownloadManager>()
        koin.get<CustomMangaManager>()
    }
}
