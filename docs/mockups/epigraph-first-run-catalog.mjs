// First-run capabilities live here so new app features can join the flow without
// duplicating navigation or provider markup.
export const FIRST_RUN_STEPS = Object.freeze([
  { id: "theme", label: "Aparência", icon: "ph-palette", pages: ["theme"] },
  { id: "entry", label: "Seus dados", icon: "ph-signpost", pages: ["entry"] },
  { id: "configure", label: "Preparar", icon: "ph-plugs-connected", pages: ["sync", "backups", "backup-review", "sources"] },
  { id: "trackers", label: "Trackers", icon: "ph-chart-line-up", pages: ["trackers"] },
  { id: "library", label: "Biblioteca", icon: "ph-books", pages: ["discover", "complete"] },
]);

export function getFirstRunPageDepth(page) {
  if (page === "deferred") return FIRST_RUN_STEPS.length;
  const index = FIRST_RUN_STEPS.findIndex((step) => step.pages.includes(page));
  return index < 0 ? null : index;
}

export const THEME_OPTIONS = Object.freeze([
  ["light", "Claro", "#f1eff4", "#fbfafc", "#6f519e"],
  ["light-contrast", "Claro contraste", "#dfdce4", "#f8f7fa", "#4f378b"],
  ["nocturne", "Nocturne", "#0b0a0f", "#17151d", "#9f8ed9"],
  ["dark", "Escuro", "#0c0d10", "#1a1c22", "#8d99ae"],
  ["amoled", "AMOLED", "#050505", "#0b0b0d", "#b4a1ed"],
  ["high-contrast", "Alto contraste", "#050505", "#171717", "#f4e36d"],
  ["midnight", "Meia-noite", "#070912", "#161b2d", "#92a3dc"],
  ["warm", "Quente", "#0c0a08", "#1e1a14", "#c9a45f"],
]);

// Representative first-run inventory. Production uses the dynamic provider
// inventory returned by Suwayomi plus native integrations registered by Epigraph.
export const TRACKER_PROVIDERS = Object.freeze([
  { id: "anilist", name: "AniList", scope: "Quadrinhos e anime", icon: "ph-chart-line-up" },
  { id: "myanimelist", name: "MyAnimeList", scope: "Mangá e anime", icon: "ph-list-checks" },
  { id: "kitsu", name: "Kitsu", scope: "Mangá e anime", icon: "ph-books" },
  { id: "mangaupdates", name: "MangaUpdates", scope: "Quadrinhos", icon: "ph-book-open-text" },
  { id: "bangumi", name: "Bangumi", scope: "Quadrinhos e anime", icon: "ph-stack" },
  { id: "hardcover", name: "Hardcover", scope: "Livros e novels", icon: "ph-book-bookmark" },
]);
