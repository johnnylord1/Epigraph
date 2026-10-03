package epigraph.recommendations

import java.text.Normalizer

private const val TITLE_ALIAS_LIMIT = 4

internal const val NOVEL_TITLE_ALIAS_VERSION = 1

private val KNOWN_NOVEL_TITLE_ALIASES: Map<String, List<String>> = mapOf(
    "a evolucao de um goblin ao apice" to listOf("The Evolution of a Goblin to the Peak"),
    "a evolucao de um goblin ate o auge" to listOf("The Evolution of a Goblin to the Peak"),
    "apostolo astral" to listOf("Astral Apostle"),
    "cuidado com o frango" to listOf("Beware of Chicken"),
    "circulo da inevitabilidade" to listOf("Circle of Inevitability"),
    "deixe me jogar em paz" to listOf("Let Me Game in Peace"),
    "deus da espada em um mundo de magia" to listOf("Sword God in a World of Magic"),
    "escravo das sombras" to listOf("Shadow Slave"),
    "eu sou o vilao predestinado" to listOf("I Am the Fated Villain"),
    "horizonte de conquistas" to listOf("Worlds' Apocalypse Online"),
    "knight of chaos" to listOf("Knight of Chaos"),
    "lorde dos misterios" to listOf("Lord of the Mysteries"),
    "mana infinita no apocalipse" to listOf("Infinite Mana in the Apocalypse"),
    "mate o sol" to listOf("Kill the Sun"),
    "meu sistema de dragao" to listOf("My Dragon System"),
    "nascimento da espada demoniaca" to listOf("Birth of the Demonic Sword"),
    "o lendario mecanico" to listOf("The Legendary Mechanic"),
    "o monarca do ceu" to listOf("Monarch of the Sky"),
    "o toque mecanico" to listOf("The Mech Touch"),
    "o tutorial e tao dificil" to listOf("The Tutorial Is Too Hard"),
    "o unico fazendeiro da torre" to listOf("Solo Farming in the Tower"),
    "os caminhos do oraculo" to listOf("The Oracle Paths"),
    "paraiso dos monstros" to listOf("Monster Paradise"),
    "reino dos mitos e lendas" to listOf("Realm of Myths and Legends"),
    "renascimento da nanomante" to listOf("Rebirth of the Nanomancer"),
    "sobrevivendo no jogo como um barbaro" to listOf("Surviving the Game as a Barbarian"),
    "trono do deus arcanista" to listOf("Throne of Magical Arcana"),
)

private val COMBINING_MARKS = Regex("\\p{Mn}")
private val APOSTROPHE_CHARS = Regex("['\u2019`\u00B4\u2018\u2019\u02BC]")
private val NOVEL_WORDS = Regex("\\b(?:novel|light novel|webnovel|web novel)\\b", RegexOption.IGNORE_CASE)
private val VOLUME_PATTERN = Regex("\\b(?:vol|volume|book|livro)\\.?\\s*\\d+\\b", RegexOption.IGNORE_CASE)
private val BRACKETED_PARTS = Regex("\\([^)]*\\)|\\[[^\\]]*\\]|\\{[^}]*\\}")
private val NON_ALNUM = Regex("[^a-z0-9]+")
private val WHITESPACE = Regex("\\s+")

internal fun normalizeNovelTitleAliasKey(title: String): String {
    var result = title.trim().lowercase()
    result = Normalizer.normalize(result, Normalizer.Form.NFKD)
    result = COMBINING_MARKS.replace(result, "")
    result = APOSTROPHE_CHARS.replace(result, "")
    result = result.replace("&", " and ")
    result = NOVEL_WORDS.replace(result, " ")
    result = VOLUME_PATTERN.replace(result, " ")
    result = BRACKETED_PARTS.replace(result, " ")
    result = NON_ALNUM.replace(result, " ")
    result = WHITESPACE.replace(result, " ")
    return result.trim()
}

internal fun canonicalNovelTitleCandidates(title: String): List<String> {
    val original = title.trim()
    if (original.isEmpty()) return emptyList()

    val normalized = normalizeNovelTitleAliasKey(original)
    val aliases = KNOWN_NOVEL_TITLE_ALIASES[normalized].orEmpty()
    val candidates = listOf(original) + aliases
    val seen = mutableSetOf<String>()
    val deduped = mutableListOf<String>()

    for (candidate in candidates) {
        val cleaned = candidate.trim()
        if (cleaned.isEmpty()) continue
        val key = normalizeNovelTitleAliasKey(cleaned)
        if (key.isEmpty() || seen.contains(key)) continue
        seen.add(key)
        deduped.add(cleaned)
        if (deduped.size >= TITLE_ALIAS_LIMIT) break
    }

    return deduped
}
