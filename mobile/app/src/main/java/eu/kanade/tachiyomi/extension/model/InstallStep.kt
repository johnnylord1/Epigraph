package eu.kanade.tachiyomi.extension.model

enum class InstallStep {
    Pending, Downloading, Loading, Installing, Installed, Cancelled, Error, Done;

    fun isCompleted(): Boolean {
        return this == Installed || this == Cancelled || this == Error || this == Done
    }
}
