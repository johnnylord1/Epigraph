import type { NovelRepositoryScopeInput } from "./repositoryState";
import { getNovelSourceAutomaticSmokeRecipe, getNovelSourceClassificationBaselineRecord, type NovelSourceClassificationStatus } from "./classificationModel";
import {
  getNovelSourceClassificationRecord,
  loadNovelSourceClassificationState,
  saveNovelSourceClassificationState,
  upsertNovelSourceClassificationRecord,
  type NovelSourceClassificationIssue,
  type PersistedNovelSourceClassificationRecord,
  type PersistedNovelSourceClassificationState,
} from "./sourceClassificationState";
import {
  browseInstalledNovelSource,
  loadInstalledNovelSources,
  readInstalledNovelChapter,
  readInstalledNovelDetails,
  readInstalledNovelSourceRuntimeSummary,
  searchInstalledNovelSource,
} from "./sources";

interface AutomaticClassificationSearchOutcome {
  term: string | null;
  resultPath: string | null;
  resultTitle: string | null;
}

const inFlightClassifications = new Map<string, Promise<PersistedNovelSourceClassificationRecord>>();
const AUTOMATIC_BROWSE_PAGES = 3;
const AUTOMATIC_BROWSE_TITLE_LIMIT = 6;
const GENERIC_AUTOMATIC_SEARCH_TERMS = {
  en: [
    "shadow slave",
    "mother of learning",
    "overlord",
    "solo leveling",
    "primal hunter",
    "lord of the mysteries",
  ],
  pt: [
    "overlord",
    "solo leveling",
    "shadow slave",
    "reverend insanity",
    "exodo",
    "o",
  ],
} as const;

function classificationKey(scopeInput: NovelRepositoryScopeInput, pluginId: string): string {
  return `${scopeInput.profileId ?? ""}::${scopeInput.serverUrl ?? ""}::${pluginId}`;
}

function createIssue(
  code: NovelSourceClassificationIssue["code"],
  message: string,
  severity: NovelSourceClassificationIssue["severity"],
): NovelSourceClassificationIssue {
  return { code, message, severity };
}

function messageHasAny(input: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(input));
}

function classifyFailureIssues(errorMessage: string): NovelSourceClassificationIssue[] {
  const issues: NovelSourceClassificationIssue[] = [];
  if (messageHasAny(errorMessage, [
    /cloudflare/i,
    /captcha/i,
    /redirect/i,
    /challenge/i,
    /anti-bot/i,
    /just a moment/i,
  ])) {
    issues.push(createIssue("anti-bot-redirect", errorMessage, "error"));
  }
  if (messageHasAny(errorMessage, [
    /@libs\//i,
    /Cannot find module/i,
    /is not a function/i,
    /is not defined/i,
  ])) {
    issues.push(createIssue("runtime-helper-mismatch", errorMessage, "error"));
  }
  if (messageHasAny(errorMessage, [
    /unsupported/i,
    /searchNovels/i,
    /parseNovel/i,
    /parseChapter/i,
  ])) {
    issues.push(createIssue("unsupported-plugin-shape", errorMessage, "error"));
  }
  return issues;
}

function hasCharsetSuspect(input: string | null | undefined): boolean {
  if (!input) return false;
  return /Ã.|Â.|�/.test(input);
}

function dedupeIssues(issues: NovelSourceClassificationIssue[]): NovelSourceClassificationIssue[] {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    const key = `${issue.code}::${issue.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildNotes(input: {
  status: NovelSourceClassificationStatus;
  issues: NovelSourceClassificationIssue[];
  baselineNotes: string | null;
  search: AutomaticClassificationSearchOutcome;
}): string {
  if (input.issues.length > 0) {
    return input.issues.map((issue) => issue.message).join(" ");
  }
  if (input.status === "migration-safe") {
    return `Automatic smoke passed plugin load, search, details, and chapter for ${input.search.resultTitle ?? "the selected novel"} on this profile.`;
  }
  if (input.status === "working") {
    return "Automatic smoke passed plugin load, search, details, and chapter for this source on the current profile.";
  }
  return input.baselineNotes ?? "Automatic classification is pending for this source.";
}

function deriveStatus(input: {
  baselineStatus: NovelSourceClassificationStatus | null;
  issues: NovelSourceClassificationIssue[];
  smoke: PersistedNovelSourceClassificationRecord["smoke"];
}): NovelSourceClassificationStatus {
  if (input.issues.some((issue) => issue.code === "anti-bot-redirect")) {
    return "blocked-by-site";
  }
  if (input.issues.some((issue) => issue.code === "runtime-helper-mismatch" || issue.code === "unsupported-plugin-shape")) {
    return "runtime-gap";
  }
  if (input.smoke.pluginLoadConfirmed && input.smoke.searchConfirmed && input.smoke.detailsConfirmed && input.smoke.chapterConfirmed) {
    if (input.issues.some((issue) => issue.code === "charset-suspect" || issue.code === "weak-metadata")) {
      return "working-with-known-limitations";
    }
    if (input.baselineStatus === "migration-safe") {
      return "migration-safe";
    }
    if (input.baselineStatus === "working-with-known-limitations") {
      return "working-with-known-limitations";
    }
    return "working";
  }
  if (input.baselineStatus === "blocked-by-site" || input.baselineStatus === "runtime-gap") {
    return input.baselineStatus;
  }
  return "pending";
}

function pickCandidatePath(
  preferredPathIncludes: string[] | undefined,
  results: Awaited<ReturnType<typeof searchInstalledNovelSource>>,
): Array<{ path: string; title: string | null }> {
  const preferredResults = results.filter((entry) => preferredPathIncludes?.some((fragment) => entry.path.includes(fragment)));
  const remainingResults = results.filter((entry) => !preferredResults.includes(entry));
  return [...preferredResults, ...remainingResults]
    .slice(0, 3)
    .map((entry) => ({ path: entry.path, title: entry.title }));
}

async function collectBrowseSeedTitles(
  scopeInput: NovelRepositoryScopeInput,
  pluginId: string,
): Promise<string[]> {
  const titles: string[] = [];
  const seen = new Set<string>();

  for (let pageNo = 1; pageNo <= AUTOMATIC_BROWSE_PAGES && titles.length < AUTOMATIC_BROWSE_TITLE_LIMIT; pageNo++) {
    let browseResults: Awaited<ReturnType<typeof browseInstalledNovelSource>>;
    try {
      browseResults = await browseInstalledNovelSource(scopeInput, pluginId, pageNo);
    } catch {
      continue;
    }

    for (const entry of browseResults) {
      const title = entry.title?.trim();
      if (!title || seen.has(title)) {
        continue;
      }

      seen.add(title);
      titles.push(title);
      if (titles.length >= AUTOMATIC_BROWSE_TITLE_LIMIT) {
        break;
      }
    }
  }

  return titles;
}

async function validateSearchCandidate(
  scopeInput: NovelRepositoryScopeInput,
  pluginId: string,
  candidate: { path: string; title: string | null },
  issues: NovelSourceClassificationIssue[],
  smoke: {
    pluginLoadConfirmed: boolean;
    searchConfirmed: boolean;
    detailsConfirmed: boolean;
    chapterConfirmed: boolean;
  },
  searchOutcome: AutomaticClassificationSearchOutcome,
): Promise<boolean> {
  searchOutcome.resultPath = candidate.path;
  searchOutcome.resultTitle = candidate.title;
  smoke.searchConfirmed = true;

  try {
    const details = await readInstalledNovelDetails(scopeInput, pluginId, candidate.path, {
      title: candidate.title,
    });
    smoke.detailsConfirmed = true;
    if (hasCharsetSuspect(details.title) || hasCharsetSuspect(details.description)) {
      issues.push(createIssue("charset-suspect", "Automatic smoke observed suspicious mojibake or charset artifacts in details metadata.", "warning"));
    }
    if (!details.coverUrl || !details.author || !details.status) {
      issues.push(createIssue("weak-metadata", "Automatic smoke returned readable content, but the source still exposed weak or incomplete metadata.", "warning"));
    }

    const firstChapter = details.chapters.find((entry) => entry.path) ?? null;
    if (!firstChapter?.path) {
      issues.push(createIssue("chapter-empty", "Automatic smoke details payload did not include a readable chapter path.", "error"));
      return false;
    }

    try {
      const chapter = await readInstalledNovelChapter(scopeInput, pluginId, firstChapter.path);
      smoke.chapterConfirmed = true;
      if (hasCharsetSuspect(chapter.content)) {
        issues.push(createIssue("charset-suspect", "Automatic smoke observed suspicious mojibake or charset artifacts in chapter content.", "warning"));
      }
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(createIssue("chapter-failed", message, "error"), ...classifyFailureIssues(message));
      return false;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    issues.push(createIssue("details-failed", message, "error"), ...classifyFailureIssues(message));
    return false;
  }
}

export function buildAutomaticSearchTerms(input: {
  lang: string | null | undefined;
  recipeTerms?: string[] | null;
  browseSeedTitles?: string[] | null;
}): string[] {
  const language = (input.lang ?? "").toLowerCase();
  const genericTerms = language.startsWith("pt")
    ? GENERIC_AUTOMATIC_SEARCH_TERMS.pt
    : GENERIC_AUTOMATIC_SEARCH_TERMS.en;

  return [...new Set([
    ...(input.recipeTerms ?? []),
    ...(input.browseSeedTitles ?? []),
    ...genericTerms,
  ])];
}

export function needsAutomaticNovelSourceClassification(
  classificationState: PersistedNovelSourceClassificationState,
  plugin: { pluginId: string; version: string; enabled: boolean },
  repository: { trustState: string; enabled: boolean } | null,
): boolean {
  if (!plugin.enabled || !repository || repository.enabled === false || repository.trustState !== "trusted") {
    return false;
  }
  const record = getNovelSourceClassificationRecord(classificationState, plugin.pluginId);
  return !record || record.version !== plugin.version;
}

export function hasReusableNovelSourceClassification(
  classificationState: PersistedNovelSourceClassificationState,
  pluginId: string,
  version: string,
): boolean {
  const record = getNovelSourceClassificationRecord(classificationState, pluginId);
  return Boolean(record && record.version === version && record.status !== "pending");
}

export async function setQueuedNovelSourceClassification(
  scopeInput: NovelRepositoryScopeInput,
  input: {
    pluginId: string;
    version: string | null;
    repositoryId: string | null;
    repositoryUrl: string | null;
    lang: string | null;
  },
): Promise<PersistedNovelSourceClassificationRecord> {
  const baseline = getNovelSourceClassificationBaselineRecord(input.pluginId);
  const state = await loadNovelSourceClassificationState(scopeInput);
  const queuedRecord: PersistedNovelSourceClassificationRecord = {
    pluginId: input.pluginId,
    repositoryId: input.repositoryId,
    repositoryUrl: input.repositoryUrl,
    lang: input.lang,
    version: input.version,
    status: "pending",
    notes: "Automatic smoke queued after install/update for this profile.",
    baselineStatus: baseline?.status ?? null,
    baselineNotes: baseline?.notes ?? null,
    issues: [createIssue("automatic-smoke-queued", "Automatic smoke queued after install/update for this profile.", "info")],
    smoke: {
      pluginLoadConfirmed: false,
      searchConfirmed: false,
      detailsConfirmed: false,
      chapterConfirmed: false,
    },
    filterKeys: [],
    pluginSettingsKeys: [],
    classifiedAtMs: Date.now(),
  };

  await saveNovelSourceClassificationState(upsertNovelSourceClassificationRecord(state, queuedRecord), scopeInput);
  return queuedRecord;
}

export async function runAutomaticNovelSourceClassification(
  scopeInput: NovelRepositoryScopeInput,
  pluginId: string,
): Promise<PersistedNovelSourceClassificationRecord> {
  const key = classificationKey(scopeInput, pluginId);
  const existing = inFlightClassifications.get(key);
  if (existing) {
    return existing;
  }

  const promise = (async () => {
    const baseline = getNovelSourceClassificationBaselineRecord(pluginId);
    const recipe = getNovelSourceAutomaticSmokeRecipe(pluginId);
    const state = await loadNovelSourceClassificationState(scopeInput);
    const installedSources = await loadInstalledNovelSources(scopeInput);
    const source = installedSources.find((entry) => entry.pluginId === pluginId) ?? null;

    if (!source || !source.enabled || source.trustState !== "trusted") {
      const record: PersistedNovelSourceClassificationRecord = {
        pluginId,
        repositoryId: source?.repositoryId ?? null,
        repositoryUrl: source?.repositoryUrl ?? null,
        lang: source?.lang ?? baseline?.lang ?? null,
        version: source?.version ?? null,
        status: "pending",
        notes: "This source must stay installed, enabled, and trusted before automatic classification can run.",
        baselineStatus: baseline?.status ?? null,
        baselineNotes: baseline?.notes ?? null,
        issues: [createIssue("plugin-load-failed", "This source must stay installed, enabled, and trusted before automatic classification can run.", "warning")],
        smoke: {
          pluginLoadConfirmed: false,
          searchConfirmed: false,
          detailsConfirmed: false,
          chapterConfirmed: false,
        },
        filterKeys: [],
        pluginSettingsKeys: [],
        classifiedAtMs: Date.now(),
      };
      await saveNovelSourceClassificationState(upsertNovelSourceClassificationRecord(state, record), scopeInput);
      return record;
    }

    const issues: NovelSourceClassificationIssue[] = [];
    const smoke = {
      pluginLoadConfirmed: false,
      searchConfirmed: false,
      detailsConfirmed: false,
      chapterConfirmed: false,
    };
    const searchOutcome: AutomaticClassificationSearchOutcome = {
      term: null,
      resultPath: null,
      resultTitle: null,
    };
    const attemptedTerms = new Set<string>();
    const automaticSearchTerms = buildAutomaticSearchTerms({
      lang: source.lang ?? baseline?.lang,
      recipeTerms: recipe?.searchTerms ?? null,
    });
    let filterKeys: string[] = [];
    let pluginSettingsKeys: string[] = [];
    let browseSeedTitles: string[] = [];

    async function trySearchTerms(terms: string[]): Promise<boolean> {
      for (const term of terms) {
        if (!term || attemptedTerms.has(term)) {
          continue;
        }
        attemptedTerms.add(term);

        try {
          const currentResults = await searchInstalledNovelSource(scopeInput, pluginId, term, 1);
          if (currentResults.length > 0) {
            searchOutcome.term = term;
            const candidates = pickCandidatePath(recipe?.preferredPathIncludes, currentResults);
            smoke.searchConfirmed = true;

            for (const candidate of candidates) {
              const validated = await validateSearchCandidate(scopeInput, pluginId, candidate, issues, smoke, searchOutcome);
              if (validated) {
                return true;
              }
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          issues.push(createIssue("search-failed", message, "error"), ...classifyFailureIssues(message));
          if (issues.some((issue) => issue.code === "anti-bot-redirect" || issue.code === "runtime-helper-mismatch" || issue.code === "unsupported-plugin-shape")) {
            return false;
          }
        }
      }

      return false;
    }

    try {
      const runtimeSummary = await readInstalledNovelSourceRuntimeSummary(scopeInput, pluginId);
      smoke.pluginLoadConfirmed = true;
      filterKeys = runtimeSummary.filterKeys;
      pluginSettingsKeys = runtimeSummary.pluginSettingsKeys;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push(createIssue("plugin-load-failed", message, "error"), ...classifyFailureIssues(message));
    }

    if (smoke.pluginLoadConfirmed) {
      if (!recipe) {
        issues.push(createIssue("no-bounded-smoke-recipe", "This source used the generic automatic smoke bank because no source-specific override exists yet.", "info"));
      }

      await trySearchTerms(automaticSearchTerms);

      if (!smoke.detailsConfirmed || !smoke.chapterConfirmed) {
        browseSeedTitles = await collectBrowseSeedTitles(scopeInput, pluginId);
        if (browseSeedTitles.length > 0) {
          await trySearchTerms(buildAutomaticSearchTerms({
            lang: source.lang ?? baseline?.lang,
            recipeTerms: recipe?.searchTerms ?? null,
            browseSeedTitles,
          }));
        }
      }

      if (!smoke.searchConfirmed && issues.length === 0) {
        issues.push(createIssue("search-returned-no-results", "Automatic smoke could not find a bounded search result for this source.", "warning"));
      }
    }

    const dedupedIssues = dedupeIssues(issues);
    const status = deriveStatus({
      baselineStatus: baseline?.status ?? null,
      issues: dedupedIssues,
      smoke,
    });
    const record: PersistedNovelSourceClassificationRecord = {
      pluginId,
      repositoryId: source.repositoryId,
      repositoryUrl: source.repositoryUrl,
      lang: source.lang,
      version: source.version,
      status,
      notes: buildNotes({
        status,
        issues: dedupedIssues,
        baselineNotes: baseline?.notes ?? null,
        search: searchOutcome,
      }),
      baselineStatus: baseline?.status ?? null,
      baselineNotes: baseline?.notes ?? null,
      issues: dedupedIssues,
      smoke,
      filterKeys,
      pluginSettingsKeys,
      classifiedAtMs: Date.now(),
    };

    await saveNovelSourceClassificationState(upsertNovelSourceClassificationRecord(state, record), scopeInput);
    return record;
  })().finally(() => {
    inFlightClassifications.delete(key);
  });

  inFlightClassifications.set(key, promise);
  return promise;
}
