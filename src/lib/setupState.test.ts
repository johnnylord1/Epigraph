import { describe, expect, it } from "vitest";
import { getSetupStatePresentation, isSuwayomiSchemaInitializingError, type SetupState } from "./setupState";

describe("setup state", () => {
  it("offers only manual repository setup when no extension stores exist", () => {
    const state: SetupState = {
      kind: "no_extension_repos",
      extensionRepoCount: 0,
      installedExtensionCount: 0,
      installedContentExtensionCount: 0,
      installedHelperExtensionCount: 0,
      totalSourceCount: 0,
      usableSourceCount: 0,
      hiddenSourceCount: 0,
      errorMessage: null,
    };

    const presentation = getSetupStatePresentation(state, "extensions", (id) => id);

    expect(presentation.actions).toEqual([
      { kind: "open_repo_manager", label: "setup.addManually" },
    ]);
  });

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

    const messages: Record<string, string> = {
      "setup.initializingTitle": "Suwayomi is preparing this profile",
      "setup.initializingBody": "The local server is running, but its database is not ready yet.",
      "setup.retry": "Retry",
    };
    const presentation = getSetupStatePresentation(state, "search", (id) => messages[id] ?? id);

    expect(presentation.title).toContain("preparing");
    expect(presentation.body).toContain("database");
    expect(presentation.actions).toEqual([{ kind: "retry_connection", label: "Retry" }]);
  });
});
