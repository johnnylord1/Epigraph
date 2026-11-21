package epigraph.contract

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import org.junit.jupiter.api.Test

/** Uses the settings the real LNReader plugins declare: WTR-LAB, Komga and BoxNovel. */
class NovelPluginSettingRulesTest {
    private val entityId = "novel.plugin_setting::wtrlab::preferredMode"

    @Test
    fun `entity IDs round trip and reject malformed plugins and keys`() {
        NovelPluginSettingRules.entityIdFor("wtrlab", "preferredMode") shouldBe entityId
        NovelPluginSettingRules.parseEntityId(entityId) shouldBe ("wtrlab" to "preferredMode")
        NovelPluginSettingRules.parseEntityId("novel.plugin_setting::wtrlab::a::b") shouldBe null
        NovelPluginSettingRules.parseEntityId("novel.plugin_setting::wtrlab::") shouldBe null
        NovelPluginSettingRules.parseEntityId("novel.plugin_setting:: wtrlab::preferredMode") shouldBe null
        NovelPluginSettingRules.parseEntityId("comic.source_preference::1::preferredMode") shouldBe null
        NovelPluginSettingRules.isValidPluginId("komga") shouldBe true
        NovelPluginSettingRules.isValidPluginId("") shouldBe false
        NovelPluginSettingRules.isValidPluginId("a::b") shouldBe false
        NovelPluginSettingRules.isValidPluginId("p".repeat(NovelPluginSettingRules.MAX_PLUGIN_ID_BYTES + 1)) shouldBe false
    }

    @Test
    fun `logins and sessions of real plugins never travel`() {
        NovelPluginSettingRules.isSyncableSetting("wtrlab", "preferredMode") shouldBe true
        NovelPluginSettingRules.isSyncableSetting("wtrlab", "fallbackToWeb") shouldBe true
        NovelPluginSettingRules.isSyncableSetting("boxnovel", "hideLocked") shouldBe true
        NovelPluginSettingRules.isSyncableSetting("komga", "url") shouldBe true
        NovelPluginSettingRules.isSyncableSetting("wtrlab", "sessionCookie") shouldBe false
        NovelPluginSettingRules.isSyncableSetting("wtrlab", "signInUrl") shouldBe false
        NovelPluginSettingRules.isSyncableSetting("komga", "email") shouldBe false
        NovelPluginSettingRules.isSyncableSetting("komga", "password") shouldBe false
        // A server address that carries credentials stays on the device.
        NovelPluginSettingRules.isSyncable(
            "komga",
            "url",
            SourcePreferenceValue.Text("http://me:hunter2@192.168.0.5:25600"),
        ) shouldBe false
        NovelPluginSettingRules.isSyncable(
            "komga",
            "url",
            SourcePreferenceValue.Text("http://192.168.0.5:25600"),
        ) shouldBe true
    }

    @Test
    fun `stored records must match their entity and stay valid`() {
        fun record(vararg overrides: Pair<String, JsonElement>): Map<String, JsonElement> = mapOf(
            "settingId" to JsonPrimitive(entityId),
            "pluginId" to JsonPrimitive("wtrlab"),
            "key" to JsonPrimitive("preferredMode"),
            "valueType" to JsonPrimitive("string"),
            "value" to JsonPrimitive("ai"),
            "updatedAtMs" to JsonPrimitive(1),
            "futureField" to JsonPrimitive("ignored"),
        ) + overrides

        NovelPluginSettingRules.recordValue(entityId, record()) shouldBe SourcePreferenceValue.Text("ai")
        NovelPluginSettingRules.recordValue(entityId, record("pluginId" to JsonPrimitive("komga"))) shouldBe null
        NovelPluginSettingRules.recordValue(entityId, record("settingId" to JsonPrimitive("x"))) shouldBe null
        NovelPluginSettingRules.recordValue(entityId, record("valueType" to JsonPrimitive("boolean"))) shouldBe null
        NovelPluginSettingRules.recordValue(entityId, record("value" to JsonPrimitive("Bearer abc"))) shouldBe null
        val cookieId = NovelPluginSettingRules.entityIdFor("wtrlab", "sessionCookie")
        NovelPluginSettingRules.recordValue(
            cookieId,
            record("settingId" to JsonPrimitive(cookieId), "key" to JsonPrimitive("sessionCookie")),
        ) shouldBe null
        val hideLockedId = NovelPluginSettingRules.entityIdFor("boxnovel", "hideLocked")
        NovelPluginSettingRules.recordValue(
            hideLockedId,
            record(
                "settingId" to JsonPrimitive(hideLockedId),
                "pluginId" to JsonPrimitive("boxnovel"),
                "key" to JsonPrimitive("hideLocked"),
                "valueType" to JsonPrimitive("boolean"),
                "value" to JsonPrimitive(true),
            ),
        ) shouldBe SourcePreferenceValue.Flag(true)
    }

    @Test
    fun `the command checks its identity and refuses secrets`() {
        val command = SyncCommand.SetNovelPluginSetting.of("boxnovel", "hideLocked", SourcePreferenceValue.Flag(true))
        command.entityId.value shouldBe "novel.plugin_setting::boxnovel::hideLocked"
        command.valueType shouldBe "boolean"
        command.typedValue shouldBe SourcePreferenceValue.Flag(true)
        command.operationWireName() shouldBe "set_novel_plugin_setting"
        shouldThrow<IllegalArgumentException> {
            SyncCommand.SetNovelPluginSetting.of("wtrlab", "sessionCookie", SourcePreferenceValue.Text("cf_clearance=abc"))
        }
        shouldThrow<IllegalArgumentException> {
            SyncCommand.SetNovelPluginSetting(
                entityId = EpigraphEntityId(NovelPluginSettingRules.entityIdFor("wtrlab", "preferredMode")),
                pluginId = "wtrlab",
                key = "fallbackToWeb",
                valueType = "boolean",
                value = JsonPrimitive(true),
            )
        }
    }
}
