import { describe, expect, it } from "vitest";
import { store, persistRestoredAppReadingState } from "./state.svelte";

describe("restore persistence acknowledgement", () => {
  it("commits supplied reading state before publishing it to the live store", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const before = { history: store.history, readLog: store.readLog, readingStats: store.readingStats };
    const incoming = { history: [{ mangaId: 91, mangaTitle: "Restored", thumbnailUrl: "", chapterId: 3, chapterName: "Chapter", readAt: 42 }], readLog: [], readingStats: store.readingStats };
    let saved = "{}";
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved, setItem: (_key: string, value: string) => {
      expect(store.history).toEqual(before.history);
      saved = value;
    } } });
    try {
      persistRestoredAppReadingState(incoming);
      expect(JSON.parse(saved).history).toEqual(incoming.history);
      expect(store.history).toEqual(incoming.history);
    } finally {
      store.replaceAppReadingState(before);
      if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });
  it("preserves malformed destination evidence instead of replacing it", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let saved = "{broken";
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } } });
    try {
      expect(() => persistRestoredAppReadingState()).toThrow("RESTORE_APP_DESTINATION_CORRUPT");
      expect(saved).toBe("{broken");
    } finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
  });
  it("fails when selected App state cannot be persisted", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const before = JSON.stringify({ history: store.history, readLog: store.readLog, readingStats: store.readingStats });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => null, setItem: () => { throw Error("quota"); } } });
    try {
      expect(() => persistRestoredAppReadingState({ history: [], readLog: [], readingStats: { ...store.readingStats, totalMinutesRead: 999 } })).toThrow("RESTORE_APP_PERSISTENCE_FAILED");
      expect(JSON.stringify({ history: store.history, readLog: store.readLog, readingStats: store.readingStats })).toBe(before);
    }
    finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
  });
  it("persists reading fields while preserving unrelated stored settings", () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    let saved = JSON.stringify({ settings: { defaultLocalProfileId: "main", unrelated: true } });
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } } });
    try {
      persistRestoredAppReadingState();
      expect(JSON.parse(saved).history).toEqual(JSON.parse(JSON.stringify(store.history)));
      expect(JSON.parse(saved).settings).toEqual({ defaultLocalProfileId: "main", unrelated: true });
    } finally { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); }
  });
});
