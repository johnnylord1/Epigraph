// Types for library-navigation-metrics.mjs, which the navigation telemetry tests import.

export function percentile(values: ReadonlyArray<number | null | undefined>, quantile: number): number | null;

export function classifyThermalState(targetActivationCount: number): "cold" | "warm" | "cached";

export function summarizeDirectionalTransitions(samples: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>;

export function summarizeResourceGrowth(
  samples: ReadonlyArray<Record<string, unknown> | null | undefined>,
  keys: readonly string[],
): Record<string, unknown>;
