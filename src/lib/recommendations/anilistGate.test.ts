import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANILIST_PRIORITY, createAniListGate, requestAniList, resetAniListGateForTests } from "./anilistGate";

function fakeClock() {
  let time = 0;
  const timers: { at: number; callback: () => void }[] = [];
  return {
    now: () => time,
    setTimer: (callback: () => void, ms: number) => {
      const timer = { at: time + ms, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle: unknown) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
    async advance(ms: number) {
      const end = time + ms;
      for (;;) {
        await flush();
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > end) break;
        timers.shift();
        time = next.at;
        next.callback();
      }
      time = end;
      await flush();
    },
  };
}

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

function response(status = 200, headers: Record<string, string> = {}) {
  return new Response("{}", { status, headers });
}

describe("createAniListGate", () => {
  it("starts no more requests a minute than AniList allows", async () => {
    const clock = fakeClock();
    const gate = createAniListGate(clock);
    const runs: number[] = [];
    const done = Array.from({ length: 35 }, () => gate.schedule(async () => {
      runs.push(clock.now());
      return response();
    }));
    await clock.advance(0);
    // 30 a minute, one left for requests made outside the gate.
    expect(runs).toHaveLength(29);
    await clock.advance(60_000);
    expect(runs).toHaveLength(35);
    expect(runs.slice(29).every((time) => time >= 60_000)).toBe(true);
    await Promise.all(done);
  });

  it("starts what fills the rows before lookups and extras", async () => {
    const clock = fakeClock();
    const gate = createAniListGate(clock);
    const order: string[] = [];
    const blocker = gate.schedule(async () => response(200, { "x-ratelimit-remaining": "1" }));
    await clock.advance(0);
    gate.schedule(async () => { order.push("extra"); return response(); }, { priority: ANILIST_PRIORITY.extra });
    gate.schedule(async () => { order.push("lookup"); return response(); }, { priority: ANILIST_PRIORITY.lookup });
    gate.schedule(async () => { order.push("feed"); return response(); }, { priority: ANILIST_PRIORITY.feed });
    await blocker;
    await clock.advance(0);
    // AniList said one request was left, which the gate keeps in reserve.
    expect(order).toEqual([]);
    await clock.advance(60_000);
    expect(order).toEqual(["feed", "lookup", "extra"]);
  });

  it("waits out a 429 and asks again once", async () => {
    const clock = fakeClock();
    const gate = createAniListGate(clock);
    const run = vi.fn()
      .mockResolvedValueOnce(response(429, { "retry-after": "20" }))
      .mockResolvedValueOnce(response(200));
    const done = gate.schedule(run);
    await clock.advance(0);
    expect(run).toHaveBeenCalledTimes(1);
    await clock.advance(19_000);
    expect(run).toHaveBeenCalledTimes(1);
    await clock.advance(1_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect((await done).status).toBe(200);
  });

  it("treats a network error as a 429 without CORS headers", async () => {
    const clock = fakeClock();
    const gate = createAniListGate(clock);
    const run = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const done = gate.schedule(run);
    const outcome = done.then(() => "ok", (error: unknown) => String(error));
    await clock.advance(0);
    await clock.advance(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    expect(await outcome).toContain("Failed to fetch");
  });

  it("drops a queued request whose caller stops waiting", async () => {
    const clock = fakeClock();
    const gate = createAniListGate(clock);
    gate.schedule(async () => response(429)).catch(() => {});
    await clock.advance(0);
    const controller = new AbortController();
    const run = vi.fn(async () => response());
    const done = gate.schedule(run, { signal: controller.signal });
    controller.abort();
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
    expect(gate.pending).toBe(1);
    await clock.advance(120_000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("requestAniList", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAniListGateForTests();
  });

  it("asks once for the same query and keeps the answer", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { Page: { media: [{ id: 1 }] } } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { query: "query Q { Page { media { id } } }", variables: { page: 1 } };
    const [first, second] = await Promise.all([requestAniList(body), requestAniList(body)]);
    expect(first).toEqual({ Page: { media: [{ id: 1 }] } });
    expect(second).toEqual(first);
    await requestAniList(body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("serves a persisted answer in a later session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { ok: true } }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { query: "query P { ok }" };
    await requestAniList(body, { persistMs: 60_000 });
    resetAniListGateForTests();
    expect(await requestAniList(body, { persistMs: 60_000 })).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the request for the callers still waiting when one stops", async () => {
    let answer: (value: Response) => void = () => {};
    const fetchMock = vi.fn((_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      answer = resolve;
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }));
    vi.stubGlobal("fetch", fetchMock);
    const body = { query: "query S { ok }" };
    const controller = new AbortController();
    const leaving = requestAniList(body, { signal: controller.signal });
    const staying = requestAniList(body);
    await flush();
    controller.abort();
    await expect(leaving).rejects.toMatchObject({ name: "AbortError" });
    answer(new Response(JSON.stringify({ data: { ok: 1 } }), { status: 200 }));
    expect(await staying).toEqual({ ok: 1 });
  });
});
