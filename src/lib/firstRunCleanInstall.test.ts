import { describe, expect, it } from "vitest";
import { FIRST_RUN_STORAGE_KEY } from "./firstRun";
import { isCleanInstall, reopenFirstRun, type CleanInstallProbe } from "./firstRunCleanInstall";

function probe(counts: [number, number, number, number], failing?: keyof CleanInstallProbe): CleanInstallProbe {
  const answer = (key: keyof CleanInstallProbe, count: number) => async () => {
    if (key === failing) throw new Error("unreachable");
    return count;
  };
  return {
    countComics: answer("countComics", counts[0]),
    countBooks: answer("countBooks", counts[1]),
    countNovels: answer("countNovels", counts[2]),
    countSourceSetup: answer("countSourceSetup", counts[3]),
  };
}

describe("clean install", () => {
  it("is clean only when no work and no source is set up", async () => {
    expect(await isCleanInstall(probe([0, 0, 0, 0]))).toBe(true);
    expect(await isCleanInstall(probe([1, 0, 0, 0]))).toBe(false);
    expect(await isCleanInstall(probe([0, 2, 0, 0]))).toBe(false);
    expect(await isCleanInstall(probe([0, 0, 3, 0]))).toBe(false);
    expect(await isCleanInstall(probe([0, 0, 0, 1]))).toBe(false);
  });

  it("is not clean when something cannot be read", async () => {
    expect(await isCleanInstall(probe([0, 0, 0, 0], "countComics"))).toBe(false);
    expect(await isCleanInstall(probe([0, 0, 0, 0], "countSourceSetup"))).toBe(false);
  });

  it("marks setup as pending again", () => {
    const values = new Map<string, string>();
    reopenFirstRun({ setItem: (key, value) => values.set(key, value) });
    expect(JSON.parse(values.get(FIRST_RUN_STORAGE_KEY) ?? "null")).toMatchObject({ status: "pending", step: "theme" });
  });
});
