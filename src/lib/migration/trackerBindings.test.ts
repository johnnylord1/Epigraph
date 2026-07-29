import { describe, expect, it, vi } from "vitest";
import {
  BIND_TRACK,
  GET_MANGA_TRACK_RECORDS,
  UNBIND_TRACK,
} from "../queries";
import {
  applyMangaTrackerBindingPlan,
  compensateMangaTrackerBindingPlan,
  createGraphqlMangaTrackerBindingPort,
  prepareMangaTrackerBindingPlan,
  verifyMangaTrackerBindingPlan,
} from "./trackerBindings";
import type {
  LogicalTrackerBinding,
  MangaTrackerBindingPort,
  TrackerBindingRecord,
} from "./trackerBindings";

class MemoryTrackerBindingPort implements MangaTrackerBindingPort {
  readonly calls: string[] = [];
  private nextRecordId = 100;
  private readonly records = new Map<number, TrackerBindingRecord[]>();
  failBindForTracker: number | null = null;
  failUnbindForRecord: number | null = null;

  constructor(initial: Record<number, LogicalTrackerBinding[]>) {
    for (const [mangaId, bindings] of Object.entries(initial)) {
      this.records.set(
        Number(mangaId),
        bindings.map((binding) => ({
          recordId: this.nextRecordId++,
          ...binding,
        })),
      );
    }
  }

  async list(mangaId: number): Promise<TrackerBindingRecord[]> {
    this.calls.push(`list:${mangaId}`);
    return (this.records.get(mangaId) ?? []).map((record) => ({ ...record }));
  }

  async bind(
    mangaId: number,
    binding: LogicalTrackerBinding,
  ): Promise<TrackerBindingRecord> {
    this.calls.push(`bind:${mangaId}:${binding.trackerId}:${binding.remoteId}`);
    if (this.failBindForTracker === binding.trackerId) {
      throw new Error("bind failed");
    }
    const records = this.records.get(mangaId) ?? [];
    const record = {
      recordId: this.nextRecordId++,
      ...binding,
    };
    this.records.set(mangaId, [...records, record]);
    return { ...record };
  }

  async unbind(recordId: number): Promise<void> {
    this.calls.push(`unbind:${recordId}`);
    if (this.failUnbindForRecord === recordId) {
      throw new Error("unbind failed");
    }
    for (const [mangaId, records] of this.records) {
      if (records.some((record) => record.recordId === recordId)) {
        this.records.set(
          mangaId,
          records.filter((record) => record.recordId !== recordId),
        );
        return;
      }
    }
  }

  bindings(mangaId: number): LogicalTrackerBinding[] {
    return (this.records.get(mangaId) ?? [])
      .map(({ trackerId, remoteId }) => ({ trackerId, remoteId }))
      .sort((left, right) => (
        left.trackerId - right.trackerId
        || left.remoteId.localeCompare(right.remoteId)
      ));
  }

  recordId(mangaId: number, trackerId: number): number {
    const record = (this.records.get(mangaId) ?? []).find(
      (candidate) => candidate.trackerId === trackerId,
    );
    if (!record) throw new Error("record not found");
    return record.recordId;
  }
}

const tracker = (
  trackerId: number,
  remoteId: string,
): LogicalTrackerBinding => ({ trackerId, remoteId });

describe("manga tracker binding migration", () => {
  it("uses only the official list, bind and unbind GraphQL operations", async () => {
    const gql = vi.fn()
      .mockResolvedValueOnce({
        manga: {
          trackRecords: {
            nodes: [{ id: 7, trackerId: 1, remoteId: "remote-a" }],
          },
        },
      })
      .mockResolvedValueOnce({
        bindTrack: {
          trackRecord: { id: 8, trackerId: 2, remoteId: "remote-b" },
        },
      })
      .mockResolvedValueOnce({ unbindTrack: { trackRecord: { id: 8 } } });
    const port = createGraphqlMangaTrackerBindingPort(gql);

    await expect(port.list(10)).resolves.toEqual([
      { recordId: 7, trackerId: 1, remoteId: "remote-a" },
    ]);
    await port.bind(20, tracker(2, "remote-b"));
    await port.unbind(8);

    expect(gql).toHaveBeenNthCalledWith(1, GET_MANGA_TRACK_RECORDS, {
      mangaId: 10,
    });
    expect(gql).toHaveBeenNthCalledWith(2, BIND_TRACK, {
      mangaId: 20,
      trackerId: 2,
      remoteId: "remote-b",
    });
    expect(gql).toHaveBeenNthCalledWith(3, UNBIND_TRACK, { recordId: 8 });
  });

  it("treats an existing identical target binding as a noop", async () => {
    const port = new MemoryTrackerBindingPort({
      10: [tracker(1, "same")],
      20: [tracker(1, "same")],
    });
    const plan = await prepareMangaTrackerBindingPlan(port, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "copy",
    });

    expect(plan.targetBindingsToCreate).toEqual([]);
    await applyMangaTrackerBindingPlan(port, plan);

    expect(port.calls.some((call) => call.startsWith("bind:"))).toBe(false);
    expect(port.calls.some((call) => call.startsWith("unbind:"))).toBe(false);
    await expect(
      verifyMangaTrackerBindingPlan(port, plan),
    ).resolves.toBeUndefined();
  });

  it("rejects duplicate tracker ids and target conflicts before mutations", async () => {
    const duplicatePort = new MemoryTrackerBindingPort({
      10: [tracker(1, "a"), tracker(1, "a")],
      20: [],
    });
    await expect(prepareMangaTrackerBindingPlan(duplicatePort, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "migrate",
    })).rejects.toMatchObject({ code: "DUPLICATE_TRACKER_ID" });
    expect(duplicatePort.calls.some((call) => call.startsWith("bind:"))).toBe(false);

    const conflictPort = new MemoryTrackerBindingPort({
      10: [tracker(1, "source-identity")],
      20: [tracker(1, "target-identity")],
    });
    await expect(prepareMangaTrackerBindingPlan(conflictPort, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "migrate",
    })).rejects.toMatchObject({ code: "TARGET_TRACKER_CONFLICT" });
    expect(conflictPort.calls.some((call) => call.startsWith("bind:"))).toBe(false);
    expect(conflictPort.calls.some((call) => call.startsWith("unbind:"))).toBe(false);
  });

  it("binds and verifies the target before unbinding the source", async () => {
    const port = new MemoryTrackerBindingPort({
      10: [tracker(1, "alpha"), tracker(2, "beta")],
      20: [],
    });
    const plan = await prepareMangaTrackerBindingPlan(port, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "migrate",
    });
    port.calls.length = 0;

    await applyMangaTrackerBindingPlan(port, plan);

    const firstUnbind = port.calls.findIndex((call) => call.startsWith("unbind:"));
    const lastBind = port.calls.findLastIndex((call) => call.startsWith("bind:20:"));
    const targetVerification = port.calls.findIndex(
      (call, index) => index > lastBind && call === "list:20",
    );
    expect(lastBind).toBeGreaterThanOrEqual(0);
    expect(targetVerification).toBeGreaterThan(lastBind);
    expect(firstUnbind).toBeGreaterThan(targetVerification);
    expect(port.bindings(10)).toEqual([]);
    expect(port.bindings(20)).toEqual([
      tracker(1, "alpha"),
      tracker(2, "beta"),
    ]);
  });

  it("never removes source bindings in copy mode", async () => {
    const port = new MemoryTrackerBindingPort({
      10: [tracker(1, "alpha")],
      20: [],
    });
    const plan = await prepareMangaTrackerBindingPlan(port, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "copy",
    });

    await applyMangaTrackerBindingPlan(port, plan);

    expect(port.bindings(10)).toEqual([tracker(1, "alpha")]);
    expect(port.bindings(20)).toEqual([tracker(1, "alpha")]);
    expect(port.calls.some((call) => call.startsWith("unbind:"))).toBe(false);
  });

  it("leaves the source intact when a target bind fails", async () => {
    const port = new MemoryTrackerBindingPort({
      10: [tracker(1, "alpha"), tracker(2, "beta")],
      20: [],
    });
    const plan = await prepareMangaTrackerBindingPlan(port, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "migrate",
    });
    port.failBindForTracker = 2;

    await expect(
      applyMangaTrackerBindingPlan(port, plan),
    ).rejects.toMatchObject({
      code: "APPLY_FAILED",
    });
    expect(port.bindings(10)).toEqual([
      tracker(1, "alpha"),
      tracker(2, "beta"),
    ]);
    expect(port.calls.some((call) => call.startsWith("unbind:"))).toBe(false);

    port.failBindForTracker = null;
    await compensateMangaTrackerBindingPlan(port, plan);
    expect(port.bindings(10)).toEqual([
      tracker(1, "alpha"),
      tracker(2, "beta"),
    ]);
    expect(port.bindings(20)).toEqual([]);
  });

  it("compensates a partial migrate without UPDATE_TRACK semantics", async () => {
    const port = new MemoryTrackerBindingPort({
      10: [tracker(1, "alpha"), tracker(2, "beta")],
      20: [tracker(3, "existing")],
    });
    const plan = await prepareMangaTrackerBindingPlan(port, {
      sourceMangaId: 10,
      targetMangaId: 20,
      mode: "migrate",
    });
    const secondSourceRecord = port.recordId(10, 2);
    port.failUnbindForRecord = secondSourceRecord;

    await expect(
      applyMangaTrackerBindingPlan(port, plan),
    ).rejects.toMatchObject({
      code: "APPLY_FAILED",
    });
    expect(port.bindings(10)).toEqual([tracker(2, "beta")]);
    expect(port.bindings(20)).toEqual([
      tracker(1, "alpha"),
      tracker(2, "beta"),
      tracker(3, "existing"),
    ]);

    port.failUnbindForRecord = null;
    await compensateMangaTrackerBindingPlan(port, plan);

    expect(port.bindings(10)).toEqual([
      tracker(1, "alpha"),
      tracker(2, "beta"),
    ]);
    expect(port.bindings(20)).toEqual([tracker(3, "existing")]);
    await expect(
      verifyMangaTrackerBindingPlan(port, plan, "compensated"),
    ).resolves.toBeUndefined();
  });
});
