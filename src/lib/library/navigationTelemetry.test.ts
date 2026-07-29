import { describe, expect, test } from "vitest";
// The production gate is a Node script; keeping aggregation there avoids shipping audit code.
import {
  classifyThermalState,
  percentile,
  summarizeDirectionalTransitions,
  summarizeResourceGrowth,
} from "../../../scripts/library-navigation-metrics.mjs";

type ThermalSummary = {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  samplesMs: number[];
};

type DirectionalSummary = Record<
  "comics-to-books" | "books-to-comics",
  Record<"all" | "cold" | "warm" | "cached", ThermalSummary>
>;

type ResourceGrowthSummary = Record<string, {
  first: number | null;
  last: number | null;
  max: number | null;
  delta: number | null;
  monotonicIncrease: boolean;
}>;

describe("library navigation telemetry aggregation", () => {
  test("classifies first, second, and repeated activations", () => {
    expect(classifyThermalState(0)).toBe("cold");
    expect(classifyThermalState(1)).toBe("warm");
    expect(classifyThermalState(2)).toBe("cached");
    expect(classifyThermalState(12)).toBe("cached");
  });

  test("computes interpolated percentiles without mutating samples", () => {
    const samples = [80, 20, 40, 60];
    expect(percentile(samples, 0.5)).toBe(50);
    expect(percentile(samples, 0.95)).toBeCloseTo(77);
    expect(samples).toEqual([80, 20, 40, 60]);
  });

  test("keeps direction and thermal state independent", () => {
    const summary = summarizeDirectionalTransitions([
      { direction: "comics-to-books", thermalState: "cold", durationMs: 100 },
      { direction: "comics-to-books", thermalState: "warm", durationMs: 60 },
      { direction: "comics-to-books", thermalState: "cached", durationMs: 40 },
      { direction: "books-to-comics", thermalState: "cold", durationMs: 90 },
      { direction: "books-to-comics", thermalState: "cached", durationMs: 30 },
    ]) as DirectionalSummary;

    expect(summary["comics-to-books"].cold.samplesMs).toEqual([100]);
    expect(summary["comics-to-books"].all.p50Ms).toBe(60);
    expect(summary["books-to-comics"].warm.count).toBe(0);
    expect(summary["books-to-comics"].cached.samplesMs).toEqual([30]);
  });

  test("reports resource deltas and monotonic growth separately", () => {
    const summary = summarizeResourceGrowth([
      { listeners: 0, observers: 1, heapBytes: 100 },
      { listeners: 1, observers: 1, heapBytes: 120 },
      { listeners: 2, observers: 1, heapBytes: 110 },
    ], ["listeners", "observers", "heapBytes"]) as ResourceGrowthSummary;

    expect(summary.listeners).toMatchObject({ first: 0, last: 2, delta: 2, monotonicIncrease: true });
    expect(summary.observers).toMatchObject({ delta: 0, monotonicIncrease: false });
    expect(summary.heapBytes).toMatchObject({ max: 120, delta: 10, monotonicIncrease: false });
  });
});
