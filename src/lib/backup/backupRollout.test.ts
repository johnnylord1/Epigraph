import { describe, expect, it } from "vitest";
import { BACKUP_EXPORT_MODES, detectBackupImportKind } from "./backupRollout";

describe("backup export contract", () => {
  it("contains exactly the five formats exposed by the product", () => {
    expect(BACKUP_EXPORT_MODES).toEqual(["unified", "manga", "books", "novels", "app"]);
  });
});

describe("backup import compatibility", () => {
  it("recognizes canonical and legacy unified backup suffixes", () => {
    expect(detectBackupImportKind("epigraph-unified-2026-08-28.epigraphbk")).toBe("epigraph");
    expect(detectBackupImportKind("aethon-unified-2026-08-28.aethonbk")).toBe("epigraph");
    expect(detectBackupImportKind("app.aethon.mobile_2026-08-28_12-00.aethonbk")).toBe("epigraph");
  });
});
