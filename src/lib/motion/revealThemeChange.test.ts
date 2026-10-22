// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealThemeChange, setAnimationPreference } from "./motion";

type Update = () => void | Promise<void>;

/** A view transition whose update runs on the next microtask, as the browser runs it after its snapshot. */
function fakeViewTransitions() {
  const started: { update: Update; skipTransition: ReturnType<typeof vi.fn> }[] = [];
  (document as unknown as { startViewTransition?: unknown }).startViewTransition = (update: Update) => {
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const skipTransition = vi.fn(() => finish());
    started.push({ update, skipTransition });
    const ready = Promise.resolve().then(() => update());
    void ready.then(() => new Promise((resolve) => setTimeout(resolve, 900))).then(finish);
    return { ready, finished, skipTransition };
  };
  return started;
}

describe("revealThemeChange", () => {
  let now = 10_000;
  let theme = "nocturne";
  const choose = (next: string) => revealThemeChange(() => { theme = next; }, { x: 10, y: 10 });

  beforeEach(() => {
    now += 10_000;
    theme = "nocturne";
    vi.spyOn(performance, "now").mockImplementation(() => now);
    Element.prototype.animate = vi.fn() as unknown as Element["animate"];
    setAnimationPreference(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setAnimationPreference(null);
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  });

  it("reveals a single choice through a view transition", async () => {
    const started = fakeViewTransitions();
    choose("light");
    expect(started).toHaveLength(1);
    await Promise.resolve();
    expect(theme).toBe("light");
  });

  it("swaps at once when choices come faster than the reveal, keeping the latest", async () => {
    const started = fakeViewTransitions();
    choose("light");
    now += 120;
    choose("amoled");
    now += 120;
    choose("warm");
    expect(started).toHaveLength(1);
    expect(started[0].skipTransition).toHaveBeenCalled();
    expect(theme).toBe("warm");
    // The skipped reveal's own update must not bring back its older theme.
    await Promise.resolve();
    await Promise.resolve();
    expect(theme).toBe("warm");
  });

  it("reveals again once the previous reveal has had its time", async () => {
    const started = fakeViewTransitions();
    choose("light");
    now += 1_000;
    choose("amoled");
    expect(started).toHaveLength(2);
    await Promise.resolve();
    expect(theme).toBe("amoled");
  });
});
