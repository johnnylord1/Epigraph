import type { SourceFilter, SourceFilterChange } from "../manga/runtime/types";
import { recommendationTagTokens } from "./metadata";

// Lists that leave a genre out, not the ones that pick it.
const EXCLUDING_FILTER = /exclu|without|sem |sin |except/i;
const GENRE_FILTER = /genre|g[eê]nero|tag|categor|theme|tema/i;
// Toonily and others count the works in each option: "Action (171)".
const OPTION_COUNT = /\s*\(\d+\)\s*$/;

function sameTokens(option: string, genre: ReadonlySet<string>): boolean {
  const tokens = recommendationTagTokens(option.replace(OPTION_COUNT, ""));
  return tokens.length === genre.size && tokens.every((token) => genre.has(token));
}

function groupChange(group: SourceFilter, position: number, genre: ReadonlySet<string>): SourceFilterChange | null {
  const index = group.filters.findIndex(
    (child) => (child.kind === "checkbox" || child.kind === "tristate") && sameTokens(child.name, genre),
  );
  if (index < 0) return null;
  const child = group.filters[index]!;
  return {
    position,
    groupChange: child.kind === "checkbox"
      ? { position: index, checkBoxState: true }
      : { position: index, triState: "INCLUDE" },
  };
}

function selectChange(select: SourceFilter, position: number, genre: ReadonlySet<string>): SourceFilterChange | null {
  const index = select.values.findIndex((value) => sameTokens(value, genre));
  return index < 0 ? null : { position, selectState: index };
}

/**
 * The change that makes a source's own search list one genre, read from the filters the source
 * declares. Names are matched as recommendation tags, so a source's "Sci-fi", "Science Fiction" or
 * "Ficção científica" all answer the reader's "Sci-Fi". Null when the source cannot search by it.
 */
export function sourceGenreFilterChange(
  filters: readonly SourceFilter[],
  genre: string,
): SourceFilterChange | null {
  const tokens = new Set(recommendationTagTokens(genre));
  if (tokens.size === 0) return null;
  const candidates = filters
    .map((filter, position) => ({ filter, position }))
    .filter(({ filter }) => (filter.kind === "group" || filter.kind === "select") && !EXCLUDING_FILTER.test(filter.name))
    // A list named for genres comes before any other list that happens to hold the same word.
    .sort((a, b) => Number(GENRE_FILTER.test(b.filter.name)) - Number(GENRE_FILTER.test(a.filter.name)));
  for (const { filter, position } of candidates) {
    const change = filter.kind === "group"
      ? groupChange(filter, position, tokens)
      : selectChange(filter, position, tokens);
    if (change) return change;
  }
  return null;
}

interface NovelFilterOption {
  label?: unknown;
  value?: unknown;
}

interface NovelFilter {
  type?: unknown;
  label?: unknown;
  value?: unknown;
  options?: unknown;
}

/**
 * The filters that make a novel source's popular list one genre: the plugin's own filters with a
 * genre list set to that genre. Only lists named for genres (or tags or categories) are used, so a
 * listing or a status that happens to share a word is never taken for a genre. Null when the source
 * cannot list by it.
 */
export function novelSourceGenreFilters(
  filters: Readonly<Record<string, unknown>>,
  genre: string,
): Record<string, unknown> | null {
  const tokens = new Set(recommendationTagTokens(genre));
  if (tokens.size === 0) return null;
  const lists = Object.entries(filters)
    .filter((entry): entry is [string, NovelFilter] => Boolean(entry[1]) && typeof entry[1] === "object")
    .filter(([key, filter]) => {
      const name = `${key} ${typeof filter.label === "string" ? filter.label : ""}`;
      return GENRE_FILTER.test(name) && !EXCLUDING_FILTER.test(name) && Array.isArray(filter.options);
    })
    // Genres before tags and categories, which hold many narrower names.
    .sort(([keyA, a], [keyB, b]) => Number(/genre|g[eê]nero/i.test(`${keyB} ${b.label}`)) - Number(/genre|g[eê]nero/i.test(`${keyA} ${a.label}`)));
  for (const [key, filter] of lists) {
    const option = (filter.options as NovelFilterOption[]).find((entry) =>
      typeof entry?.label === "string"
      && entry.value !== "" && entry.value != null
      && sameTokens(entry.label, tokens),
    );
    if (!option) continue;
    let value: unknown;
    if (filter.type === "Picker") value = option.value;
    else if (filter.type === "Checkbox") value = [option.value];
    else if (filter.type === "XCheckbox") value = { include: [option.value], exclude: [] };
    else continue;
    return { ...structuredClone(filters), [key]: { ...structuredClone(filter), value } };
  }
  return null;
}
