import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createReaderCommandDispatcher, isReaderControlKeyboardTarget } from "./commands";

function createHost() {
  let listener: ((event: KeyboardEvent) => void) | null = null;
  return {
    host: {
      addEventListener: vi.fn((_type: "keydown", next: (event: KeyboardEvent) => void) => {
        listener = next;
      }),
      removeEventListener: vi.fn((_type: "keydown", current: (event: KeyboardEvent) => void) => {
        if (listener === current) listener = null;
      }),
    },
    dispatch(event: KeyboardEvent) {
      listener?.(event);
    },
  };
}

describe("reader command dispatcher", () => {
  it("dispatches each key event to only the active reader scope", () => {
    const fixture = createHost();
    const dispatcher = createReaderCommandDispatcher(fixture.host);
    const manga = vi.fn();
    const book = vi.fn();

    dispatcher.register("manga", manga);
    dispatcher.register("book", book);
    fixture.dispatch({ key: "ArrowRight" } as KeyboardEvent);

    expect(manga).not.toHaveBeenCalled();
    expect(book).toHaveBeenCalledOnce();
    expect(dispatcher.activeScope()).toBe("book");
    expect(fixture.host.addEventListener).toHaveBeenCalledOnce();
  });

  it("does not let stale cleanup unregister a newer reader", () => {
    const fixture = createHost();
    const dispatcher = createReaderCommandDispatcher(fixture.host);
    const cleanupManga = dispatcher.register("manga", vi.fn());
    const book = vi.fn();
    const cleanupBook = dispatcher.register("book", book);

    cleanupManga();
    fixture.dispatch({ key: "f" } as KeyboardEvent);

    expect(book).toHaveBeenCalledOnce();
    expect(dispatcher.hasActiveScope()).toBe(true);

    cleanupBook();
    expect(dispatcher.hasActiveScope()).toBe(false);
    expect(fixture.host.removeEventListener).toHaveBeenCalledOnce();
  });

  it("recognizes interactive controls without relying on the current window realm", () => {
    expect(isReaderControlKeyboardTarget({ tagName: "BUTTON" } as unknown as EventTarget)).toBe(true);
    expect(isReaderControlKeyboardTarget({
      tagName: "DIV",
      closest: (selector: string) => selector.includes("role='button'") ? ({} as Element) : null,
    } as unknown as EventTarget)).toBe(true);
    expect(isReaderControlKeyboardTarget({ tagName: "DIV" } as unknown as EventTarget)).toBe(false);
  });

  it("treats keys pressed inside the HUD's page surface as reader commands", () => {
    const surface = { getAttribute: (name: string) => name === "data-reader-surface" ? "" : null };
    const control = { getAttribute: () => null };
    expect(isReaderControlKeyboardTarget({ tagName: "DIV", closest: () => surface } as unknown as EventTarget)).toBe(false);
    expect(isReaderControlKeyboardTarget({ tagName: "DIV", closest: () => control } as unknown as EventTarget)).toBe(true);
  });
});

describe("reader command ownership integration", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

  it("keeps shell zoom and fullscreen out of active reader scopes", () => {
    const app = source("src/App.svelte");
    expect(app).toMatch(/function handleZoomKey[\s\S]*?hasActiveReaderCommandScope\(\)/);
    expect(app).toMatch(/function handleGlobalFullscreenKey[\s\S]*?hasActiveReaderCommandScope\(\)/);
  });

  it.each([
    ["manga", "src/components/reader/Reader.svelte"],
    ["book", "src/components/reader/BookReader.svelte"],
    ["novel", "src/components/reader/NovelReader.svelte"],
  ] as const)("registers and cleans up the %s reader scope", (scope, path) => {
    const component = source(path);
    expect(component).toContain(`registerReaderCommandHandler("${scope}", onKey)`);
    expect(component).toContain("unregisterCommands");
    expect(component).not.toContain('window.addEventListener("keydown", onKey)');
  });
});
