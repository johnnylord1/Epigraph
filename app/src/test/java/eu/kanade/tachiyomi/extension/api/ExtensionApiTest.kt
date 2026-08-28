package eu.kanade.tachiyomi.extension.api

import eu.kanade.tachiyomi.extension.model.Extension
import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Test

class ExtensionApiTest {
    @Test
    fun `modern repository accepts string version and source ids`() {
        val index = Json { ignoreUnknownKeys = true }.decodeFromString<ExtensionIndexJson>(INDEX)

        val available = index.toExtensions("https://repo.example/extensions")

        assertEquals(1, available.size)
        val extension = available.single()
        assertEquals("eu.kanade.tachiyomi.extension.en.fixture", extension.pkgName)
        assertEquals(66L, extension.versionCode)
        assertEquals(listOf(6247824327199706550L), extension.sources.map { it.id })
        assertNotNull(extension.apkName)
        assertEquals(
            "https://repo.example/extensions/apk/fixture.apk",
            extension.apkName,
        )
    }

    private companion object {
        val INDEX = """
            {
              "extensionList": {
                "extensions": [{
                  "name": "Tachiyomi: Fixture",
                  "packageName": "eu.kanade.tachiyomi.extension.en.fixture",
                  "resources": {
                    "apkUrl": "https://repo.example/extensions/apk/fixture.apk",
                    "iconUrl": "https://repo.example/extensions/icon/fixture.png"
                  },
                  "extensionLib": "1.6",
                  "versionCode": "66",
                  "versionName": "1.6.66",
                  "sources": [{
                    "id": "6247824327199706550",
                    "name": "Fixture",
                    "language": "en",
                    "homeUrl": "https://fixture.example"
                  }]
                }]
              }
            }
        """.trimIndent()
    }
}
