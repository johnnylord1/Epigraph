import java.io.File
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.Properties
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    id("yokai.android.application")
    id("yokai.android.application.compose")
    alias(kotlinx.plugins.serialization)
    alias(kotlinx.plugins.parcelize)
}

fun runCommand(command: String): String {
    val result = providers.exec { commandLine(command.split(" ")) }
    return result.standardOutput.asText.get().trim()
}

@Suppress("PropertyName")
// epigraph.versionName only exists to build an older-looking APK that exercises the in-app
// updater against the published release; published builds always use the default.
val _versionName = providers.gradleProperty("epigraph.versionName").orNull ?: "0.1.0-alpha.6"
val betaCount by lazy {
    val betaTags = runCommand("git tag -l --sort=refname v${_versionName}-b*")

    if (betaTags.isNotEmpty()) {
        val betaTag = betaTags.split("\n").last().substringAfter("-b").toIntOrNull()
        ((betaTag ?: 0) + 1)
    } else {
        1
    }.toString()
}
val commitCount by lazy { runCommand("git rev-list --count HEAD") }
val commitHash by lazy { runCommand("git rev-parse --short HEAD") }
val buildTime: String by lazy {
    val df = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'")
    LocalDateTime.now(ZoneOffset.UTC).format(df)
}

// Production signing material is deliberately kept outside this repository. The default path
// follows the local developer's secrets directory, while CI/release jobs can point at a protected
// file with -Pepigraph.signing.properties or EPIGRAPH_SIGNING_PROPERTIES. Keeping this optional lets
// contributors build debug variants without access to the private release key; release jobs can
// opt into a fail-closed gate with -Pepigraph.requireSigning=true.
val signingPropertiesPath = providers.gradleProperty("epigraph.signing.properties").orNull
    ?: providers.environmentVariable("EPIGRAPH_SIGNING_PROPERTIES").orNull
    ?: File(System.getProperty("user.home"), "secrets/epigraph-keystore.properties").path
val signingPropertiesFile = File(signingPropertiesPath)
val signingProperties = Properties().apply {
    if (signingPropertiesFile.isFile) {
        signingPropertiesFile.inputStream().use(::load)
    }
}
val signingStoreFile = signingProperties.getProperty("storeFile")?.let { path ->
    val candidate = File(path)
    if (candidate.isAbsolute) candidate else File(signingPropertiesFile.parentFile, path)
}
val hasEpigraphReleaseSigning = signingStoreFile?.isFile == true &&
    !signingProperties.getProperty("storePassword").isNullOrBlank() &&
    !signingProperties.getProperty("keyAlias").isNullOrBlank() &&
    !signingProperties.getProperty("keyPassword").isNullOrBlank()
val requireEpigraphReleaseSigning = providers.gradleProperty("epigraph.requireSigning").orNull
    ?.toBoolean() == true || providers.environmentVariable("EPIGRAPH_REQUIRE_SIGNING").orNull
    ?.toBoolean() == true

if (requireEpigraphReleaseSigning && !hasEpigraphReleaseSigning) {
    error(
        "Epigraph release signing is required, but no valid keystore was found. " +
            "Provide -Pepigraph.signing.properties=<path> (or EPIGRAPH_SIGNING_PROPERTIES) " +
            "with storeFile, storePassword, keyAlias and keyPassword.",
    )
}

val supportedAbis = setOf("armeabi-v7a", "arm64-v8a", "x86", "x86_64")

android {
    testOptions {
        unitTests.isReturnDefaultValues = true
        // Robolectric screenshot tests (Roborazzi) need the merged resources, themes and menus.
        unitTests.isIncludeAndroidResources = true
        unitTests.all { test ->
            // `./gradlew :app:testDevDebugUnitTest -Proborazzi.record=true` writes the screenshots to
            // app/build/outputs/roborazzi; without it the screenshot tests only render.
            test.systemProperty(
                "roborazzi.test.record",
                providers.gradleProperty("roborazzi.record").getOrElse("false"),
            )
            // Roborazzi's native renderer needs Java 21; on older JVMs (CI runs Java 17) the screenshots are skipped.
            if (!org.gradle.api.JavaVersion.current().isCompatibleWith(org.gradle.api.JavaVersion.VERSION_21)) {
                test.exclude("**/*ScreenshotTest*")
            }
        }
    }
    defaultConfig {
        applicationId = "app.epigraph.mobile"
        versionCode = 6
        versionName = _versionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "COMMIT_COUNT", "\"${commitCount}\"")
        buildConfigField("String", "BETA_COUNT", "\"${betaCount}\"")
        buildConfigField("String", "COMMIT_SHA", "\"${commitHash}\"")
        buildConfigField("String", "BUILD_TIME", "\"${buildTime}\"")
        buildConfigField("Boolean", "INCLUDE_UPDATER", "false")
        buildConfigField("Boolean", "BETA", "false")
        buildConfigField("Boolean", "NIGHTLY", "false")

        ndk {
            // False positive, we have x86 abi support
            //noinspection ChromeOsAbiSupport
            abiFilters += supportedAbis
        }
    }

    splits {
        abi {
            isEnable = true
            reset()
            // False positive, we have x86 abi support
            //noinspection ChromeOsAbiSupport
            include(*supportedAbis.toTypedArray())
            isUniversalApk = true
        }
    }

    signingConfigs {
        if (hasEpigraphReleaseSigning) {
            create("epigraphRelease") {
                storeFile = signingStoreFile
                storePassword = signingProperties.getProperty("storePassword")
                keyAlias = signingProperties.getProperty("keyAlias")
                keyPassword = signingProperties.getProperty("keyPassword")
                storeType = signingProperties.getProperty("storeType", "PKCS12")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-d${commitCount}"
        }
        // Internal emulator/device build: keeps debug tooling and fast packaging without the R8 cost
        // of a release build. It installs beside the release under its own application id, so local
        // verification never reads or writes the release installation's library, pairing or settings
        // (the desktop debug build keeps the same rule with its own data folder and Core port).
        create("local") {
            initWith(getByName("debug"))
            applicationIdSuffix = ".local"
            versionNameSuffix = "-local${commitCount}"
            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks.add("debug")
        }
        getByName("release") {
            applicationIdSuffix = null
            isShrinkResources = true
            isMinifyEnabled = true
            proguardFiles("proguard-android-optimize.txt", "proguard-rules.pro")
            if (hasEpigraphReleaseSigning) {
                signingConfig = signingConfigs.getByName("epigraphRelease")
            }
        }
        create("beta") {
            initWith(getByName("release"))
            buildConfigField("boolean", "BETA", "true")

            if (hasEpigraphReleaseSigning) {
                signingConfig = signingConfigs.getByName("epigraphRelease")
            }
            matchingFallbacks.add("release")
            versionNameSuffix = "-b${betaCount}"
            applicationIdSuffix = ".beta"
        }
        create("nightly") {
            initWith(getByName("release"))
            buildConfigField("boolean", "BETA", "true")
            buildConfigField("boolean", "NIGHTLY", "true")

            signingConfig = signingConfigs.getByName("debug")
            matchingFallbacks.add("release")
            versionNameSuffix = "-r${commitCount}"
            applicationIdSuffix = ".nightly"
        }
    }

    buildFeatures {
        viewBinding = true
        // If you're here because there's not BuildConfig, build the app first, it'll generate it for you
        buildConfig = true

        // Disable some unused things
        aidl = false
        shaders = false
    }

    packaging {
        jniLibs {
            keepDebugSymbols.addAll(
                listOf(
                    "**/libandroidx.graphics.path.so",
                    "**/libarchive-jni.so",
                    "**/libconscrypt_jni.so",
                    "**/libdatastore_shared_counter.so",
                    "**/libimagedecoder.so",
                    "**/libquickjs.so",
                    "**/libsqlite3x.so",
                )
            )
        }
    }

    flavorDimensions.add("default")

    productFlavors {
        create("standard") {
            // Updates come from the Epigraph GitHub releases, whose APKs carry the Epigraph release key.
            buildConfigField("Boolean", "INCLUDE_UPDATER", "true")
            dimension = "default"
        }
        create("dev") {
            // No locale filter here: `androidResources` in a flavor block resolves to the module-wide
            // `android.androidResources`, so an "en" filter stripped every translation from all builds,
            // release included.
            dimension = "default"
        }
    }

    lint {
        disable.addAll(listOf("MissingTranslation", "ExtraTranslation"))
        // Lint is a release gate. Only the two intentional translation checks stay disabled;
        // no baseline or `checkOnly` shortcut is used to hide UAST failures.
        abortOnError = true
        checkReleaseBuilds = true
        // Test sources never ship; analyzing them exhausted the CI runner (lintAnalyzeDevDebugUnitTest).
        ignoreTestSources = true
    }

    namespace = "eu.kanade.tachiyomi"
}

dependencies {
    implementation(project(":core:archive"))
    implementation(project(":core:main"))
    implementation(project(":data"))
    implementation(project(":domain"))
    implementation(project(":i18n"))
    implementation(project(":presentation:core"))
    implementation(project(":source:api"))

    // Compose
    implementation(platform(compose.bom))
    implementation(compose.bundles.compose)
    debugImplementation(compose.ui.tooling)
    "localImplementation"(compose.ui.tooling)
    implementation(libs.compose.theme.adapter3)
    implementation(compose.webview)

    // EXH -->
    implementation(libs.accompanist.webview)
    // EXH <--

    implementation(libs.flexbox)

    implementation(libs.material)

    // Android X libraries
    implementation(androidx.bundles.androidx)
    implementation(androidx.profileinstaller)

    // ReactiveX
    implementation(libs.rxandroid)
    implementation(libs.rxjava)
    implementation(libs.rxrelay)

    // Chucker
    debugImplementation(libs.chucker.library)
    "localImplementation"(libs.chucker.library)
    releaseImplementation(libs.chucker.library.no.op)
    "nightlyImplementation"(libs.chucker.library.no.op)
    "betaImplementation"(libs.chucker.library.no.op)

    implementation(kotlin("reflect", version = kotlinx.versions.kotlin.get()))

    // JSON
    implementation(kotlinx.bundles.serialization)

    // JavaScript engine. `com.dokar.quickjs.QuickJs` is the in-app runtime; an
    // `app.cash.quickjs.QuickJs` shim in this module routes the legacy Cash-App
    // surface (used by Mangago, MangaHere, Readcomiconline, etc.) onto the same
    // native engine so we ship only one libquickjs.so.
    implementation(libs.quickjs.android)

    // Local publication readers. They are hidden behind epigraph.books.reader adapters so the
    // rest of the application does not depend on engine-specific types.
    implementation(libs.readium.shared)
    implementation(libs.readium.streamer)
    // The navigator AAR embeds the PhotoView classes used by both the EPUB navigator and the
    // existing manga reader. Do not add the standalone PhotoView artifact below as well.
    implementation(libs.readium.navigator)
    implementation(libs.ahmer.pdfium)
    // Optional on-device OCR for scanned PDF pages. The reader only invokes it when Pdfium has
    // no text layer, so normal textual PDFs do not pay the recognition cost.
    implementation(libs.mlkit.text.recognition)

    // Disk
    implementation(libs.disklrucache)

    // HTML parser
    implementation(libs.jsoup)

    // Fuzzy string matching (app-wide search)
    implementation(libs.fuzzywuzzy)

    // Markdown parser (used by novel reader for .md chapter content)
    implementation(libs.markdown)

    implementation(libs.play.services.gcm)

    // Database
    implementation(libs.sqlite.android)
    implementation(libs.bundles.sqlite)

    // Dependency injection
    implementation(platform(libs.koin.bom))
    implementation(libs.koin.android)

    // Model View Presenter
    implementation(libs.conductor)
    implementation(libs.conductor.support.preference)

    // Image library
    implementation(platform(libs.coil3.bom))
    implementation(libs.bundles.coil)
    implementation(libs.subsamplingscaleimageview) {  // modified
        exclude(module = "image-decoder")
    }
    implementation(libs.image.decoder)

    // Sort
    implementation(libs.java.nat.sort)

    implementation(libs.aboutlibraries)

    // UI
    implementation(libs.fastadapter)
    implementation(libs.fastadapter.extensions.binding)
    implementation(libs.flexible.adapter)
    implementation(libs.flexible.adapter.ui)
    implementation(libs.viewstatepageradapter)
    implementation(libs.slice)
    implementation(libs.markwon)

    implementation(libs.directionalviewpager)
    implementation(libs.viewtooltip)
    implementation(libs.taptargetview)
    implementation(libs.zxing.embedded)

    // Navigation
    implementation(libs.bundles.voyager)

    // Shizuku
    implementation(libs.shizuku.api)
    implementation(libs.shizuku.provider)

    implementation(platform(kotlinx.coroutines.bom))
    implementation(kotlinx.bundles.coroutines)

    // TLS 1.3 support for Android < 10
    implementation(libs.conscrypt)

    // Android Chart
    implementation(libs.mpandroidchart)

    implementation(kotlinx.immutable)

    // Tests
    testImplementation(libs.bundles.test)
    testRuntimeOnly(libs.bundles.test.runtime)
    androidTestImplementation(libs.bundles.test.android)
    testImplementation(kotlinx.coroutines.test)
    testImplementation(libs.sqldelight.sqlite.driver)
    // Screenshot tests on the JVM: Robolectric renders, Roborazzi captures. JUnit 4 runs on the vintage engine.
    testImplementation(libs.robolectric)
    testImplementation(libs.roborazzi)
    testRuntimeOnly(libs.junit.vintage)

    // For detecting memory leaks
    // REF: https://square.github.io/leakcanary/
    debugImplementation(libs.leakcanary.android)
    "localImplementation"(libs.leakcanary.android)
    implementation(libs.leakcanary.plumber)
}

tasks {
    val verifyNoUpstreamTelemetry = register<VerifyNoTelemetryTask>("verifyNoUpstreamTelemetry") {
        group = "verification"
        description = "Fails when upstream telemetry code or Firebase configuration is reintroduced."

        sourceFiles.from(fileTree(projectDir) {
            include("src/**/*.kt", "src/**/*.kts", "src/**/google-services.json")
        })
    }

    // See https://kotlinlang.org/docs/reference/experimental.html#experimental-status-of-experimental-api(-markers)
    withType<KotlinCompile> {
        compilerOptions.freeCompilerArgs.addAll(
            // "-opt-in=kotlin.Experimental",
            "-opt-in=kotlin.RequiresOptIn",
            "-opt-in=kotlin.ExperimentalStdlibApi",
            "-opt-in=coil3.annotation.ExperimentalCoilApi",
            "-opt-in=androidx.compose.foundation.layout.ExperimentalLayoutApi",
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3Api",
            "-opt-in=androidx.compose.material3.ExperimentalMaterial3ExpressiveApi",
            "-opt-in=androidx.compose.ui.ExperimentalComposeUiApi",
            "-opt-in=androidx.compose.foundation.ExperimentalFoundationApi",
            "-opt-in=androidx.compose.animation.ExperimentalAnimationApi",
            // "-opt-in=com.google.accompanist.permissions.ExperimentalPermissionsApi",
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
            "-opt-in=kotlinx.coroutines.FlowPreview",
            "-opt-in=kotlinx.coroutines.ExperimentalCoroutinesApi",
            "-opt-in=kotlinx.coroutines.InternalCoroutinesApi",
            "-opt-in=kotlinx.serialization.ExperimentalSerializationApi",
        )
    }

    // Duplicating Hebrew string assets due to some locale code issues on different devices
    val copyHebrewStrings = register("copyHebrewStrings", type = Copy::class) {
        from("./src/main/res/values-he")
        into("./src/main/res/values-iw")
        include("**/*")
    }

    preBuild {
        dependsOn(
            // formatKotlin,
            copyHebrewStrings,
            verifyNoUpstreamTelemetry,
        )
    }
}
