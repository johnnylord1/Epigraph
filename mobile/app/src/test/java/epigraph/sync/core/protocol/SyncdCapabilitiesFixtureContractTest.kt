package epigraph.sync.core.protocol

import kotlinx.serialization.json.Json
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertDoesNotThrow

/**
 * Contract gate against the desktop syncd. The fixture is generated from the desktop sources by
 * `scripts/core_contract_fixture.py`, so a Core change that adds a field, an entity type or a
 * schema version fails here until Android handles it explicitly.
 */
class SyncdCapabilitiesFixtureContractTest {
    // Strict on purpose: an unknown field means the Core grew a capability Android has not reviewed.
    private val json = Json { ignoreUnknownKeys = false }

    private val capabilities: CoreCapabilities by lazy {
        val text = checkNotNull(javaClass.getResource(FIXTURE)) { "missing $FIXTURE" }.readText()
        json.decodeFromString<CoreCapabilities>(text)
    }

    @Test
    fun `current syncd capabilities are compatible`() {
        assertEquals(CoreCompatibility.Compatible, EpigraphCoreCompatibilityEvaluator.evaluate(capabilities))
        assertTrue(
            capabilities.snapshotSchemaVersion in
                EpigraphCoreWireProtocol.MIN_SNAPSHOT_SCHEMA_VERSION..EpigraphCoreWireProtocol.SNAPSHOT_SCHEMA_VERSION,
        )
    }

    @Test
    fun `every advertised entity type has a bootstrap phase on Android`() {
        capabilities.snapshotEntityTypes.forEach { entityType ->
            assertDoesNotThrow("Android has no bootstrap phase for $entityType") {
                EpigraphCoreBootstrapPlanner.phaseOf(entityType)
            }
        }
    }

    @Test
    fun `every advertised entity type is a declared Android constant`() {
        val declared = EpigraphCoreEntityType::class.java.declaredFields
            .filter { it.type == String::class.java && java.lang.reflect.Modifier.isStatic(it.modifiers) }
            .map { it.get(null) as String }
            .toSet()
        assertEquals(emptySet<String>(), capabilities.snapshotEntityTypes - declared)
    }

    @Test
    fun `current syncd enables the canonical comic projection and Suwayomi authority`() {
        assertTrue(EpigraphCoreCompatibilityEvaluator.supportsCanonicalComicProjection(capabilities))
        assertTrue(EpigraphCoreCompatibilityEvaluator.isSuwayomiAuthoritativeComics(capabilities))
        assertTrue(EpigraphCoreCompatibilityEvaluator.supportsSyncStatus(capabilities))
    }

    private companion object {
        const val FIXTURE = "/epigraph/contract/syncd_capabilities.json"
    }
}
