package epigraph.sync.core.sourceprefs

import epigraph.contract.SourcePreferenceValue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test

/** The `pluginSettings` declarations of WTR-LAB 1.2.3, BoxNovel 2.2.2 and Komga 1.0.2. */
class AndroidNovelPluginSettingStoreTest {
    private val wtrLab = Json.parseToJsonElement(
        """
        {
          "preferredMode": {
            "value": "ai", "label": "Preferred translation", "type": "Select",
            "options": [
              {"label": "AI", "value": "ai"}, {"label": "Web+", "value": "webplus"},
              {"label": "Web", "value": "web"}, {"label": "Custom", "value": "custom"}
            ]
          },
          "fallbackToWeb": {"value": true, "label": "Fall back to web", "type": "Switch"}
        }
        """,
    ).jsonObject

    @Test
    fun `a select offers the values the plugin lists`() {
        val offered = AndroidNovelPluginSettingStore.offeredSetting(
            "preferredMode",
            wtrLab.getValue("preferredMode").jsonObject,
            JsonPrimitive("web"),
        )
        assertEquals("string", offered.valueType)
        assertEquals(listOf("ai", "webplus", "web", "custom"), offered.entryValues)
        assertEquals(SourcePreferenceValue.Text("web"), offered.current)
    }

    @Test
    fun `a switch reads only a stored boolean`() {
        val declaration = wtrLab.getValue("fallbackToWeb").jsonObject
        val stored = AndroidNovelPluginSettingStore.offeredSetting("fallbackToWeb", declaration, JsonPrimitive(false))
        assertEquals("boolean", stored.valueType)
        assertNull(stored.entryValues)
        assertEquals(SourcePreferenceValue.Flag(false), stored.current)
        assertNull(AndroidNovelPluginSettingStore.offeredSetting("fallbackToWeb", declaration, JsonPrimitive("false")).current)
        // A plugin still on its default is not compared.
        assertNull(AndroidNovelPluginSettingStore.offeredSetting("fallbackToWeb", declaration, null).current)
    }

    @Test
    fun `a field without a type is free text, as in LNReader`() {
        // Komga's server address.
        val declaration = Json.parseToJsonElement("""{"value": "", "label": "URL"}""").jsonObject
        val offered = AndroidNovelPluginSettingStore.offeredSetting("url", declaration, JsonPrimitive("http://192.168.0.5:25600"))
        assertEquals("string", offered.valueType)
        assertNull(offered.entryValues)
        assertEquals(SourcePreferenceValue.Text("http://192.168.0.5:25600"), offered.current)
    }
}
