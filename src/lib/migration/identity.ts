export interface MigrationIdentitySettings {
  mangaLinks: Record<number, number[]>;
  novelLinks: Record<string, string[]>;
  booksCategoryAssignments: Record<string, string[]>;
}

export interface MigrationIdentityBridge {
  readonly profileId: string;
  read(): Promise<MigrationIdentityRevision>;
  write(input: {
    expectedRevision: string;
    next: MigrationIdentitySettings;
  }): Promise<MigrationIdentityRevision>;
}

export interface MigrationIdentityRevision {
  profileId: string;
  revision: string;
  settings: MigrationIdentitySettings;
}

export interface MigrationIdentityMapSlice<TValue extends string | number> {
  affectedKeys: string[];
  values: Record<string, TValue[]>;
}

export interface MigrationIdentitySlice {
  mangaLinks?: MigrationIdentityMapSlice<number>;
  novelLinks?: MigrationIdentityMapSlice<string>;
  booksCategoryAssignments?: MigrationIdentityMapSlice<string>;
}

function cloneMap<TValue extends string | number>(
  value: Record<string, TValue[]> | Record<number, TValue[]>,
): Record<string, TValue[]> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entries]) => [key, [...new Set(entries)]]),
  );
}

function stableMap<TValue extends string | number>(
  value: Record<string, TValue[]> | Record<number, TValue[]>,
): string {
  return JSON.stringify(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entries]) => [
        key,
        [...new Set(entries)].sort((left, right) => String(left).localeCompare(String(right))),
      ]),
  );
}

export function migrationIdentityRevision(settings: MigrationIdentitySettings): string {
  return [
    stableMap(settings.mangaLinks),
    stableMap(settings.novelLinks),
    stableMap(settings.booksCategoryAssignments),
  ].join("|");
}

function collectAffectedLinkKeys<TValue extends string | number>(
  links: Record<string, TValue[]>,
  sourceId: TValue,
  targetId: TValue,
): string[] {
  const sourceKey = String(sourceId);
  const targetKey = String(targetId);
  const keys = new Set([sourceKey, targetKey]);
  for (const [key, values] of Object.entries(links)) {
    if (values.includes(sourceId) || values.includes(targetId)) keys.add(key);
  }
  return [...keys].sort();
}

function captureMapSlice<TValue extends string | number>(
  values: Record<string, TValue[]>,
  affectedKeys: readonly string[],
): MigrationIdentityMapSlice<TValue> {
  return {
    affectedKeys: [...affectedKeys],
    values: Object.fromEntries(
      affectedKeys.flatMap((key) => (
        key in values ? [[key, [...(values[key] ?? [])]]] : []
      )),
    ),
  };
}

function restoreMapSlice<TValue extends string | number>(
  current: Record<string, TValue[]>,
  slice: MigrationIdentityMapSlice<TValue> | undefined,
): Record<string, TValue[]> {
  if (!slice) return cloneMap(current);
  const next = cloneMap(current);
  for (const key of slice.affectedKeys) {
    const value = slice.values[key];
    if (value?.length) next[key] = [...new Set(value)];
    else delete next[key];
  }
  return next;
}

function remapSymmetricLinks<TValue extends string | number>(
  input: Record<string, TValue[]>,
  sourceId: TValue,
  targetId: TValue,
  mode: "migrate" | "copy",
): Record<string, TValue[]> {
  const sourceKey = String(sourceId);
  const targetKey = String(targetId);
  const next = cloneMap(input);
  const sourceLinks = new Set(next[sourceKey] ?? []);
  const targetLinks = new Set(next[targetKey] ?? []);
  const related = new Set([...sourceLinks, ...targetLinks]);
  related.delete(sourceId);
  related.delete(targetId);

  next[targetKey] = [...related];
  if (mode === "migrate") delete next[sourceKey];
  else {
    next[sourceKey] = [...new Set([...sourceLinks, targetId])];
    next[targetKey] = [...new Set([...next[targetKey], sourceId])];
  }

  for (const relatedId of related) {
    const relatedKey = String(relatedId);
    const links = new Set(next[relatedKey] ?? []);
    if (mode === "migrate") links.delete(sourceId);
    links.add(targetId);
    links.delete(relatedId);
    next[relatedKey] = [...links];
  }

  return Object.fromEntries(
    Object.entries(next).filter(([, values]) => values.length > 0),
  );
}

function remapCategoryAssignments(
  input: Record<string, string[]>,
  sourceId: string,
  targetId: string,
  mode: "migrate" | "copy",
): Record<string, string[]> {
  const next = cloneMap(input);
  next[targetId] = [...new Set([...(next[targetId] ?? []), ...(next[sourceId] ?? [])])];
  if (mode === "migrate") delete next[sourceId];
  return Object.fromEntries(
    Object.entries(next).filter(([, values]) => values.length > 0),
  );
}

export function prepareMangaIdentityMigration(input: {
  current: MigrationIdentitySettings;
  sourceMangaId: number;
  targetMangaId: number;
  mode: "migrate" | "copy";
}): {
  previous: MigrationIdentitySlice;
  next: MigrationIdentitySettings;
  applied: MigrationIdentitySlice;
} {
  const currentLinks = cloneMap(input.current.mangaLinks);
  const nextLinks = remapSymmetricLinks(
    currentLinks,
    input.sourceMangaId,
    input.targetMangaId,
    input.mode,
  );
  const affectedKeys = collectAffectedLinkKeys(
    { ...currentLinks, ...nextLinks },
    input.sourceMangaId,
    input.targetMangaId,
  );
  return {
    previous: {
      mangaLinks: captureMapSlice(currentLinks, affectedKeys),
    },
    next: {
      ...input.current,
      mangaLinks: nextLinks as Record<number, number[]>,
    },
    applied: {
      mangaLinks: captureMapSlice(nextLinks, affectedKeys),
    },
  };
}

export function prepareNovelIdentityMigration(input: {
  current: MigrationIdentitySettings;
  sourceNovelId: string;
  targetNovelId: string;
}): {
  previous: MigrationIdentitySlice;
  next: MigrationIdentitySettings;
  applied: MigrationIdentitySlice;
} {
  const currentLinks = cloneMap(input.current.novelLinks);
  const nextLinks = remapSymmetricLinks(
    currentLinks,
    input.sourceNovelId,
    input.targetNovelId,
    "migrate",
  );
  const linkKeys = collectAffectedLinkKeys(
    { ...currentLinks, ...nextLinks },
    input.sourceNovelId,
    input.targetNovelId,
  );
  const currentAssignments = cloneMap(input.current.booksCategoryAssignments);
  const nextAssignments = remapCategoryAssignments(
    currentAssignments,
    input.sourceNovelId,
    input.targetNovelId,
    "migrate",
  );
  const assignmentKeys = [input.sourceNovelId, input.targetNovelId].sort();

  return {
    previous: {
      novelLinks: captureMapSlice(currentLinks, linkKeys),
      booksCategoryAssignments: captureMapSlice(currentAssignments, assignmentKeys),
    },
    next: {
      ...input.current,
      novelLinks: nextLinks as Record<string, string[]>,
      booksCategoryAssignments: nextAssignments,
    },
    applied: {
      novelLinks: captureMapSlice(nextLinks, linkKeys),
      booksCategoryAssignments: captureMapSlice(nextAssignments, assignmentKeys),
    },
  };
}

export function restoreMigrationIdentitySlice(
  current: MigrationIdentitySettings,
  slice: MigrationIdentitySlice | undefined,
): MigrationIdentitySettings {
  return {
    mangaLinks: restoreMapSlice(
      cloneMap(current.mangaLinks),
      slice?.mangaLinks,
    ) as Record<number, number[]>,
    novelLinks: restoreMapSlice(
      cloneMap(current.novelLinks),
      slice?.novelLinks,
    ),
    booksCategoryAssignments: restoreMapSlice(
      cloneMap(current.booksCategoryAssignments),
      slice?.booksCategoryAssignments,
    ),
  };
}

export function migrationIdentityMatchesSlice(
  current: MigrationIdentitySettings,
  slice: MigrationIdentitySlice | undefined,
): boolean {
  const restored = restoreMigrationIdentitySlice(current, slice);
  return migrationIdentityRevision(restored) === migrationIdentityRevision(current);
}
