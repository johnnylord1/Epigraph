import { afterEach, describe, expect, it, vi } from "vitest";
import { createNovelReaderPreparation, prepareNovelReaderForRestore, registerNovelReaderPreparation } from "./restorePreparation";

describe("Novel reader UI capability", () => {
  let unregister = () => {};
  afterEach(() => unregister());
  it("fails closed when the application capability is unavailable", async () => {
    expect(await prepareNovelReaderForRestore()).toMatchObject({ ok: false });
  });
  it("uses the currently bound reader, and performs a no-op without an active session", async () => {
    let active = true;
    const first = { prepareNovelReaderForRestore: vi.fn(async () => ({ ok: true as const })) };
    const second = { prepareNovelReaderForRestore: vi.fn(async () => { active = false; return { ok: true as const }; }) };
    let reader: typeof first | null = first;
    unregister = registerNovelReaderPreparation(createNovelReaderPreparation(() => reader, () => active));
    reader = second;
    expect(await prepareNovelReaderForRestore()).toEqual({ ok: true });
    expect(first.prepareNovelReaderForRestore).not.toHaveBeenCalled();
    expect(second.prepareNovelReaderForRestore).toHaveBeenCalledOnce();
    reader = null; active = false;
    expect(await prepareNovelReaderForRestore()).toEqual({ ok: true });
    active = true;
    expect(await prepareNovelReaderForRestore()).toMatchObject({ ok: false });
  });
  it("coalesces requests and cannot turn an unmounted pending reader into no-op success", async () => {
    let finish!: (result: { ok: false; code: "RESTORE_REFUSED_READER_NOT_FLUSHED"; reason: string }) => void;
    const persist = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
    let reader: { prepareNovelReaderForRestore: typeof persist } | null = { prepareNovelReaderForRestore: persist };
    unregister = registerNovelReaderPreparation(createNovelReaderPreparation(() => reader, () => reader !== null));
    const first = prepareNovelReaderForRestore();
    reader = null;
    const second = prepareNovelReaderForRestore();
    finish({ ok: false, code: "RESTORE_REFUSED_READER_NOT_FLUSHED", reason: "save_failed" });
    expect(await first).toMatchObject({ ok: false });
    expect(await second).toMatchObject({ ok: false });
    expect(persist).toHaveBeenCalledOnce();
    expect(await prepareNovelReaderForRestore()).toMatchObject({ ok: false });
  });
});
