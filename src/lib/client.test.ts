import { afterEach, describe, expect, test, vi } from "vitest";

import { gql, gqlUpload, isGraphqlMutation } from "./client";
import {
  setSuwayomiUpdateInProgressForTests,
  SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
} from "./suwayomiUpdateLock.svelte";

describe("GraphQL client errors", () => {
  afterEach(() => {
    setSuwayomiUpdateInProgressForTests(false);
    vi.unstubAllGlobals();
  });

  test("normalizes empty GraphQL errors from JSON requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: null, errors: [{ message: "" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(gql("query EmptyError { noop }")).rejects.toThrow(
      "Suwayomi returned an empty GraphQL error.",
    );
  });

  test("normalizes empty GraphQL errors from upload requests", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ data: null, errors: [{ message: " " }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    )));

    await expect(gqlUpload(
      "mutation Upload($extensionFile: Upload!) { installExternalExtension(input: { extensionFile: $extensionFile }) { extension { pkgName } } }",
      { extensionFile: null },
      { "variables.extensionFile": new File(["apk"], "source.apk") },
    )).rejects.toThrow("Suwayomi returned an empty GraphQL error.");
  });

  test("allows GraphQL queries while Suwayomi update lock is active", async () => {
    setSuwayomiUpdateInProgressForTests(true);
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { ok: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    await expect(gql<{ ok: boolean }>("query ReadOnly { ok }")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("blocks GraphQL mutations while Suwayomi update lock is active", async () => {
    setSuwayomiUpdateInProgressForTests(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(gql("mutation MarkRead { noop }")).rejects.toThrow(
      SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("detects GraphQL mutations after ignored tokens", () => {
    expect(isGraphqlMutation("mutation { noop }")).toBe(true);
    expect(isGraphqlMutation("mutation UpdateLibrary { noop }")).toBe(true);
    expect(isGraphqlMutation("# comment\nmutation { noop }")).toBe(true);
    expect(isGraphqlMutation("\n\nmutation { noop }")).toBe(true);
    expect(isGraphqlMutation("query { noop }")).toBe(false);
  });

  test("allows mutation again after Suwayomi update lock is released", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: { ok: true } }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    vi.stubGlobal("fetch", fetchMock);

    setSuwayomiUpdateInProgressForTests(true);
    await expect(gql<{ ok: boolean }>("query ReadOnly { ok }")).resolves.toEqual({ ok: true });
    await expect(gql("mutation MarkRead { noop }")).rejects.toThrow(
      SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
    );

    setSuwayomiUpdateInProgressForTests(false);
    await expect(gql<{ ok: boolean }>("mutation MarkRead { noop }")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("blocks GraphQL upload mutations while Suwayomi update lock is active", async () => {
    setSuwayomiUpdateInProgressForTests(true);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(gqlUpload(
      "mutation Upload($extensionFile: Upload!) { installExternalExtension(input: { extensionFile: $extensionFile }) { extension { pkgName } } }",
      { extensionFile: null },
      { "variables.extensionFile": new File(["apk"], "source.apk") },
    )).rejects.toThrow(SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
