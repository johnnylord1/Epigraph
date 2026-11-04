import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../syncdDesktop", () => ({ syncdGetSyncProgressIfRunning: vi.fn() }));

import { syncdGetSyncProgressIfRunning } from "../syncdDesktop";
import {
  ARRIVAL_RECONCILE_WORKS,
  createLandedWorksTracker,
  createSyncLandingDetector,
  isWindowOutOfSight,
  MAX_WORKS_PER_READ,
  startSyncLandingWatch,
} from "./syncLandingWatch";

const progress = (appliedProjections: number, pendingProjections = 0, pendingDetails = 0) => ({
  appliedProjections,
  pendingProjections,
  pendingTrackerLogins: 0,
  pendingDetails,
});

describe("createSyncLandingDetector", () => {
  it("takes the first reading as the baseline", () => {
    const landed = createSyncLandingDetector();
    expect(landed(progress(40))).toBe(false);
    expect(landed(progress(40))).toBe(false);
  });

  it("lands once when applied changes leave nothing pending", () => {
    const landed = createSyncLandingDetector();
    landed(progress(0));
    expect(landed(progress(3))).toBe(true);
    expect(landed(progress(3))).toBe(false);
  });

  it("shows a long sync as it applies, at most once per interval, then lands once it stops", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0, 900));
    clock = 5_000;
    expect(landed(progress(50, 850))).toBe(true);
    clock = 10_000;
    expect(landed(progress(120, 780))).toBe(false);
    clock = 15_000;
    expect(landed(progress(200, 700))).toBe(false);
    clock = 25_000;
    expect(landed(progress(260, 640))).toBe(true);
    clock = 30_000;
    expect(landed(progress(300, 600))).toBe(false);
    // Stalled on retries: what landed so far still waits for the interval, then is shown once.
    clock = 35_000;
    expect(landed(progress(300, 600))).toBe(false);
    clock = 45_000;
    expect(landed(progress(300, 600))).toBe(true);
    expect(landed(progress(300, 600))).toBe(false);
  });

  it("limits changes that keep landing with nothing queued, and shows the last ones", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    const landings: number[] = [];
    for (let tick = 1; tick <= 12; tick += 1) {
      clock = tick * 5_000;
      if (landed(progress(tick * 3))) landings.push(clock);
    }
    expect(landings).toEqual([5_000, 25_000, 45_000]);
    clock = 65_000;
    expect(landed(progress(36))).toBe(true);
    clock = 90_000;
    expect(landed(progress(36))).toBe(false);
  });

  it("shows an isolated change at once after a quiet interval", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    clock = 5_000;
    expect(landed(progress(1))).toBe(true);
    clock = 300_000;
    expect(landed(progress(2))).toBe(true);
  });

  it("waits longer while only reading progress is pending, then lands the end of the sync", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000, 60_000);
    const progressOnly = (applied: number, pending: number) => ({ ...progress(applied, pending), pendingCatalogProjections: 0 });
    landed(progressOnly(0, 40_000));
    clock = 5_000;
    expect(landed(progressOnly(100, 39_900))).toBe(true);
    clock = 30_000;
    expect(landed(progressOnly(600, 39_400))).toBe(false);
    clock = 65_000;
    expect(landed(progressOnly(1_200, 38_800))).toBe(true);
    // Library works still arriving, or an older Core that does not tell: the short interval.
    clock = 85_000;
    expect(landed({ ...progress(1_300, 38_700), pendingCatalogProjections: 4 })).toBe(true);
    clock = 105_000;
    expect(landed(progress(1_400, 38_600))).toBe(true);
    // Nothing left: the last changes wait only the short interval.
    clock = 110_000;
    expect(landed(progressOnly(40_000, 0))).toBe(false);
    clock = 125_000;
    expect(landed(progressOnly(40_000, 0))).toBe(true);
  });

  it("waits as long as a slow reload asks", () => {
    let clock = 0;
    const landed = createSyncLandingDetector(() => clock, 20_000);
    landed(progress(0));
    clock = 5_000;
    expect(landed(progress(1), 80_000)).toBe(true);
    clock = 30_000;
    expect(landed(progress(2), 80_000)).toBe(false);
    clock = 85_000;
    expect(landed(progress(3), 80_000)).toBe(true);
  });

  it("lands when the last work's details finish loading", () => {
    const landed = createSyncLandingDetector();
    landed(progress(5, 0, 12));
    expect(landed(progress(5, 0, 4))).toBe(false);
    expect(landed(progress(5, 0, 0))).toBe(true);
  });

  it("treats a restarted Core as new changes and ignores missing readings", () => {
    const landed = createSyncLandingDetector();
    landed(progress(70));
    expect(landed(null)).toBe(false);
    expect(landed(progress(0))).toBe(true);
  });
});

describe("createLandedWorksTracker", () => {
  const view = (sequence: number, works: number[] = [], floor = 0, catalogSequence = 0) => ({
    sequence,
    floor,
    catalogSequence,
    works: works.map((mangaId) => ({ profileId: "p", mangaId, sequence })),
  });

  it("takes the first reading as where to start from", () => {
    const tracker = createLandedWorksTracker();
    expect(tracker.cursor()).toBeUndefined();
    tracker.note(view(10, [1, 2]), "p");
    expect(tracker.cursor()).toBe(10);
    expect(tracker.pendingIds()).toEqual([]);
    expect(tracker.settled()).toBe(true);
  });

  it("keeps the works that landed after the cursor, once each", () => {
    const tracker = createLandedWorksTracker();
    tracker.note(view(10), "p");
    tracker.note(view(12, [4, 5]), "p");
    tracker.note(view(13, [5]), "p");
    expect(tracker.pendingIds()).toEqual([4, 5]);
    tracker.worksRead([4]);
    expect(tracker.pendingIds()).toEqual([5]);
    expect(tracker.settled()).toBe(false);
  });

  it("ignores the works of another profile", () => {
    const tracker = createLandedWorksTracker();
    tracker.note(view(10), "other");
    tracker.note(view(12, [4]), "other");
    expect(tracker.pendingIds()).toEqual([]);
  });

  it("asks for the whole library when works may have been missed", () => {
    const raised = createLandedWorksTracker();
    raised.note(view(10), "p");
    raised.note(view(30, [], 20), "p");
    expect(raised.needsLibrary()).toBe(true);

    const restarted = createLandedWorksTracker();
    restarted.note(view(10), "p");
    restarted.note(view(4), "p");
    expect(restarted.needsLibrary()).toBe(true);
  });

  it("asks for the whole library when too many works landed for one read", () => {
    const tracker = createLandedWorksTracker();
    tracker.note(view(10), "p");
    tracker.note(view(11, Array.from({ length: MAX_WORKS_PER_READ + 1 }, (_, id) => id)), "p");
    expect(tracker.needsLibrary()).toBe(true);
  });

  it("notices that the catalog changed, apart from the works", () => {
    const tracker = createLandedWorksTracker();
    tracker.note(view(10, [], 0, 3), "p");
    tracker.note(view(11, [1], 0, 3), "p");
    expect(tracker.catalogChanged()).toBe(false);
    tracker.note(view(12, [], 0, 4), "p");
    expect(tracker.catalogChanged()).toBe(true);
  });
});

describe("startSyncLandingWatch", () => {
  const reading = (
    sequence: number,
    works: number[] = [],
    extra: { floor?: number; catalogSequence?: number; pendingProjections?: number; pendingCatalogProjections?: number } = {},
  ) => ({
    appliedProjections: sequence,
    pendingProjections: extra.pendingProjections ?? 0,
    pendingCatalogProjections: extra.pendingCatalogProjections ?? 0,
    pendingTrackerLogins: 0,
    pendingDetails: 0,
    landed: {
      sequence,
      floor: extra.floor ?? 0,
      catalogSequence: extra.catalogSequence ?? 0,
      works: works.map((mangaId) => ({ profileId: "p", mangaId, sequence })),
    },
  });

  function watch(arriving: () => boolean = () => false, hidden = false) {
    const handlers = {
      isPaused: vi.fn(() => hidden),
      profileId: vi.fn(() => "p" as string | null),
      readWorks: vi.fn(async (_ids: number[]) => {}),
      readLibrary: vi.fn(async () => {}),
      catalogChanged: vi.fn(),
      arriving: vi.fn(arriving),
      onArriving: vi.fn(),
    };
    return { handlers, stop: startSyncLandingWatch(handlers) };
  }

  /** One reading for each check of the watch, the last one repeating. */
  function readings(...values: unknown[]) {
    const progress = vi.mocked(syncdGetSyncProgressIfRunning);
    progress.mockReset();
    for (const value of values) progress.mockResolvedValueOnce(value as never);
    progress.mockResolvedValue(values[values.length - 1] as never);
    return progress;
  }

  const check = () => vi.advanceTimersByTimeAsync(5_000);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reads only the works that landed, from the cursor it was last given", async () => {
    const progress = readings(reading(10), reading(12, [7, 8]), reading(12));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenLastCalledWith(undefined);
    expect(handlers.readWorks).not.toHaveBeenCalled();

    await check();
    expect(progress).toHaveBeenLastCalledWith(10);
    expect(handlers.readWorks.mock.calls).toEqual([[[7, 8]]]);
    expect(handlers.readLibrary).not.toHaveBeenCalled();

    await check();
    expect(progress).toHaveBeenLastCalledWith(12);
    expect(handlers.readWorks).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads the whole library, after a pause, when reading the works failed", async () => {
    readings(reading(10), reading(12, [7]), reading(12));
    const { handlers, stop } = watch();
    handlers.readWorks.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    await check();
    expect(handlers.readWorks).toHaveBeenCalledTimes(1);
    expect(handlers.readLibrary).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reads the whole library when Core lost track of what landed", async () => {
    readings(reading(10), reading(50, [], { floor: 40 }), reading(50, [], { floor: 40 }));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.readWorks).not.toHaveBeenCalled();
    stop();
  });

  it("falls back to the whole library on a Core that does not say which works landed", async () => {
    const older = (appliedProjections: number) => ({
      appliedProjections,
      pendingProjections: 0,
      pendingCatalogProjections: 0,
      pendingTrackerLogins: 0,
      pendingDetails: 0,
    });
    readings(older(1), older(2), older(2));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.readWorks).not.toHaveBeenCalled();
    stop();
  });

  it("paces works that only brought reading progress while more of it is waiting", async () => {
    const busy = { pendingProjections: 500 };
    readings(reading(10, [], busy), reading(11, [1], busy), reading(12, [2], busy), reading(13, [3], busy));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    await check();
    expect(handlers.readWorks.mock.calls).toEqual([[[1]]]);
    await vi.advanceTimersByTimeAsync(55_000);
    expect(handlers.readWorks).toHaveBeenCalledTimes(1);
    await check();
    expect(handlers.readWorks).toHaveBeenCalledTimes(2);
    expect(handlers.readWorks.mock.calls[1][0]).toEqual([2, 3]);
    stop();
  });

  it("does not pace works while the library is still receiving works", async () => {
    const adding = { pendingProjections: 500, pendingCatalogProjections: 400 };
    readings(reading(10, [], adding), reading(11, [1], adding), reading(12, [2], adding), reading(12, [], adding));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    await check();
    await check();
    expect(handlers.readWorks.mock.calls).toEqual([[[1]], [[2]]]);
    stop();
  });

  it("says when the catalog changed, without a second signal for the same change", async () => {
    readings(
      reading(10, [], { catalogSequence: 1 }),
      reading(11, [1], { catalogSequence: 2 }),
      reading(11, [], { catalogSequence: 2 }),
    );
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    await check();
    expect(handlers.catalogChanged).toHaveBeenCalledTimes(1);
    await check();
    expect(handlers.catalogChanged).toHaveBeenCalledTimes(1);
    stop();
  });

  it("releases the arrival right after its last works were read", async () => {
    let arriving = false;
    readings(reading(10), reading(11, [1]), reading(12, [2]), reading(12));
    const { handlers, stop } = watch(() => arriving);
    await vi.advanceTimersByTimeAsync(0);
    arriving = true;
    await check();
    expect(handlers.onArriving.mock.calls).toEqual([[true]]);
    arriving = false;
    await check();
    expect(handlers.onArriving.mock.calls).toEqual([[true], [false]]);
    expect(handlers.readWorks.mock.calls.at(-1)).toEqual([[2]]);
    expect(handlers.readLibrary).not.toHaveBeenCalled();
    stop();
  });

  it("ends an arrival that began before the first reading with a full read", async () => {
    let arriving = true;
    readings(reading(10), reading(10));
    const { handlers, stop } = watch(() => arriving);
    await vi.advanceTimersByTimeAsync(0);
    arriving = false;
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.onArriving.mock.calls).toEqual([[true], [false]]);
    stop();
  });

  it("ends a large arrival with a full read", async () => {
    let arriving = false;
    const many = Array.from({ length: ARRIVAL_RECONCILE_WORKS + 1 }, (_, id) => id);
    readings(reading(10), reading(11), reading(12, many), reading(12));
    const { handlers, stop } = watch(() => arriving);
    await vi.advanceTimersByTimeAsync(0);
    arriving = true;
    await check();
    await check();
    expect(handlers.readLibrary).not.toHaveBeenCalled();
    arriving = false;
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.onArriving.mock.calls).toEqual([[true], [false]]);
    stop();
  });

  it("keeps the arrival open, so the Browse analysis waits, until a failed read works", async () => {
    let arriving = true;
    readings(reading(10), reading(10));
    const { handlers, stop } = watch(() => arriving);
    handlers.readLibrary.mockRejectedValueOnce(new Error("offline"));
    await vi.advanceTimersByTimeAsync(0);
    arriving = false;
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.onArriving.mock.calls).toEqual([[true]]);

    await check();
    await check();
    expect(handlers.readLibrary).toHaveBeenCalledTimes(1);
    expect(handlers.onArriving.mock.calls).toEqual([[true]]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(handlers.readLibrary).toHaveBeenCalledTimes(2);
    expect(handlers.onArriving.mock.calls).toEqual([[true], [false]]);
    stop();
  });

  it("does not check while the window is hidden", async () => {
    const progress = readings(reading(10));
    const { handlers, stop } = watch();
    handlers.isPaused.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(0);
    const checks = progress.mock.calls.length;
    await check();
    expect(progress.mock.calls.length).toBe(checks);
    stop();
  });

  it("waits for an answer the window has to be asked for", async () => {
    const progress = readings(reading(10));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    const checks = progress.mock.calls.length;
    handlers.isPaused.mockImplementation((() => Promise.resolve(true)) as never);
    await check();
    expect(progress.mock.calls.length).toBe(checks);
    handlers.isPaused.mockImplementation((() => Promise.resolve(false)) as never);
    await check();
    expect(progress.mock.calls.length).toBe(checks + 1);
    stop();
  });

  it("takes the first reading while hidden, so what lands meanwhile is read once shown", async () => {
    const progress = readings(reading(10), reading(12, [7]));
    const { handlers, stop } = watch(() => false, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(undefined);

    await check();
    expect(progress).toHaveBeenCalledTimes(1);

    handlers.isPaused.mockReturnValue(false);
    await check();
    expect(progress).toHaveBeenLastCalledWith(10);
    expect(handlers.readWorks.mock.calls).toEqual([[[7]]]);
    stop();
  });

  it("does nothing after it was stopped", async () => {
    const progress = readings(reading(10), reading(11, [1]));
    const { handlers, stop } = watch();
    await vi.advanceTimersByTimeAsync(0);
    stop();
    await check();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(handlers.readWorks).not.toHaveBeenCalled();
  });
});

describe("isWindowOutOfSight", () => {
  const windowThat = (minimized: boolean, visible: boolean) => ({
    isMinimized: async () => minimized,
    isVisible: async () => visible,
  });

  beforeEach(() => vi.stubGlobal("document", { hidden: false }));
  afterEach(() => vi.unstubAllGlobals());

  it("keeps a window that is only unfocused in sight", async () => {
    expect(await isWindowOutOfSight(windowThat(false, true))).toBe(false);
  });

  it("sees a minimized window that the page still reports as visible", async () => {
    expect(await isWindowOutOfSight(windowThat(true, true))).toBe(true);
  });

  it("sees a window hidden in the tray", async () => {
    expect(await isWindowOutOfSight(windowThat(false, false))).toBe(true);
  });

  it("trusts the page when it says it is hidden, without asking the window", async () => {
    vi.stubGlobal("document", { hidden: true });
    expect(await isWindowOutOfSight(null)).toBe(true);
  });

  it("keeps the library current when the window cannot answer", async () => {
    const failing = { isMinimized: async () => { throw new Error("denied"); }, isVisible: async () => true };
    expect(await isWindowOutOfSight(failing)).toBe(false);
    expect(await isWindowOutOfSight(null)).toBe(false);
  });
});
