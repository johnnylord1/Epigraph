import { afterEach, describe, expect, test, vi } from "vitest";

import { store } from "../store/state.svelte";
import { getServerUrl, gql, gqlUpload, isGraphqlMutation, resolveGqlTimeoutMs } from "./client";
import {
  setSuwayomiUpdateInProgressForTests,
  SUWAYOMI_UPDATE_WRITE_BLOCKED_MESSAGE,
} from "./suwayomiUpdateLock.svelte";

describe("GraphQL request timeouts", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    store.runtimeServerUrl = null;
  });

  test("keeps the default without a caller signal and leaves signal-only calls unbounded", () => {
    const signal = new AbortController().signal;
    expect(resolveGqlTimeoutMs(undefined, undefined)).toBe(12000);
    expect(resolveGqlTimeoutMs(undefined, 8000)).toBe(8000);
    expect(resolveGqlTimeoutMs(signal, undefined)).toBeNull();
    expect(resolveGqlTimeoutMs(undefined, 0)).toBeNull();
  });

  test("honours an explicit timeout when the caller also owns cancellation", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    store.runtimeServerUrl = "http://127.0.0.1:51001";
    const caller = new AbortController();
    const settled = expect(gql("query Ready { __typename }", undefined, caller.signal, 4000)).rejects.toThrow("Aborted");
    await vi.advanceTimersByTimeAsync(4000);
    await settled;
    expect(caller.signal.aborted).toBe(false);
  });
});

describe("GraphQL client errors", () => {
  test.each(["json", "upload"])("does not retarget a pending %s mutation after a server switch", async (kind) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ data: { ok: true } }));
    });
    store.runtimeServerUrl = "http://127.0.0.1:51001";
    const pending = kind === "json"
      ? gql("mutation Add { ok }")
      : gqlUpload("mutation Install { ok }", {}, {});
    store.runtimeServerUrl = "http://127.0.0.1:51002";
    await expect(pending).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  test.each(["profile", "credentials"])("rejects a pending mutation when only its %s changes", async (change) => {
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify({ data: { ok: true } }));
    });
    store.runtimeResolvedLocalProfileId = "profile-a";
    store.settings.serverAuthEnabled = true;
    store.settings.serverAuthUser = "user";
    store.settings.serverAuthPass = "test-a";
    const pending = gql("mutation Add { ok }");
    if (change === "profile") store.runtimeResolvedLocalProfileId = "profile-b";
    else store.settings.serverAuthPass = "test-b";
    await expect(pending).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  afterEach(() => {
    setSuwayomiUpdateInProgressForTests(false);
    store.runtimeServerUrl = null;
    store.runtimeResolvedLocalProfileId = null;
    store.settings.serverAuthEnabled = false;
    store.settings.serverAuthUser = "";
    store.settings.serverAuthPass = "";
    store.runtimeResolvedLocalProfileMeta = null;
    vi.unstubAllGlobals();
  });

  test("prefers the resolved runtime profile server over stale settings", () => {
    store.settings.serverUrl = "http://127.0.0.1:4667";
    store.runtimeResolvedLocalProfileMeta = {
      id: "main",
      label: "MAIN",
      title: "Epigraph [MAIN :4567]",
      serverUrl: "http://127.0.0.1:4567",
      port: 4567,
      local: true,
      builtIn: true,
    };

    expect(getServerUrl()).toBe("http://127.0.0.1:4567");
  });

  test("uses the active local session title before stale saved settings", () => {
    store.settings.serverUrl = "http://127.0.0.1:4667";
    store.runtimeServerUrl = null;
    store.runtimeResolvedLocalProfileMeta = null;
    vi.stubGlobal("document", { title: "Epigraph [MAIN :4567]" });

    expect(getServerUrl()).toBe("http://127.0.0.1:4567");
  });

  test("ignores the reserved test profile URL when runtime is missing", () => {
    store.settings.serverUrl = "http://127.0.0.1:4667";
    store.runtimeServerUrl = null;
    store.runtimeResolvedLocalProfileMeta = null;
    vi.stubGlobal("document", { title: "Epigraph [TEST :4667]" });

    expect(getServerUrl()).toBe("http://127.0.0.1:4567");
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

  test("does not retry an ambiguous mutation transport failure", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("connection reset");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(gql("mutation MarkRead { noop }")).rejects.toThrow("connection reset");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
