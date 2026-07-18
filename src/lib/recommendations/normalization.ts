import type { NormalizedMetric } from "./types";

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function normalizedMetric(
  value: number,
  confidence: number,
  method: string,
  sourceValue?: string,
): NormalizedMetric {
  return {
    value: clamp01(value),
    confidence: clamp01(confidence),
    method,
    sourceValue,
  };
}

export function normalizeScore(
  score: number | null | undefined,
  scaleMax = 10,
  confidence = 1,
): NormalizedMetric | undefined {
  if (typeof score !== "number" || !Number.isFinite(score) || scaleMax <= 0) return undefined;
  return normalizedMetric(score / scaleMax, confidence, `score/${scaleMax}`, String(score));
}

export function normalizeRank(
  rank: number | null | undefined,
  total: number | null | undefined,
  confidence = 0.8,
): NormalizedMetric | undefined {
  if (
    typeof rank !== "number"
    || typeof total !== "number"
    || !Number.isFinite(rank)
    || !Number.isFinite(total)
    || rank <= 0
    || total <= 1
  ) {
    return undefined;
  }
  return normalizedMetric(1 - ((rank - 1) / (total - 1)), confidence, "inverse-rank", `#${rank}`);
}

export function normalizePercentile(
  percentile: number | null | undefined,
  confidence = 0.75,
): NormalizedMetric | undefined {
  if (typeof percentile !== "number" || !Number.isFinite(percentile)) return undefined;
  return normalizedMetric(percentile > 1 ? percentile / 100 : percentile, confidence, "percentile", String(percentile));
}

export function normalizeLogCount(
  count: number | null | undefined,
  benchmarkCount: number,
  confidence = 0.65,
): NormalizedMetric | undefined {
  if (
    typeof count !== "number"
    || !Number.isFinite(count)
    || count < 0
    || !Number.isFinite(benchmarkCount)
    || benchmarkCount <= 0
  ) {
    return undefined;
  }
  const value = Math.log1p(count) / Math.log1p(benchmarkCount);
  return normalizedMetric(value, confidence, "log-count", String(count));
}

export function normalizeRecency(
  dateMs: number | string | Date | null | undefined,
  nowMs = Date.now(),
  halfLifeDays = 14,
  confidence = 0.7,
): NormalizedMetric | undefined {
  const timestamp = toTimestamp(dateMs);
  if (timestamp === null || halfLifeDays <= 0) return undefined;
  const ageDays = Math.max(0, (nowMs - timestamp) / 86_400_000);
  const value = Math.pow(0.5, ageDays / halfLifeDays);
  return normalizedMetric(value, confidence, "recency-decay", `${Math.round(ageDays)}d`);
}

export function combineMetrics(metrics: Array<NormalizedMetric | undefined | null>): NormalizedMetric | undefined {
  const valid = metrics.filter((metric): metric is NormalizedMetric =>
    metric != null && metric.confidence > 0,
  );
  if (valid.length === 0) return undefined;

  const confidenceSum = valid.reduce((sum, metric) => sum + metric.confidence, 0);
  const value = valid.reduce((sum, metric) => sum + (metric.value * metric.confidence), 0) / confidenceSum;
  const confidence = confidenceSum / valid.length;
  return normalizedMetric(value, confidence, "weighted-consensus");
}

export function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toTimestamp(value: number | string | Date | null | undefined): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  if (typeof value === "string" && value.trim()) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  return null;
}
