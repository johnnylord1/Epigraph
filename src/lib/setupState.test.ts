import { describe, expect, it } from "vitest";
import { getSetupStatePresentation, isSuwayomiSchemaInitializingError, type SetupState } from "./setupState";

describe("setup state", () => {
  it("classifies missing Suwayomi schema tables as profile initialization", () => {
    const error = new Error(
      'Exception while fetching data (/sources) : org.h2.jdbc.JdbcSQLSyntaxErrorException: Table "SOURCE" not found',
    );

    expect(isSuwayomiSchemaInitializingError(error)).toBe(true);
  });

  it("does not classify generic network failures as schema initialization", () => {
    expect(isSuwayomiSchemaInitializingError(new Error("Failed to fetch"))).toBe(false);
    expect(isSuwayomiSchemaInitializingError(new Error("unreachable"))).toBe(false);
  });

  it("presents schema initialization separately from server offline", () => {
    const state: SetupState = {
      kind: "server_initializing",
      extensionRepoCount: null,
      installedExtensionCount: null,
      installedContentExtensionCount: null,
      installedHelperExtensionCount: null,
      totalSourceCount: null,
      usableSourceCount: null,
      hiddenSourceCount: null,
      errorMessage: null,
    };

    const presentation = getSetupStatePresentation(state, "search");

    expect(presentation.title).toContain("preparing");
    expect(presentation.body).toContain("database");
    expect(presentation.actions).toEqual([{ kind: "retry_connection", label: "Retry" }]);
  });
});
