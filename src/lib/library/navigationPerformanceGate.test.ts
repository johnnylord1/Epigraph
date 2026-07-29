import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const read = (path: string) => readFileSync(resolve(path), "utf8");

describe("library navigation performance gate", () => {
  test("keeps process startup observational and app-owned activation blocking", () => {
    const budgets = JSON.parse(read("config/release-navigation-budgets.json"));

    expect(budgets.version).toBe(2);
    expect(budgets.startup.totalWallClockBlocking).toBe(false);
    expect(budgets.startup.shellActivationMaxMs).toBe(1000);
    expect(budgets.search.stateCycleMaxMs).toBe(100);
  });

  test("enforces directional thermal and resource budgets", () => {
    const budgets = JSON.parse(read("config/release-navigation-budgets.json"));
    const gate = read("scripts/check-navigation-performance.mjs");

    expect(budgets.library.warmCachedTotalP50MaxMs).toBe(92);
    expect(budgets.library.warmCachedAppOwnedP95MaxMs).toBe(120);
    expect(budgets.library.maxLongTaskDurationMs).toBe(100);
    expect(budgets.library.maxLongTaskTotalDurationMs).toBe(200);
    expect(budgets.library.maxPendingRafsAfterCycles).toBe(0);
    expect(budgets.library.maxRetainedHeapGrowthBytes).toBe(2_097_152);
    expect(budgets.library.maxRetainedHeapGrowthPercent).toBe(15);
    expect(budgets.library.coldAppOwnedP50BaselineMs).toEqual({
      "comics-to-books": 30,
      "books-to-comics": 30,
    });
    expect(gate).toContain('for (const direction of ["comics-to-books", "books-to-comics"])');
    expect(gate).toContain('for (const thermalState of ["warm", "cached"])');
    expect(gate).toContain("appOwnedP95Ms");
    expect(gate).toContain("blocking: false");
    expect(gate).toContain('setParameter("cmd", "HeapProfiler.collectGarbage")');
    expect(gate).toContain("summary.cold.count >= 5");
    expect(gate).toContain("libraryGateChecks.pendingRafsAfterCycles");
    expect(gate).toContain("libraryGateChecks.retainedHeapAfterCycles");
    expect(gate).toContain("searchStateCycleMedianMs");
    expect(gate).toContain("const collectResourceEvidence = iteration === 0");
    expect(gate).toContain("sample.longTasks.maxDurationMs");
    expect(gate).toContain("observationalStartupRegression");
  });
});
