import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile
import org.gradle.api.tasks.testing.Test

plugins {
    kotlin("multiplatform")
    id("com.android.kotlin.multiplatform.library")
    alias(kotlinx.plugins.serialization)
}

tasks {
    withType<KotlinCompile> {
        compilerOptions.freeCompilerArgs.addAll(
            "-Xwarning-level=DEPRECATION:disabled",
            "-Xwarning-level=OVERRIDE_DEPRECATION:disabled",
        )
    }
    withType<Test> {
        useJUnitPlatform()
    }
}

kotlin {
    android {
        namespace = "yokai.domain"
        compileSdk = AndroidConfig.COMPILE_SDK
        minSdk = AndroidConfig.MIN_SDK
        withHostTest {}
        compilerOptions {
            jvmTarget.set(JvmTarget.fromTarget(AndroidConfig.JavaVersion.toString()))
        }
    }
    sourceSets {
        commonMain {
            dependencies {
                implementation(project(":source:api"))
            }
        }
        commonTest {
            dependencies {
                implementation(libs.bundles.test)
                implementation(kotlinx.coroutines.test)
                runtimeOnly(libs.bundles.test.runtime)
            }
        }
        androidMain {
            dependencies {
            }
        }
    }
}
