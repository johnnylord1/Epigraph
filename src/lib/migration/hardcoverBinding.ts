import type { HardcoverNovelTrackRecord } from "../novels/hardcover";

export interface HardcoverBindingSlice {
  sourceNovelId: string;
  targetNovelId: string;
  affectedBookIds: number[];
  records: HardcoverNovelTrackRecord[];
}

export interface PreparedHardcoverBindingMigration {
  previous: HardcoverBindingSlice;
  applied: HardcoverBindingSlice;
  nextRecords: HardcoverNovelTrackRecord[];
}

function cloneRecords(records: readonly HardcoverNovelTrackRecord[]): HardcoverNovelTrackRecord[] {
  return structuredClone([...records]);
}

function recordKey(record: HardcoverNovelTrackRecord): string {
  return `${record.bookId}:${record.userBookId ?? ""}:${record.sourceNovelId ?? ""}`;
}

function affectedRecords(
  records: readonly HardcoverNovelTrackRecord[],
  sourceNovelId: string,
  targetNovelId: string,
): HardcoverNovelTrackRecord[] {
  return cloneRecords(records.filter((record) => (
    record.sourceNovelId === sourceNovelId
    || record.sourceNovelId === targetNovelId
  )).sort((left, right) => recordKey(left).localeCompare(recordKey(right))));
}

function stableRecords(records: readonly HardcoverNovelTrackRecord[]): string {
  return JSON.stringify(
    cloneRecords(records).sort((left, right) => recordKey(left).localeCompare(recordKey(right))),
  );
}

function mergeSameBookRecords(
  records: readonly HardcoverNovelTrackRecord[],
  targetNovelId: string,
): HardcoverNovelTrackRecord {
  const ordered = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
  const newest = ordered[0]!;
  const withUserBook = ordered.find((record) => record.userBookId != null);
  return {
    ...newest,
    userBookId: withUserBook?.userBookId ?? newest.userBookId,
    sourceNovelId: targetNovelId,
    sourceTitleKey: newest.sourceTitleKey
      ?? ordered.find((record) => record.sourceTitleKey)?.sourceTitleKey
      ?? null,
  };
}

export function prepareHardcoverBindingMigration(input: {
  records: readonly HardcoverNovelTrackRecord[];
  sourceNovelId: string;
  targetNovelId: string;
}): PreparedHardcoverBindingMigration {
  const sourceRecords = input.records.filter((record) => record.sourceNovelId === input.sourceNovelId);
  const targetRecords = input.records.filter((record) => record.sourceNovelId === input.targetNovelId);
  const sourceBookIds = new Set(sourceRecords.map((record) => record.bookId));
  const targetBookIds = new Set(targetRecords.map((record) => record.bookId));
  const userBookIds = new Set(
    [...sourceRecords, ...targetRecords]
      .map((record) => record.userBookId)
      .filter((value): value is number => value != null),
  );

  if (sourceBookIds.size > 1 || targetBookIds.size > 1) {
    throw new Error("Hardcover has multiple edition identities for this migration.");
  }
  if (userBookIds.size > 1) {
    throw new Error("The source and target have conflicting Hardcover user-book identities.");
  }
  if (
    sourceBookIds.size === 1
    && targetBookIds.size === 1
    && [...sourceBookIds][0] !== [...targetBookIds][0]
  ) {
    throw new Error("The source and target are linked to different Hardcover editions.");
  }

  const affectedBookIds = [...new Set([...sourceBookIds, ...targetBookIds])].sort((a, b) => a - b);
  const previous = affectedRecords(
    input.records,
    input.sourceNovelId,
    input.targetNovelId,
  );

  if (sourceRecords.length === 0) {
    return {
      previous: {
        sourceNovelId: input.sourceNovelId,
        targetNovelId: input.targetNovelId,
        affectedBookIds,
        records: previous,
      },
      applied: {
        sourceNovelId: input.sourceNovelId,
        targetNovelId: input.targetNovelId,
        affectedBookIds,
        records: previous,
      },
      nextRecords: cloneRecords(input.records),
    };
  }

  const affectedSet = new Set(previous.map(recordKey));
  const unaffected = input.records.filter((record) => !affectedSet.has(recordKey(record)));
  const nextAffected = [
    mergeSameBookRecords([...sourceRecords, ...targetRecords], input.targetNovelId),
  ];
  const nextRecords = [...cloneRecords(unaffected), ...nextAffected];

  return {
    previous: {
      sourceNovelId: input.sourceNovelId,
      targetNovelId: input.targetNovelId,
      affectedBookIds,
      records: previous,
    },
    applied: {
      sourceNovelId: input.sourceNovelId,
      targetNovelId: input.targetNovelId,
      affectedBookIds,
      records: affectedRecords(
        nextRecords,
        input.sourceNovelId,
        input.targetNovelId,
      ),
    },
    nextRecords,
  };
}

export function hardcoverBindingMatchesSlice(
  current: readonly HardcoverNovelTrackRecord[],
  slice: HardcoverBindingSlice,
): boolean {
  return stableRecords(affectedRecords(
    current,
    slice.sourceNovelId,
    slice.targetNovelId,
  )) === stableRecords(slice.records);
}

export function restoreHardcoverBindingSlice(
  current: readonly HardcoverNovelTrackRecord[],
  previous: HardcoverBindingSlice,
): HardcoverNovelTrackRecord[] {
  const unaffected = current.filter((record) => (
    record.sourceNovelId !== previous.sourceNovelId
    && record.sourceNovelId !== previous.targetNovelId
  ));
  return [...cloneRecords(unaffected), ...cloneRecords(previous.records)];
}

export function replaceHardcoverBindingSlice(
  current: readonly HardcoverNovelTrackRecord[],
  expected: HardcoverBindingSlice,
  next: HardcoverBindingSlice,
): HardcoverNovelTrackRecord[] {
  if (
    expected.sourceNovelId !== next.sourceNovelId
    || expected.targetNovelId !== next.targetNovelId
  ) {
    throw new Error("Hardcover binding slices do not describe the same migration.");
  }
  if (!hardcoverBindingMatchesSlice(current, expected)) {
    throw new Error("Hardcover identity changed concurrently. No newer tracking state was overwritten.");
  }
  return restoreHardcoverBindingSlice(current, next);
}
