export type NovelSourceClassificationStatus =
  | "migration-safe"
  | "working"
  | "working-with-known-limitations"
  | "blocked-by-site"
  | "runtime-gap"
  | "pending";

export interface NovelSourceClassificationBaselineRecord {
  pluginId: string;
  lang: string;
  status: NovelSourceClassificationStatus;
  notes: string;
}

export interface NovelSourceAutomaticSmokeRecipe {
  pluginId: string;
  searchTerms: string[];
  preferredPathIncludes?: string[];
}

const BASELINE_MATRIX: NovelSourceClassificationBaselineRecord[] = [
  {
    pluginId: "archiveofourown",
    lang: "en",
    status: "migration-safe",
    notes: "Product-real source path is proven on install/open/search/details/chapter and can participate in novels migration.",
  },
  {
    pluginId: "inkitt",
    lang: "en",
    status: "working-with-known-limitations",
    notes: "Search works, but charset issues are still observed in saved evidence.",
  },
  {
    pluginId: "royalroad",
    lang: "en",
    status: "migration-safe",
    notes: "Official source boundary is proven on search/details/chapter and the installed-source path is accepted for the current migration-safe cohort.",
  },
  {
    pluginId: "scribblehub",
    lang: "en",
    status: "pending",
    notes: "Priority English cohort target.",
  },
  {
    pluginId: "webnovel",
    lang: "en",
    status: "pending",
    notes: "Priority English cohort target.",
  },
  {
    pluginId: "lightnovelbrasil",
    lang: "pt",
    status: "blocked-by-site",
    notes: "The source now passes the runtime wrapper path, but live search currently lands on a JS redirect / anti-bot challenge page instead of returning structured results.",
  },
  {
    pluginId: "illusia",
    lang: "pt",
    status: "migration-safe",
    notes: "Ad-hoc live probe proved search/details/chapter with correct UTF-8 code points after fetchApi().text() normalization, satisfying the current pt-BR side of the migration-safe cohort.",
  },
  {
    pluginId: "lanovels",
    lang: "pt",
    status: "blocked-by-site",
    notes: "Earlier direct probes hit redirect or anti-bot HTML.",
  },
  {
    pluginId: "betternovels",
    lang: "pt",
    status: "blocked-by-site",
    notes: "The source currently fails live DNS / site reachability in probe runs and should stay blocked until the site becomes reachable again.",
  },
  {
    pluginId: "centralnovel",
    lang: "pt",
    status: "working",
    notes: "Browse-seeded live probe proved search, details, and chapter for the current runtime boundary without exposing a migration-safe claim yet.",
  },
  {
    pluginId: "tsundoku",
    lang: "pt",
    status: "pending",
    notes: "Priority Portuguese cohort target.",
  },
];

const AUTOMATIC_SMOKE_RECIPES: NovelSourceAutomaticSmokeRecipe[] = [
  {
    pluginId: "archiveofourown",
    searchTerms: ["manacled", "draco malfoy and the mortifying ordeal of being in love"],
    preferredPathIncludes: ["works/"],
  },
  {
    pluginId: "royalroad",
    searchTerms: ["mother of learning", "primal hunter", "mark of the fool", "shadow slave"],
  },
  {
    pluginId: "illusia",
    searchTerms: ["overlord", "solo leveling", "reverend insanity", "shadow slave", "o"],
  },
  {
    pluginId: "lightnovelbrasil",
    searchTerms: ["overlord", "solo leveling", "shadow slave", "o"],
  },
  {
    pluginId: "scribblehub",
    searchTerms: ["mother of learning", "mark of the fool", "the stubborn skill-grinder in a time loop", "shadow slave"],
  },
  {
    pluginId: "centralnovel",
    searchTerms: ["86: Eighty Six", "A Monster Who Levels Up", "A Will Eternal", "A World Worth Protecting"],
  },
];

export function listNovelSourceClassificationBaseline(): NovelSourceClassificationBaselineRecord[] {
  return [...BASELINE_MATRIX];
}

export function getNovelSourceClassificationBaselineRecord(
  pluginId: string,
): NovelSourceClassificationBaselineRecord | null {
  return BASELINE_MATRIX.find((entry) => entry.pluginId === pluginId) ?? null;
}

export function getNovelSourceAutomaticSmokeRecipe(pluginId: string): NovelSourceAutomaticSmokeRecipe | null {
  return AUTOMATIC_SMOKE_RECIPES.find((entry) => entry.pluginId === pluginId) ?? null;
}
