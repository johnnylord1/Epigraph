const TITLE_ALIAS_LIMIT = 4;

export const NOVEL_TITLE_ALIAS_VERSION = 1;

const KNOWN_NOVEL_TITLE_ALIASES: Record<string, string[]> = {
  "a evolucao de um goblin ao apice": ["The Evolution of a Goblin to the Peak"],
  "a evolucao de um goblin ate o auge": ["The Evolution of a Goblin to the Peak"],
  "apostolo astral": ["Astral Apostle"],
  "cuidado com o frango": ["Beware of Chicken"],
  "circulo da inevitabilidade": ["Circle of Inevitability"],
  "deixe me jogar em paz": ["Let Me Game in Peace"],
  "deus da espada em um mundo de magia": ["Sword God in a World of Magic"],
  "escravo das sombras": ["Shadow Slave"],
  "eu sou o vilao predestinado": ["I Am the Fated Villain"],
  "horizonte de conquistas": ["Worlds' Apocalypse Online"],
  "knight of chaos": ["Knight of Chaos"],
  "lorde dos misterios": ["Lord of the Mysteries"],
  "mana infinita no apocalipse": ["Infinite Mana in the Apocalypse"],
  "mate o sol": ["Kill the Sun"],
  "meu sistema de dragao": ["My Dragon System"],
  "nascimento da espada demoniaca": ["Birth of the Demonic Sword"],
  "o lendario mecanico": ["The Legendary Mechanic"],
  "o monarca do ceu": ["Monarch of the Sky"],
  "o toque mecanico": ["The Mech Touch"],
  "o tutorial e tao dificil": ["The Tutorial Is Too Hard"],
  "o unico fazendeiro da torre": ["Solo Farming in the Tower"],
  "os caminhos do oraculo": ["The Oracle Paths"],
  "paraiso dos monstros": ["Monster Paradise"],
  "reino dos mitos e lendas": ["Realm of Myths and Legends"],
  "renascimento da nanomante": ["Rebirth of the Nanomancer"],
  "sobrevivendo no jogo como um barbaro": ["Surviving the Game as a Barbarian"],
  "trono do deus arcanista": ["Throne of Magical Arcana"],
};

export function normalizeNovelTitleAliasKey(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[''`´\u2018\u2019\u02bc]/g, "")
    .replace(/&/g, " and ")
    .replace(/\b(?:novel|light novel|webnovel|web novel)\b/gi, " ")
    .replace(/\b(?:vol|volume|book|livro)\.?\s*\d+\b/gi, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function canonicalNovelTitleCandidates(title: string): string[] {
  const original = title.trim();
  if (!original) return [];

  const normalized = normalizeNovelTitleAliasKey(original);
  const aliases = KNOWN_NOVEL_TITLE_ALIASES[normalized] ?? [];
  const candidates = [original, ...aliases];
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const candidate of candidates) {
    const cleaned = candidate.trim();
    if (!cleaned) continue;
    const key = normalizeNovelTitleAliasKey(cleaned);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(cleaned);
    if (deduped.length >= TITLE_ALIAS_LIMIT) break;
  }

  return deduped;
}
