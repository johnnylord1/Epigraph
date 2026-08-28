import java.io.File
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.file.ConfigurableFileCollection
import org.gradle.api.tasks.InputFiles
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction

abstract class VerifyNoTelemetryTask : DefaultTask() {

    @get:InputFiles
    @get:PathSensitive(PathSensitivity.RELATIVE)
    abstract val sourceFiles: ConfigurableFileCollection

    @TaskAction
    fun verify() {
        val forbiddenMarkers = listOf(
            "com.google.firebase",
            "Firebase.crashlytics",
            "CrashlyticsLogWriter",
        )
        val violations = sourceFiles.files.filter(File::isFile).filter { file ->
            file.name == "google-services.json" ||
                forbiddenMarkers.any(file.readText()::contains)
        }
        if (violations.isNotEmpty()) {
            throw GradleException(
                "Upstream telemetry is forbidden in Epigraph Mobile: " +
                    violations.joinToString { it.invariantSeparatorsPath },
            )
        }
    }
}
