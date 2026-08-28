import { describe, expect, it } from "vitest";
import { detectBackupImportKind } from "./backupRollout";

describe("backup import compatibility", () => {
  it("recognizes canonical and legacy unified backup suffixes", () => {
    expect(detectBackupImportKind("epigraph-unified-2026-08-28.epigraphbk")).toBe("epigraph");
    expect(detectBackupImportKind("aethon-unified-2026-08-28.aethonbk")).toBe("epigraph");
    expect(detectBackupImportKind("app.aethon.mobile_2026-08-28_12-00.aethonbk")).toBe("epigraph");
  });
});
