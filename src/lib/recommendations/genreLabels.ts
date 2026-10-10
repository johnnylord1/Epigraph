// Taste tags are folded to English tokens ("acao" -> "action") so sources in
// different languages agree. These are the reader-facing names of the common ones.
const GENRE_LABELS: Record<string, Record<string, string>> = {
  "pt-BR": {
    action: "Ação",
    adventure: "Aventura",
    fantasy: "Fantasia",
    comedy: "Comédia",
    horror: "Terror",
    mystery: "Mistério",
    "sci fi": "Ficção científica",
    "martial arts": "Artes marciais",
    "school life": "Vida escolar",
    supernatural: "Sobrenatural",
    psychological: "Psicológico",
    tragedy: "Tragédia",
    historical: "Histórico",
    sports: "Esportes",
    magic: "Magia",
    reincarnation: "Reencarnação",
    "slice of life": "Cotidiano",
    military: "Militar",
    survival: "Sobrevivência",
    "super power": "Superpoderes",
    revenge: "Vingança",
  },
  es: {
    action: "Acción",
    adventure: "Aventura",
    fantasy: "Fantasía",
    comedy: "Comedia",
    horror: "Terror",
    mystery: "Misterio",
    "sci fi": "Ciencia ficción",
    "martial arts": "Artes marciales",
    "school life": "Vida escolar",
    supernatural: "Sobrenatural",
    psychological: "Psicológico",
    tragedy: "Tragedia",
    historical: "Histórico",
    sports: "Deportes",
    magic: "Magia",
    reincarnation: "Reencarnación",
    "slice of life": "Recuentos de la vida",
    military: "Militar",
    survival: "Supervivencia",
    "super power": "Superpoderes",
    revenge: "Venganza",
  },
  ja: {
    action: "アクション",
    adventure: "冒険",
    fantasy: "ファンタジー",
    comedy: "コメディ",
    horror: "ホラー",
    mystery: "ミステリー",
    "sci fi": "SF",
    "martial arts": "武術",
    "school life": "学園",
    supernatural: "超常",
    psychological: "心理",
    tragedy: "悲劇",
    historical: "歴史",
    sports: "スポーツ",
    magic: "魔法",
    reincarnation: "転生",
    "slice of life": "日常",
    military: "ミリタリー",
    survival: "サバイバル",
    "super power": "超能力",
    revenge: "復讐",
  },
  "zh-CN": {
    action: "动作",
    adventure: "冒险",
    fantasy: "奇幻",
    comedy: "喜剧",
    horror: "恐怖",
    mystery: "悬疑",
    "sci fi": "科幻",
    "martial arts": "武术",
    "school life": "校园",
    supernatural: "超自然",
    psychological: "心理",
    tragedy: "悲剧",
    historical: "历史",
    sports: "运动",
    magic: "魔法",
    reincarnation: "转生",
    "slice of life": "日常",
    military: "军事",
    survival: "生存",
    "super power": "超能力",
    revenge: "复仇",
  },
};

/** "sci fi" -> "Sci Fi" in English, "Ficção científica" in Portuguese, and so on. */
export function tasteTagLabel(tag: string, locale: string): string {
  const localized = GENRE_LABELS[locale]?.[tag];
  if (localized) return localized;
  return tag
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Some sources publish genres as slugs ("slice_of_life"); show those as words in the app language.
 * Anything else is already a name the source chose and is shown as given.
 */
export function genreDisplayLabel(genre: string, locale: string): string {
  const trimmed = genre.trim();
  const isSlug = /^[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+$/.test(trimmed) || /^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(trimmed);
  if (!isSlug) return trimmed;
  return tasteTagLabel(trimmed.replace(/[_-]+/g, " ").toLowerCase(), locale);
}
