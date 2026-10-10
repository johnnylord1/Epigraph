package eu.kanade.tachiyomi.data.updater

import android.os.Build
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Release object.
 * Contains information about the latest release from GitHub.
 *
 * @param version version of latest release.
 * @param info log of latest release.
 * @param assets assets of latest release.
 */
@Serializable
data class GithubRelease(
    @SerialName("tag_name") val version: String,
    @SerialName("body") val info: String,
    @SerialName("html_url") val releaseLink: String,
    @SerialName("prerelease") val preRelease: Boolean?,
    @SerialName("assets") private val assets: List<Assets>,
) {

    /**
     * Version of the Android app in this release. Releases are tagged with the desktop version,
     * so the app version comes from the APK names (`Epigraph-mobile_<version>_<abi>.apk`).
     * Null when the release carries no Android build.
     */
    val mobileVersion: String?
        get() = assets.firstNotNullOfOrNull { MOBILE_APK.find(it.downloadLink.substringAfterLast('/')) }
            ?.groupValues?.get(1)

    /**
     * Changes of the Android app. Release notes list the Windows and Android changes under their
     * own `## Windows` and `## Android` headings; notes without an Android heading are shown whole.
     */
    val changelog: String
        get() {
            val lines = info.lines()
            val start = lines.indexOfFirst { ANDROID_HEADING.containsMatchIn(it) }
            if (start < 0) return info.trim()
            val section = lines.drop(start + 1).takeWhile { !it.startsWith("## ") }
            return section.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
        }

    /**
     * Get download link of latest release from the assets.
     * @return download link of latest release.
     */
    val downloadLink: String
        get() {
            val abi = Build.SUPPORTED_ABIS[0]
            val apks = assets.filter { it.downloadLink.endsWith(".apk", ignoreCase = true) }
            return apks.find { it.downloadLink.endsWith("_$abi.apk") }?.downloadLink
                ?: apks.find { it.downloadLink.endsWith("_universal.apk") }?.downloadLink
                // Releases published before the rebrand can still be installed manually.
                ?: apks.find { it.downloadLink.contains("aethon-$abi-") }?.downloadLink
                ?: apks.find { it.downloadLink.contains("hayai-$abi-") }?.downloadLink
                ?: apks.firstOrNull()?.downloadLink
                ?: assets[0].downloadLink
        }

    /**
     * Assets class containing download url.
     * @param downloadLink download url.
     */
    @Serializable
    data class Assets(@SerialName("browser_download_url") val downloadLink: String)
}

private val MOBILE_APK = Regex("""^Epigraph-mobile_(.+)_[^_]+\.apk$""")
private val ANDROID_HEADING = Regex("""^##\s+android\b""", RegexOption.IGNORE_CASE)
