import type { Extension } from "./types";
import { extensionStoreBaseUrl } from "./manga/runtime/storeUrl";

export interface MissingSourceRef {
  id: string;
  name: string;
}

export interface MissingSourceExtensionSuggestion {
  missingSource: MissingSourceRef;
  extension: Extension;
  matchedBy: "source-id" | "source-name";
}

export interface RepoSourceEntry {
  id: string;
  name: string;
  lang?: string;
}

export interface RepoExtensionEntry {
  name: string;
  pkg: string;
  apk: string;
  lang?: string;
  sources?: RepoSourceEntry[];
  /** Icon the catalog links for the extension; v2 stores no longer keep an icon folder. */
  icon?: string;
}

export interface MissingSourceSuggestionResult {
  suggestions: MissingSourceExtensionSuggestion[];
  failedRepos: string[];
}

interface V2RepoExtensionEntry {
  name?: unknown;
  packageName?: unknown;
  resources?: { apkUrl?: unknown; iconUrl?: unknown } | null;
  sources?: Array<{ id?: unknown; name?: unknown; language?: unknown }> | null;
}

function extensionBaseName(name: string): string {
  return name.replace(/\s*\([A-Z0-9-]{2,10}\)\s*$/, "").trim();
}

function normalizeName(name: string): string {
  return extensionBaseName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function preferredLangRank(lang: string, preferredLang: string): number {
  const normalized = lang.toLowerCase();
  if (normalized === preferredLang) return 3;
  if (normalized === "en") return 2;
  if (normalized === "all") return 1;
  return 0;
}

function sortByPreferredLang<T extends { lang?: string }>(items: T[], preferredLang: string): T[] {
  return [...items].sort((left, right) =>
    preferredLangRank(right.lang ?? "", preferredLang) - preferredLangRank(left.lang ?? "", preferredLang),
  );
}

/** Catalog files to try, in order, for an extension store URL (index.json first: some stores keep a stub index.min.json). */
export function repoCatalogCandidates(url: string): string[] {
  const base = extensionStoreBaseUrl(url);
  const candidates = [`${base}/index.json`, `${base}/index.min.json`];
  if (/\.json(?:[?#].*)?$/i.test(url) && !/\/repo\.json(?:[?#].*)?$/i.test(url) && !candidates.includes(url)) candidates.push(url);
  return candidates;
}

function parseRepoCatalog(parsed: unknown): RepoExtensionEntry[] {
  if (Array.isArray(parsed)) return parsed as RepoExtensionEntry[];
  if (typeof parsed !== "object" || parsed === null || !("extensionList" in parsed)) throw new Error("Repo index does not contain an extension catalog");
  const extensionList = (parsed as { extensionList: unknown }).extensionList;
  if (typeof extensionList !== "object" || extensionList === null || !("extensions" in extensionList)) throw new Error("Repo index does not contain an extension catalog");
  const v2Entries = (extensionList as { extensions: unknown }).extensions;
  if (!Array.isArray(v2Entries)) throw new Error("Repo index does not contain an extension catalog");
  return v2Entries.flatMap((raw: V2RepoExtensionEntry) => {
    if (typeof raw?.name !== "string" || typeof raw?.packageName !== "string") return [];
    const sources = Array.isArray(raw.sources)
      ? raw.sources.flatMap((source) => (
        source?.id != null && typeof source.name === "string"
          ? [{
              id: String(source.id),
              name: source.name,
              lang: typeof source.language === "string" ? source.language : undefined,
            }]
          : []
      ))
      : [];
    return [{
      name: raw.name,
      pkg: raw.packageName,
      apk: typeof raw.resources?.apkUrl === "string" ? raw.resources.apkUrl : "",
      lang: sources[0]?.lang,
      sources,
      icon: typeof raw.resources?.iconUrl === "string" && raw.resources.iconUrl ? raw.resources.iconUrl : undefined,
    } satisfies RepoExtensionEntry];
  });
}

export async function fetchRepoEntries(urls: string[]): Promise<{ entries: RepoExtensionEntry[]; failedRepos: string[] }> {
  const entries: RepoExtensionEntry[] = [];
  const failedRepos: string[] = [];

  for (const url of urls) {
    let loaded: RepoExtensionEntry[] | null = null;
    for (const catalogUrl of repoCatalogCandidates(url)) {
      try {
        const response = await fetch(catalogUrl);
        const text = await response.text();
        if (!response.ok) throw new Error(text.slice(0, 120));
        loaded = parseRepoCatalog(JSON.parse(text));
        break;
      } catch {
        // try the next catalog file
      }
    }
    if (loaded) entries.push(...loaded);
    else failedRepos.push(url);
  }

  return { entries, failedRepos };
}

function resolveExtensionCandidate(
  repoCandidates: RepoExtensionEntry[],
  availableExtensions: Extension[],
  preferredLang: string,
): Extension[] {
  const availableByPkg = new Map(
    availableExtensions
      .filter((extension) => !extension.isInstalled)
      .map((extension) => [extension.pkgName, extension] as const),
  );

  const uniqueExtensions = new Map<string, Extension>();
  for (const candidate of sortByPreferredLang(repoCandidates, preferredLang)) {
    const extension = availableByPkg.get(candidate.pkg);
    if (!extension) continue;
    if (!uniqueExtensions.has(extension.pkgName)) uniqueExtensions.set(extension.pkgName, extension);
  }

  return sortByPreferredLang([...uniqueExtensions.values()], preferredLang);
}

export async function findMissingSourceExtensionSuggestions(
  missingSources: MissingSourceRef[],
  repoUrls: string[],
  availableExtensions: Extension[],
  preferredLang: string,
): Promise<MissingSourceSuggestionResult> {
  if (missingSources.length === 0 || repoUrls.length === 0) {
    return { suggestions: [], failedRepos: [] };
  }

  const { entries, failedRepos } = await fetchRepoEntries(repoUrls);
  const suggestions: MissingSourceExtensionSuggestion[] = [];
  const usedPkgNames = new Set<string>();

  for (const missingSource of missingSources) {
    const byId = entries.filter((entry) =>
      entry.sources?.some((source) => String(source.id) === String(missingSource.id)),
    );
    const idMatches = resolveExtensionCandidate(byId, availableExtensions, preferredLang);
    for (const extension of idMatches) {
      if (usedPkgNames.has(extension.pkgName)) continue;
      usedPkgNames.add(extension.pkgName);
      suggestions.push({ missingSource, extension, matchedBy: "source-id" });
    }
    if (idMatches.length > 0) continue;

    const normalizedMissingName = normalizeName(missingSource.name);
    if (!normalizedMissingName || /^\d+$/.test(normalizedMissingName)) continue;

    const byName = entries.filter((entry) =>
      entry.sources?.some((source) => normalizeName(source.name) === normalizedMissingName),
    );
    const nameMatches = resolveExtensionCandidate(byName, availableExtensions, preferredLang);
    for (const extension of nameMatches) {
      if (usedPkgNames.has(extension.pkgName)) continue;
      usedPkgNames.add(extension.pkgName);
      suggestions.push({ missingSource, extension, matchedBy: "source-name" });
    }
  }

  return { suggestions, failedRepos };
}
