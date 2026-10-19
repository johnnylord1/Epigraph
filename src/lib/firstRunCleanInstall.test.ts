import { describe, expect, it } from "vitest";
import { FIRST_RUN_STORAGE_KEY, normalizeFirstRunState } from "./firstRun";
import {
  FIRST_RUN_CONTENT_PROFILES_KEY,
  readInstallContent,
  rememberProfileContent,
  reopenFirstRun,
  shouldReopenEmptyProfile,
  type CleanInstallProbe,
} from "./firstRunCleanInstall";

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

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe("install content", () => {
  it("is empty only when no work and no source is set up", async () => {
    expect(await readInstallContent(probe([0, 0, 0, 0]))).toBe("empty");
    expect(await readInstallContent(probe([1, 0, 0, 0]))).toBe("content");
    expect(await readInstallContent(probe([0, 2, 0, 0]))).toBe("content");
    expect(await readInstallContent(probe([0, 0, 3, 0]))).toBe("content");
    expect(await readInstallContent(probe([0, 0, 0, 1]))).toBe("content");
  });

  it("is unknown when something cannot be read, unless something else is already there", async () => {
    expect(await readInstallContent(probe([0, 0, 0, 0], "countComics"))).toBe("unknown");
    expect(await readInstallContent(probe([0, 0, 0, 0], "countSourceSetup"))).toBe("unknown");
    expect(await readInstallContent(probe([0, 4, 0, 0], "countComics"))).toBe("content");
  });
});

describe("reopening setup", () => {
  it("reopens an empty profile only after it was seen holding something", () => {
    const storage = memoryStorage();
    expect(shouldReopenEmptyProfile(storage, "default")).toBe(false);
    rememberProfileContent(storage, "default");
    rememberProfileContent(storage, "default");
    expect(JSON.parse(storage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY) ?? "null")).toEqual(["default"]);
    expect(shouldReopenEmptyProfile(storage, "default")).toBe(true);
    expect(shouldReopenEmptyProfile(storage, "other")).toBe(false);
  });

  it("ignores an unreadable list", () => {
    const storage = memoryStorage();
    storage.setItem(FIRST_RUN_CONTENT_PROFILES_KEY, "{not json");
    expect(shouldReopenEmptyProfile(storage, "default")).toBe(false);
    rememberProfileContent(storage, "default");
    expect(shouldReopenEmptyProfile(storage, "default")).toBe(true);
  });

  it("marks setup as pending again and forgets the profiles seen with content", () => {
    const storage = memoryStorage();
    rememberProfileContent(storage, "default");
    reopenFirstRun(storage);
    expect(JSON.parse(storage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null")).toMatchObject({ status: "pending", step: "theme" });
    expect(storage.getItem(FIRST_RUN_CONTENT_PROFILES_KEY)).toBeNull();
    expect(shouldReopenEmptyProfile(storage, "default")).toBe(false);
  });

  it("lets only a setup started by the user be cancelled, across reloads", () => {
    const storage = memoryStorage();
    reopenFirstRun(storage);
    expect(normalizeFirstRunState({ firstRun: JSON.parse(storage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null") }).cancellable).toBeUndefined();
    reopenFirstRun(storage, { cancellable: true });
    const reloaded = normalizeFirstRunState({ firstRun: JSON.parse(storage.getItem(FIRST_RUN_STORAGE_KEY) ?? "null") });
    expect(reloaded).toMatchObject({ status: "pending", step: "theme", cancellable: true });
  });
});
