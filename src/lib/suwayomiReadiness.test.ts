import { afterEach, describe, expect, test, vi } from "vitest";

const { gqlMock } = vi.hoisted(() => ({
  gqlMock: vi.fn(),
}));

vi.mock("./client", () => ({
  gql: gqlMock,
}));

import { isTransientSuwayomiError, waitForSuwayomiGraphqlReady } from "./suwayomiReadiness";

describe("suwayomiReadiness", () => {
  afterEach(() => {
    gqlMock.mockReset();
    vi.useRealTimers();
  });

  test("accepts a ready GraphQL response", async () => {
    gqlMock.mockResolvedValueOnce({ __typename: "Query" });

    await expect(waitForSuwayomiGraphqlReady("graphql", { attempts: 1 })).resolves.toBe(true);
    expect(gqlMock).toHaveBeenCalledWith(
      expect.stringContaining("EpigraphGraphqlReady"),
      undefined,
      undefined,
      4000,
    );
  });

  test("validates extension and source payload shapes", async () => {
    gqlMock
      .mockResolvedValueOnce({ extensions: { nodes: [{ pkgName: "ext.mangadex", isInstalled: true }] } })
      .mockResolvedValueOnce({ sources: { nodes: [{ id: "src", displayName: "Source" }] } });

    await expect(waitForSuwayomiGraphqlReady("extensions", { attempts: 1 })).resolves.toBe(true);
    await expect(waitForSuwayomiGraphqlReady("sources", { attempts: 1 })).resolves.toBe(true);
  });

  test("retries transient boot errors", async () => {
    gqlMock
      .mockRejectedValueOnce(new Error("Suwayomi returned an empty GraphQL error."))
      .mockResolvedValueOnce({ __typename: "Query" });

    await expect(waitForSuwayomiGraphqlReady("graphql", {
      attempts: 2,
      delayMs: 100,
      timeoutMs: 500,
    })).resolves.toBe(true);
    expect(gqlMock).toHaveBeenCalledTimes(2);
  });

  test("returns false for HTTP/readiness failures", async () => {
    gqlMock.mockRejectedValueOnce(new Error("Suwayomi HTTP 500"));

    await expect(waitForSuwayomiGraphqlReady("graphql", {
      attempts: 1,
      timeoutMs: 500,
    })).resolves.toBe(false);
  });

  test("classifies boot and database lock errors as transient", () => {
    expect(isTransientSuwayomiError(new Error("Database may be already in use"))).toBe(true);
    expect(isTransientSuwayomiError(new Error("The file is locked: database.mv.db"))).toBe(true);
    expect(isTransientSuwayomiError(new Error("Validation failed"))).toBe(false);
  });
});
