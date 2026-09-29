import { describe, expect, it, vi } from "vitest";
import { relayDetachedStoreMethods } from "./detachedStoreRelay";

function fakeStore() {
  const persisted = { settings: { zoom: 1, theme: "dark" }, bookmarks: [] as number[] };
  const store = {
    settings: { ...persisted.settings },
    bookmarks: [] as number[],
    updateSettings(patch: Record<string, unknown>) { this.settings = { ...this.settings, ...patch }; },
    addBookmark(entry: { chapterId: number }) { this.bookmarks = [...this.bookmarks.filter((id) => id !== entry.chapterId), entry.chapterId]; },
    removeBookmark(chapterId: number) { this.bookmarks = this.bookmarks.filter((id) => id !== chapterId); },
    addHistory: vi.fn(),
    setBookProgress: vi.fn(),
    addBookBookmark: vi.fn(),
    removeBookBookmark: vi.fn(),
    adoptPersistedReaderState() {
      this.settings = { ...persisted.settings };
      this.bookmarks = [...persisted.bookmarks];
    },
  };
  return { store, persisted };
}

function fakeLink() {
  const answers: Array<{ method: string; args: unknown[]; resolve(value: unknown): void; reject(error: Error): void }> = [];
  return {
    answers,
    notify: vi.fn(),
    request: vi.fn((method: string, args: unknown[]) => new Promise<unknown>((resolve, reject) => { answers.push({ method, args, resolve, reject }); })),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("detached store relay", () => {
  it("keeps this window's unconfirmed changes when it adopts an older save from the main window", async () => {
    const { store, persisted } = fakeStore();
    const link = fakeLink();
    const relay = relayDetachedStoreMethods(store, link);

    store.updateSettings({ zoom: 1.5 });
    store.addBookmark({ chapterId: 7 });
    expect(store.settings.zoom).toBe(1.5);
    expect(link.request.mock.calls).toEqual([["updateSettings", [{ zoom: 1.5 }]], ["addBookmark", [{ chapterId: 7 }]]]);

    // The main window saved something else (another window's theme) before it applied these changes.
    persisted.settings = { ...persisted.settings, theme: "light" };
    relay.adoptPersistedState();
    expect(store.settings).toEqual({ zoom: 1.5, theme: "light" });
    expect(store.bookmarks).toEqual([7]);

    // Once confirmed, the main window's save is the truth, including a later change made elsewhere.
    persisted.settings = { zoom: 2, theme: "light" };
    persisted.bookmarks = [7];
    link.answers[0].resolve(null);
    link.answers[1].resolve(null);
    await settle();
    relay.adoptPersistedState();
    expect(store.settings).toEqual({ zoom: 2, theme: "light" });
    expect(store.bookmarks).toEqual([7]);
  });

  it("drops a change the main window refused once it adopts the saved state", async () => {
    const { store } = fakeStore();
    const link = fakeLink();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = relayDetachedStoreMethods(store, link);
    store.updateSettings({ zoom: 3 });
    link.answers[0].reject(new Error("refused"));
    await settle();
    relay.adoptPersistedState();
    expect(store.settings.zoom).toBe(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("hands reading events and main-window calls over without waiting", () => {
    const { store } = fakeStore();
    const link = fakeLink();
    const addHistory = store.addHistory;
    relayDetachedStoreMethods(store, link);
    const target = store as unknown as Record<string, (...args: unknown[]) => unknown>;
    target.addHistory({ chapterId: 1 }, true);
    target.checkAndMarkCompleted(4, []);
    target.setSettingsOpen("yes");
    expect(addHistory).toHaveBeenCalledWith({ chapterId: 1 }, true);
    expect(link.notify.mock.calls).toEqual([["addHistory", [{ chapterId: 1 }, true]], ["setSettingsOpen", [false]]]);
    expect(link.request).toHaveBeenCalledWith("checkAndMarkCompleted", [4, []]);
  });
});
