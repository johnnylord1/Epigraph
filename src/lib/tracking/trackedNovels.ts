import { recommendationTitleKey } from "../recommendations/identity";
import type { AniListMediaProfile } from "../recommendations/anilistMedia";
import type { TasteProfileSeedItem } from "../recommendations/types";

/**
 * A novel or book the user tracks on a novel tracker. Tracking it means the user picked its entry on
 * the tracker, so that entry is the work for certain: its genres, names and ids outrank whatever the
 * background analysis guessed from the library title, and the user's rating and status there are
 * their opinion of the library work.
 */
export interface TrackedNovel {
  /** "<tracker>:<id on the tracker>", the id of the tracker's own taste seed for the work. */
  key: string;
  /** The library novel or book it was tracked from; null for works tracked elsewhere. */
  sourceNovelId: string | null;
  /** The normalized title it was linked under, for links made before novel ids were kept. */
  sourceTitleKey: string | null;
  profile: AniListMediaProfile;
  userRating: number | null;
  userRatingMax: number | null;
  status: TasteProfileSeedItem["status"];
}

/**
 * The tracked entry of a library novel or book: the one linked to it, otherwise the one linked under
 * its title. A work linked by id never takes another's place, and for a novel with an id an unlinked
 * title counts only when a single tracked entry has it.
 */
export function findTrackedNovel(
  tracked: readonly TrackedNovel[],
  input: { novelId?: string | null; title?: string | null },
): TrackedNovel | null {
  if (input.novelId) {
    const exact = tracked.find((entry) => entry.sourceNovelId === input.novelId);
    if (exact) return exact;
  }
  const titleKey = input.title ? recommendationTitleKey(input.title, "novel") : null;
  if (!titleKey) return null;
  const byTitle = tracked.filter((entry) =>
    (!input.novelId || !entry.sourceNovelId)
    && (entry.sourceTitleKey === titleKey
      || entry.profile.titles.some((title) => recommendationTitleKey(title, "novel") === titleKey)));
  if (input.novelId) return byTitle.length === 1 ? byTitle[0] : null;
  return byTitle[0] ?? null;
}
