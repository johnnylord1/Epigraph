import { translate } from "../i18n/runtime";

/**
 * How long the changes left should take, from how fast they went over the last `windowMs`.
 * Null until the run has gone on for `minSpanMs` with changes leaving: a guess from a few polls
 * swings too much to show. What a phone reports moves in steps and can rise while it uploads, so
 * the window, not the latest step, decides the pace.
 */
export function createSyncEta(windowMs = 120_000, minSpanMs = 20_000) {
  let samples: { at: number; remaining: number }[] = [];
  return {
    /** Seconds left at the current pace, or null while unknown. */
    sample(at: number, remaining: number | null): number | null {
      if (remaining === null || remaining <= 0) {
        samples = [];
        return null;
      }
      samples.push({ at, remaining });
      while (samples.length > 2 && at - samples[1].at >= windowMs) samples.shift();
      const first = samples[0];
      const span = at - first.at;
      const sent = first.remaining - remaining;
      if (span < minSpanMs || sent <= 0) return null;
      return Math.ceil((remaining * span) / sent / 1000);
    },
  };
}

/** The ETA sentence for `seconds`: under a minute, minutes rounded up, or hours past 90 minutes. */
export function syncEtaText(seconds: number): string {
  if (seconds < 60) return translate("firstRun.sync.etaSoon");
  if (seconds < 90 * 60) return translate("firstRun.sync.etaMinutes", { count: Math.ceil(seconds / 60) });
  return translate("firstRun.sync.etaHours", { count: Math.round(seconds / 3600) });
}
