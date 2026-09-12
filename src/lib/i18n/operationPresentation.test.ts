import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { applyAppLanguage, translate } from "./runtime";
import { operationError, operationFailure, presentOperationFailure, restoreNote, restorePayloadSummary } from "./operationPresentation";

afterEach(() => applyAppLanguage("en"));
describe("localized operation presentation", () => {
  it("has every dynamic presentation key in every existing catalog", () => {
    const code = readFileSync("src/lib/i18n/operationPresentation.ts", "utf8");
    const keys = [...code.matchAll(/"((?:outcomes|restoreDeps|firstRun)\.[\w.]+)"/g)].map(match => match[1]);
    for (const locale of ["en", "pt-BR", "es", "ja", "zh-CN"]) {
      applyAppLanguage(locale);
      for (const key of keys) expect(translate(key), `${locale}:${key}`).not.toBe(key);
    }
  });
  it.each([
    ["RESTORE_REFUSED_READER_NOT_FLUSHED", "outcomes.readerBusy"],
    ["RESTORE_DESTINATION_CORRUPT", "outcomes.corruptState"],
    ["RESTORE_BOOKS_DESTINATION_CORRUPT", "outcomes.corruptState"],
    ["JOURNAL_CORRUPT", "outcomes.corruptState"],
    ["RESTORE_EXTERNAL_UNRESOLVED", "outcomes.uncertain"],
    ["RESTORE_CANCELLED", "outcomes.cancelled"],
    ["RESTORE_HTTP_RESPONSE_UNCERTAIN", "outcomes.uncertain"],
  ])("preserves the actionable distinction for %s", (code, key) => {
    applyAppLanguage("pt-BR");
    expect(operationError(new Error(code))).toBe(translate(key));
  });
  it("retains causes while rendering UI error descriptors and counts in the current locale", () => {
    const cause = new Error("private native message");
    const failure = operationFailure(cause, "outcomes.repositoryChecks", { count: 2 });
    const english = presentOperationFailure(failure);
    applyAppLanguage("pt-BR");
    expect(presentOperationFailure(failure)).toBe(translate("outcomes.repositoryChecks", { count: 2 }));
    expect(presentOperationFailure(failure)).not.toBe(english);
    expect(failure.cause).toBe(cause);
    expect(presentOperationFailure(null)).toBe("");
  });
  it.each(["en", "pt-BR", "es", "ja", "zh-CN"])("localizes typed outcomes and safe unknown errors in %s", locale => {
    applyAppLanguage(locale);
    const target = operationError(new Error("RESTORE_TARGET_CHANGED"));
    expect(target).toBe(translate("outcomes.targetChanged"));
    expect(target).not.toContain("outcomes.");
    expect(operationError(new Error("raw backend password=fixture"))).toBe(translate("outcomes.failed"));
    expect(restoreNote({ code: "plugin-origin-conflict", message: "raw English" })).toBe(translate("restoreDeps.conflict"));
    expect(restoreNote("SUBMISSION_UNCERTAIN")).toBe(translate("outcomes.uncertain"));
    if (locale !== "en") {
      expect(target).not.toBe("The active profile changed. Reopen this operation in the intended profile.");
      expect(restorePayloadSummary({ kind: "manga", status: "blocked", reasons: [{ code: "missing-required-plugin" }], warnings: [] })).not.toMatch(/outcomes\.|Resolve|Missing/);
    }
  });
  it("uses known wrapped errors without exposing arbitrary native text", () => {
    expect(operationError(new Error("outer raw", { cause: new Error("RESTORE_TARGET_CHANGED") }))).toBe(translate("outcomes.targetChanged"));
    expect(operationError({ code: "NETWORK_FAILURE", message: "private URL" })).toBe(translate("outcomes.network"));
    expect(operationError({ message: "RESTORE_TARGET_CHANGED plus arbitrary text" })).toBe(translate("outcomes.failed"));
  });
  it("responds to locale changes without mutating the domain outcome", () => {
    const outcome = Object.freeze({ code: "BACKEND_STATUS_UNKNOWN", message: "server output" });
    applyAppLanguage("en"); const english = restoreNote(outcome);
    applyAppLanguage("pt-BR"); expect(restoreNote(outcome)).not.toBe(english);
    expect(outcome.message).toBe("server output");
  });
});
