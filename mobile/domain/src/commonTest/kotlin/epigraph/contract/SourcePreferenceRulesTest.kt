package epigraph.contract

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Test

class SourcePreferenceRulesTest {
    private val entityId = "comic.source_preference::-123456789::preferred_mirror"

    @Test
    fun `entity IDs round trip and reject malformed sources and keys`() {
        SourcePreferenceRules.entityIdFor("-123456789", "preferred_mirror") shouldBe entityId
        SourcePreferenceRules.parseEntityId(entityId) shouldBe ("-123456789" to "preferred_mirror")
        // Keys may contain the separator after the first one.
        SourcePreferenceRules.parseEntityId("comic.source_preference::1::a::b") shouldBe ("1" to "a::b")
        SourcePreferenceRules.parseEntityId("comic.tracking::1::key") shouldBe null
        SourcePreferenceRules.parseEntityId("comic.source_preference::abc::key") shouldBe null
        SourcePreferenceRules.parseEntityId("comic.source_preference::1:: key") shouldBe null
        SourcePreferenceRules.parseEntityId("comic.source_preference::1::") shouldBe null
        SourcePreferenceRules.isValidSourceId("9223372036854775807") shouldBe true
        SourcePreferenceRules.isValidSourceId("9223372036854775808") shouldBe false
        SourcePreferenceRules.isValidSourceId("+1") shouldBe false
    }

    @Test
    fun `credentials sessions and caches are never syncable`() {
        listOf("preferred_mirror", "Mirror", "imageQuality", "showNsfw").forEach {
            SourcePreferenceRules.isSyncableKey(it) shouldBe true
        }
        listOf(
            "password", "user_Token", "cookies", "API_KEY", "session_id", "login", "authHeader",
            "username", "email", "fetchedMirrors", "mirror_cache", "lastUpdateCheck", "user-agent",
            "device_uuid", "__internal", "private_key", " padded", "",
        ).forEach {
            SourcePreferenceRules.isSyncableKey(it) shouldBe false
        }
        SourcePreferenceRules.isSyncableKey("k".repeat(SourcePreferenceRules.MAX_KEY_BYTES + 1)) shouldBe false
    }

    @Test
    fun `values that look secret or are too large are not syncable`() {
        SourcePreferenceValue.Text("https://mangakakalove.com").isSyncable() shouldBe true
        SourcePreferenceValue.Text("https://user:pass@example.com/path").isSyncable() shouldBe false
        SourcePreferenceValue.Text("https://example.com/?token=abc").isSyncable() shouldBe false
        SourcePreferenceValue.Text("Bearer abc").isSyncable() shouldBe false
        SourcePreferenceValue.Text("x".repeat(SourcePreferenceRules.MAX_STRING_BYTES + 1)).isSyncable() shouldBe false
        SourcePreferenceValue.TextSet((1..SourcePreferenceRules.MAX_SET_ENTRIES + 1).map(Int::toString))
            .isSyncable() shouldBe false
        SourcePreferenceValue.Flag(true).isSyncable() shouldBe true
    }

    @Test
    fun `sets compare by content regardless of order`() {
        val first = SourcePreferenceValue.TextSet(listOf("b", "a"))
        val second = SourcePreferenceValue.TextSet(setOf("a", "b"))
        first shouldBe second
        first.fingerprint() shouldBe second.fingerprint()
        first.fingerprint() shouldBe """string_set:["a","b"]"""
    }

    @Test
    fun `typed values need the declared JSON shape`() {
        SourcePreferenceValue.fromTyped("boolean", JsonPrimitive(true)) shouldBe SourcePreferenceValue.Flag(true)
        SourcePreferenceValue.fromTyped("boolean", JsonPrimitive("true")) shouldBe null
        SourcePreferenceValue.fromTyped("string", JsonPrimitive(1)) shouldBe null
        SourcePreferenceValue.fromTyped("string_set", JsonArray(listOf(JsonPrimitive(1)))) shouldBe null
        SourcePreferenceValue.fromTyped("int", JsonPrimitive(1)) shouldBe null
    }

    @Test
    fun `an installed extension accepts only values it offers`() {
        val mirror = SourcePreferenceValue.Text("1")
        SourcePreferenceRules.accepts("string", listOf("0", "1"), mirror) shouldBe true
        SourcePreferenceRules.accepts("string", listOf("0"), mirror) shouldBe false
        SourcePreferenceRules.accepts("string", null, mirror) shouldBe true
        SourcePreferenceRules.accepts("boolean", null, mirror) shouldBe false
        val set = SourcePreferenceValue.TextSet(listOf("a"))
        SourcePreferenceRules.accepts("string_set", listOf("a", "b"), set) shouldBe true
        SourcePreferenceRules.accepts("string_set", null, set) shouldBe false
    }

    @Test
    fun `stored records must match their entity and stay valid`() {
        fun record(vararg overrides: Pair<String, JsonElement>): Map<String, JsonElement> = mapOf(
            "preferenceId" to JsonPrimitive(entityId),
            "sourceId" to JsonPrimitive("-123456789"),
            "key" to JsonPrimitive("preferred_mirror"),
            "valueType" to JsonPrimitive("string"),
            "value" to JsonPrimitive("1"),
            "updatedAtMs" to JsonPrimitive(1),
            "futureField" to JsonPrimitive("ignored"),
        ) + overrides

        SourcePreferenceRules.recordValue(entityId, record()) shouldBe SourcePreferenceValue.Text("1")
        SourcePreferenceRules.recordValue(entityId, record("key" to JsonPrimitive("other"))) shouldBe null
        SourcePreferenceRules.recordValue(entityId, record("valueType" to JsonPrimitive("boolean"))) shouldBe null
        SourcePreferenceRules.recordValue(entityId, record("value" to JsonPrimitive("token=abc"))) shouldBe null
        val setId = SourcePreferenceRules.entityIdFor("-123456789", "langs")
        SourcePreferenceRules.recordValue(
            setId,
            record(
                "preferenceId" to JsonPrimitive(setId),
                "key" to JsonPrimitive("langs"),
                "valueType" to JsonPrimitive("string_set"),
                // Duplicates are refused, as on the desktop.
                "value" to JsonArray(listOf(JsonPrimitive("en"), JsonPrimitive("en"))),
            ),
        ) shouldBe null
        val cacheId = SourcePreferenceRules.entityIdFor("-123456789", "fetchedMirrors")
        SourcePreferenceRules.recordValue(
            cacheId,
            record("preferenceId" to JsonPrimitive(cacheId), "key" to JsonPrimitive("fetchedMirrors")),
        ) shouldBe null
    }

    @Test
    fun `set source preference command serializes and refuses what may not sync`() {
        val command = SyncCommand.SetSourcePreference.of("-123456789", "preferred_mirror", SourcePreferenceValue.Text("1"))
        command.operationWireName() shouldBe "set_source_preference"
        val encoded = Json { classDiscriminator = "operation" }.encodeToJsonElement(SyncCommand.serializer(), command)
            .jsonObject
        encoded["operation"]!!.jsonPrimitive.content shouldBe "set_source_preference"
        encoded["entityId"]!!.jsonPrimitive.content shouldBe entityId
        encoded["valueType"]!!.jsonPrimitive.content shouldBe "string"
        encoded["value"]!!.jsonPrimitive.content shouldBe "1"

        shouldThrow<IllegalArgumentException> {
            SyncCommand.SetSourcePreference.of("-123456789", "password", SourcePreferenceValue.Text("1"))
        }
        shouldThrow<IllegalArgumentException> {
            SyncCommand.SetSourcePreference(
                EpigraphEntityId(entityId),
                "-123456789",
                "other_key",
                "string",
                JsonPrimitive("1"),
            )
        }
        shouldThrow<IllegalArgumentException> {
            SyncCommand.SetSourcePreference(
                EpigraphEntityId(entityId),
                "-123456789",
                "preferred_mirror",
                "boolean",
                JsonPrimitive("1"),
            )
        }
    }
}
