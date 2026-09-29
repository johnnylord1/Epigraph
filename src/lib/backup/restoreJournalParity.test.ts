import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/restoreJournalParity.json";
import { createRestoreJournal } from "./restoreJournal";
import { canonicalRestoreJson, restoreDigest } from "./restoreOperation";

describe("cross-language durable journal bytes", () => {
  it("uses the shared canonical payload and SHA-256 fixture", async () => {
    const payload = JSON.parse(fixtures.cases[0].raw).payload;
    expect(canonicalRestoreJson(payload)).toBe(fixtures.canonicalPayload);
    expect(await restoreDigest(fixtures.canonicalPayload)).toBe(fixtures.payloadSha256);
  });
  it.each(fixtures.cases)("$name", async ({ raw, valid }) => {
    const journal = createRestoreJournal({ read: async () => raw, compareAndSwap: async () => { throw new Error("read must not write"); } });
    const read = journal.read("d62e6076-d6e4-4771-b6fa-bfc55b0a91f1");
    if (valid) expect(await read).toEqual(JSON.parse(raw).payload);
    else await expect(read).rejects.toThrow();
  });
});
