package epigraph.recommendations

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.double
import kotlinx.serialization.json.int
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class RecommendationDesktopParityTest {

    private val json = Json
    private val root: JsonObject by lazy {
        val stream = javaClass.getResourceAsStream("/epigraph/recommendations/desktop-parity.json")
            ?: error("desktop-parity.json not found on test classpath")
        stream.use { json.parseToJsonElement(it.reader().readText()).jsonObject }
    }

    private val nowMs: Long by lazy { root["now"]!!.jsonPrimitive.long!! }

    // ── Parsing helpers ──────────────────────────────────────────────────────

    private fun parseMetric(el: JsonElement?): NormalizedMetric? = el?.let {
        val o = it.jsonObject
        NormalizedMetric(
            value = o["value"]!!.jsonPrimitive.double!!,
            confidence = o["confidence"]!!.jsonPrimitive.double!!,
            method = o["method"]!!.jsonPrimitive.content,
            sourceValue = o["sourceValue"]?.jsonPrimitive?.contentOrNull,
        )
    }

    private fun parseProvider(el: JsonElement): RecommendationProviderSignal {
        val o = el.jsonObject
        return RecommendationProviderSignal(
            providerId = o["providerId"]!!.jsonPrimitive.content,
            providerName = o["providerName"]!!.jsonPrimitive.content,
            kind = RecommendationProviderKind.valueOf(o["kind"]!!.jsonPrimitive.content.uppercase()),
            remoteId = o["remoteId"]?.jsonPrimitive?.contentOrNull,
            iconKey = o["iconKey"]?.jsonPrimitive?.contentOrNull,
            score = parseMetric(o["score"]),
            popularity = parseMetric(o["popularity"]),
            trending = parseMetric(o["trending"]),
            recency = parseMetric(o["recency"]),
            activity = parseMetric(o["activity"]),
            availability = parseMetric(o["availability"]),
        )
    }

    private fun parseSeed(el: JsonElement): TasteProfileSeedItem {
        val o = el.jsonObject
        return TasteProfileSeedItem(
            id = o["id"]!!.jsonPrimitive.content,
            title = o["title"]!!.jsonPrimitive.content,
            tags = o["tags"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            contentType = RecommendationContentType.valueOf(o["contentType"]!!.jsonPrimitive.content.uppercase()),
            sourceId = o["sourceId"]?.jsonPrimitive?.contentOrNull,
            userRating = o["userRating"]?.jsonPrimitive?.doubleOrNull,
            userRatingMax = o["userRatingMax"]?.jsonPrimitive?.doubleOrNull,
            implicitWeight = o["implicitWeight"]?.jsonPrimitive?.doubleOrNull,
            status = o["status"]?.jsonPrimitive?.contentOrNull?.uppercase()?.let { TasteSeedStatus.valueOf(it) },
        )
    }

    private fun parseCandidate(el: JsonElement): RecommendationCandidate {
        val o = el.jsonObject
        return RecommendationCandidate(
            id = o["id"]!!.jsonPrimitive.content,
            title = o["title"]!!.jsonPrimitive.content,
            alternativeTitles = o["alternativeTitles"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            tags = o["tags"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
            contentType = RecommendationContentType.valueOf(o["contentType"]!!.jsonPrimitive.content.uppercase()),
            status = o["status"]?.jsonPrimitive?.contentOrNull,
            providers = o["providers"]?.jsonArray?.map { parseProvider(it) } ?: emptyList(),
            inLibrary = o["inLibrary"]?.jsonPrimitive?.booleanOrNull ?: false,
            safety = o["safety"]?.jsonPrimitive?.contentOrNull?.uppercase()?.let { RecommendationSafetyLevel.valueOf(it) }
                ?: RecommendationSafetyLevel.SAFE,
            updatedAtMs = o["updatedAtMs"]?.jsonPrimitive?.longOrNull,
            publishedAtMs = o["publishedAtMs"]?.jsonPrimitive?.longOrNull,
        )
    }

    private fun parseOptions(el: JsonObject): BuildRecommendationSectionsOptions = BuildRecommendationSectionsOptions(
        includeNsfw = el["includeNsfw"]?.jsonPrimitive?.booleanOrNull ?: false,
        blockedTags = el["blockedTags"]?.jsonArray?.map { it.jsonPrimitive.content } ?: emptyList(),
        limitPerSection = el["limitPerSection"]?.jsonPrimitive?.intOrNull ?: BuildRecommendationSectionsOptions.DEFAULT_SECTION_LIMIT,
        knownTitleKeys = el["knownTitleKeys"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet(),
        knownProviderKeys = el["knownProviderKeys"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet(),
        nowMs = el["nowMs"]?.jsonPrimitive?.longOrNull ?: nowMs,
    )

    private data class Scenario(
        val name: String,
        val seeds: List<TasteProfileSeedItem>,
        val candidates: List<RecommendationCandidate>,
        val options: BuildRecommendationSectionsOptions,
        val expectedProfile: JsonObject,
        val expectedBreakdowns: JsonObject,
        val expectedSections: JsonObject,
    )

    private val scenarios: List<Scenario> by lazy {
        root["scenarios"]!!.jsonArray.map { el ->
            val o = el.jsonObject
            val input = o["input"]!!.jsonObject
            val expected = o["expected"]!!.jsonObject
            Scenario(
                name = o["name"]!!.jsonPrimitive.content,
                seeds = input["seeds"]!!.jsonArray.map { parseSeed(it) },
                candidates = input["candidates"]!!.jsonArray.map { parseCandidate(it) },
                options = parseOptions(input["options"]!!.jsonObject),
                expectedProfile = expected["profile"]!!.jsonObject,
                expectedBreakdowns = expected["breakdowns"]!!.jsonObject,
                expectedSections = expected["sections"]!!.jsonObject,
            )
        }.also { require(it.isNotEmpty()) { "desktop-parity.json has no scenarios" } }
    }

    // ── Tests ────────────────────────────────────────────────────────────────

    @Test
    fun `tag tokens match desktop`() {
        val tokens = root["tokens"]!!.jsonObject
        require(tokens.isNotEmpty()) { "tokens fixture is empty" }
        for ((tag, expectedEl) in tokens) {
            val expected = expectedEl.jsonArray.map { it.jsonPrimitive.content }
            val actual = recommendationTagTokens(tag)
            assertEquals(expected, actual, "tagTokens mismatch for tag '$tag'")
        }
    }

    @Test
    fun `taste profile matches desktop`() {
        for (s in scenarios) {
            val profile = buildTasteProfile(s.seeds)
            val exp = s.expectedProfile

            assertEquals(
                exp["seedCount"]!!.jsonPrimitive.int!!,
                profile.seedCount,
                "[${s.name}] seedCount mismatch",
            )

            // tagWeights
            val expTags = exp["tagWeights"]!!.jsonObject
            assertEquals(
                expTags.size, profile.tagWeights.size,
                "[${s.name}] tagWeights size mismatch",
            )
            for ((tag, weightEl) in expTags) {
                val expected = weightEl.jsonPrimitive.double!!
                val actual = profile.tagWeights[tag] ?: error("[${s.name}] missing tagWeights['$tag']")
                assertEquals(expected, actual, 1e-9, "[${s.name}] tagWeights['$tag'] mismatch")
            }

            // contentTypeWeights
            val expCt = exp["contentTypeWeights"]!!.jsonObject
            for ((ct, weightEl) in expCt) {
                val expected = weightEl.jsonPrimitive.double!!
                val actual = profile.contentTypeWeights[RecommendationContentType.valueOf(ct.uppercase())]
                    ?: error("[${s.name}] missing contentTypeWeights['$ct']")
                assertEquals(expected, actual, 1e-9, "[${s.name}] contentTypeWeights['$ct'] mismatch")
            }

            // sourceWeights
            val expSrc = exp["sourceWeights"]!!.jsonObject
            for ((src, weightEl) in expSrc) {
                val expected = weightEl.jsonPrimitive.double!!
                val actual = profile.sourceWeights[src] ?: error("[${s.name}] missing sourceWeights['$src']")
                assertEquals(expected, actual, 1e-9, "[${s.name}] sourceWeights['$src'] mismatch")
            }

            // topTags
            val expTop = exp["topTags"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(expTop, profile.topTags, "[${s.name}] topTags mismatch")

            // positiveTags
            val expPos = exp["positiveTags"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(expPos, profile.positiveTags, "[${s.name}] positiveTags mismatch")

            // negativeTags
            val expNeg = exp["negativeTags"]!!.jsonArray.map { it.jsonPrimitive.content }
            assertEquals(expNeg, profile.negativeTags, "[${s.name}] negativeTags mismatch")
        }
    }

    @Test
    fun `score breakdown matches desktop`() {
        for (s in scenarios) {
            val profile = buildTasteProfile(s.seeds)
            for (cand in s.candidates) {
                val actual = scoreRecommendationCandidate(cand, profile, s.options.nowMs)
                val expEl = s.expectedBreakdowns[cand.id]
                    ?: error("[${s.name}] missing expected breakdown for '${cand.id}'")
                val exp = expEl.jsonObject

                assertEquals(exp["personalRatingAffinity"]!!.jsonPrimitive.double!!, actual.personalRatingAffinity, 1e-9, "[${s.name}] ${cand.id} personalRatingAffinity")
                assertEquals(exp["profileTagOverlap"]!!.jsonPrimitive.double!!, actual.profileTagOverlap, 1e-9, "[${s.name}] ${cand.id} profileTagOverlap")
                assertEquals(exp["contentTypeFit"]!!.jsonPrimitive.double!!, actual.contentTypeFit, 1e-9, "[${s.name}] ${cand.id} contentTypeFit")
                assertEquals(exp["sourceAffinity"]!!.jsonPrimitive.double!!, actual.sourceAffinity, 1e-9, "[${s.name}] ${cand.id} sourceAffinity")
                assertEquals(exp["contentSimilarity"]!!.jsonPrimitive.double!!, actual.contentSimilarity, 1e-9, "[${s.name}] ${cand.id} contentSimilarity")
                assertEquals(exp["trackerConsensus"]!!.jsonPrimitive.double!!, actual.trackerConsensus, 1e-9, "[${s.name}] ${cand.id} trackerConsensus")
                assertEquals(exp["trendingVelocity"]!!.jsonPrimitive.double!!, actual.trendingVelocity, 1e-9, "[${s.name}] ${cand.id} trendingVelocity")
                assertEquals(exp["recency"]!!.jsonPrimitive.double!!, actual.recency, 1e-9, "[${s.name}] ${cand.id} recency")
                assertEquals(exp["sourceAvailability"]!!.jsonPrimitive.double!!, actual.sourceAvailability, 1e-9, "[${s.name}] ${cand.id} sourceAvailability")
                assertEquals(exp["novelty"]!!.jsonPrimitive.double!!, actual.novelty, 1e-9, "[${s.name}] ${cand.id} novelty")
                assertEquals(exp["negativeTagPenalty"]!!.jsonPrimitive.double!!, actual.negativeTagPenalty, 1e-9, "[${s.name}] ${cand.id} negativeTagPenalty")
                assertEquals(exp["matchedTagCount"]!!.jsonPrimitive.int!!, actual.matchedTagCount, "[${s.name}] ${cand.id} matchedTagCount")
                assertEquals(exp["finalScore"]!!.jsonPrimitive.double!!, actual.finalScore, 1e-9, "[${s.name}] ${cand.id} finalScore")
                assertEquals(
                    RecommendationDiversityBucket.valueOf(exp["diversityBucket"]!!.jsonPrimitive.content.uppercase()),
                    actual.diversityBucket,
                    "[${s.name}] ${cand.id} diversityBucket",
                )
            }
        }
    }

    @Test
    fun `sections match desktop`() {
        for (s in scenarios) {
            val profile = buildTasteProfile(s.seeds)
            val sections = buildRecommendationSections(s.candidates, profile, s.options)
            val actual = sections.associate { sec -> sec.key.key to sec.items.map { it.candidate.id } }

            for ((key, expEl) in s.expectedSections) {
                val expected = expEl.jsonArray.map { it.jsonPrimitive.content }
                val actualList = actual[key] ?: emptyList()
                assertEquals(expected, actualList, "[${s.name}] section '$key' mismatch")
            }
        }
    }
}
